import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { createEvidenceSignedUrl } from '$lib/server/storage';
import { AppError } from '$lib/shared/errors';
import { assertEvidenceNotUsed } from './loanService';
import type { z } from 'zod';
import type {
	confirmHandoverSchema,
	createHandoverSchema
} from '$lib/shared/schemas/handoverShift';

const HANDOVER_CONFIRMATION_SLA_MS = 24 * 60 * 60 * 1000; // 24 jam (Bagian 21 No. 10)

const HANDOVER_INCLUDE = {
	giver: {
		select: { id: true, name: true, email: true, role: true }
	},
	receiver: {
		select: { id: true, name: true, email: true, role: true }
	},
	evidence: {
		include: { location: true }
	},
	loan: {
		include: {
			borrower: {
				select: { id: true, name: true, email: true, role: true }
			},
			items: {
				include: {
					asset: {
						select: { id: true, code: true, name: true, status: true }
					}
				}
			}
		}
	}
} satisfies Prisma.HandoverInclude;

function generateHandoverDocumentNo(): string {
	const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	const randPart = randomBytes(3).toString('hex').toUpperCase();
	return `BA-${datePart}-${randPart}`;
}

async function validateHandoverEvidence(
	tx: DbTx,
	actor: PolicyUser,
	evidenceId: string
): Promise<void> {
	const evidence = await tx.evidence.findUnique({
		where: { id: evidenceId }
	});

	if (!evidence) {
		throw new AppError('EVIDENCE_REQUIRED', 'Data foto bukti serah terima tidak ditemukan.');
	}

	// 1. Purpose wajib HANDOVER
	if (evidence.purpose !== 'HANDOVER') {
		throw new AppError(
			'VALIDATION_ERROR',
			`Foto bukti untuk serah terima wajib ber-purpose HANDOVER (diterima: ${evidence.purpose}).`,
			{ evidenceId: evidence.id, expectedPurpose: 'HANDOVER', actualPurpose: evidence.purpose }
		);
	}

	// 2. Foto bukti wajib diunggah oleh pelaku yang sedang menjalankan aksi
	if (evidence.userId !== actor.id) {
		throw new AppError(
			'FORBIDDEN',
			'Foto bukti serah terima harus diunggah oleh pengguna yang sedang melakukan aksi.',
			{ evidenceId: evidence.id }
		);
	}

	// 3. Cek MOCK_LOCATION (BR-07)
	const blockOnMock = (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false';
	if (evidence.isMockLocation && blockOnMock) {
		throw new AppError(
			'MOCK_LOCATION_BLOCKED',
			'Bukti serah terima menggunakan lokasi palsu (mock location) dan diblokir sesuai kebijakan keamanan (BR-07).',
			{ evidenceId: evidence.id }
		);
	}

	// 4. Satu Evidence hanya boleh dipakai sekali
	await assertEvidenceNotUsed(tx, [evidenceId]);
}

function formatHandoverRecord(h: Prisma.HandoverGetPayload<{ include: typeof HANDOVER_INCLUDE }>) {
	const isConfirmed = Boolean(h.giverConfirmedAt && h.receiverConfirmedAt);
	const ageMs = Date.now() - h.createdAt.getTime();
	return {
		...h,
		isConfirmed,
		isOverdueConfirmation: !isConfirmed && ageMs > HANDOVER_CONFIRMATION_SLA_MS,
		evidenceSignedUrl: h.evidence
			? createEvidenceSignedUrl(h.evidence.id, h.evidence.imageKey).url
			: null
	};
}

export async function createHandover(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createHandoverSchema>,
	ip?: string
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const loan = await prisma.loan.findUnique({
		where: { id: input.loanId },
		include: {
			items: { where: { returnedAt: null } }
		}
	});

	if (!loan) {
		throw new AppError('NOT_FOUND', 'Data peminjaman tidak ditemukan.');
	}

	if (loan.status !== 'ACTIVE') {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Serah terima hanya dapat dibuat untuk peminjaman berstatus ACTIVE (saat ini: ${loan.status}).`
		);
	}

	const giverId = input.giverId ?? actor.id;
	const receiverId = input.receiverId;

	// BR-20: Handover hanya dibuat bila ada dua pihak berbeda
	if (giverId === receiverId) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Serah terima hanya dapat dibuat bila ada dua pihak yang berbeda (pemberi dan penerima tidak boleh orang yang sama, BR-20).'
		);
	}

	assertCan(actor, 'handover:create', {
		giverId,
		receiverId,
		borrowerId: loan.borrowerId
	});

	const [giverUser, receiverUser] = await Promise.all([
		prisma.user.findUnique({ where: { id: giverId } }),
		prisma.user.findUnique({ where: { id: receiverId } })
	]);

	if (!giverUser || !giverUser.isActive) {
		throw new AppError('VALIDATION_ERROR', 'Pengguna pemberi tidak ditemukan atau tidak aktif.');
	}
	if (!receiverUser || !receiverUser.isActive) {
		throw new AppError('VALIDATION_ERROR', 'Pengguna penerima tidak ditemukan atau tidak aktif.');
	}

	const now = new Date();
	const giverConfirmedAt = input.autoConfirmGiver && actor.id === giverId ? now : null;

	const created = await prisma.$transaction(async (tx) => {
		if (input.evidenceId) {
			await validateHandoverEvidence(tx, actor, input.evidenceId);
		}

		const handover = await tx.handover.create({
			data: {
				loanId: loan.id,
				giverId,
				receiverId,
				giverConfirmedAt,
				receiverConfirmedAt: null,
				evidenceId: input.evidenceId ?? null,
				documentNo: null
			},
			include: HANDOVER_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'HANDOVER_CREATED',
			entityType: 'Handover',
			entityId: handover.id,
			after: {
				loanId: handover.loanId,
				giverId: handover.giverId,
				receiverId: handover.receiverId,
				giverConfirmedAt: handover.giverConfirmedAt?.toISOString() ?? null,
				evidenceId: handover.evidenceId
			},
			ip: ip ?? null
		});

		return handover;
	});

	return {
		handover: formatHandoverRecord(created)
	};
}

export async function confirmHandover(
	actor: PolicyUser | null | undefined,
	handoverId: string,
	input: z.infer<typeof confirmHandoverSchema> = {},
	ip?: string
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const existing = await prisma.handover.findUnique({
		where: { id: handoverId },
		include: { loan: true }
	});

	if (!existing) {
		throw new AppError('NOT_FOUND', 'Data serah terima tidak ditemukan.');
	}

	assertCan(actor, 'handover:confirm', {
		giverId: existing.giverId,
		receiverId: existing.receiverId,
		borrowerId: existing.loan.borrowerId
	});

	const isGiver = actor.id === existing.giverId;
	const isReceiver = actor.id === existing.receiverId;

	// Bagian 7.2 & 11.2: Konfirmasi serah terima wajib dilakukan oleh kedua pihak yang bersangkutan (giver atau receiver)
	if (!isGiver && !isReceiver) {
		throw new AppError(
			'FORBIDDEN',
			'Konfirmasi serah terima hanya dapat ditekan oleh pihak pemberi atau pihak penerima yang bersangkutan.'
		);
	}

	const now = new Date();
	const nextGiverConfirmedAt = isGiver
		? (existing.giverConfirmedAt ?? now)
		: existing.giverConfirmedAt;
	const nextReceiverConfirmedAt = isReceiver
		? (existing.receiverConfirmedAt ?? now)
		: existing.receiverConfirmedAt;

	const bothConfirmed = Boolean(nextGiverConfirmedAt && nextReceiverConfirmedAt);
	const nextDocumentNo =
		bothConfirmed && !existing.documentNo ? generateHandoverDocumentNo() : existing.documentNo;

	const updated = await prisma.$transaction(async (tx) => {
		if (input.evidenceId) {
			await validateHandoverEvidence(tx, actor, input.evidenceId);
		}

		const handover = await tx.handover.update({
			where: { id: handoverId },
			data: {
				giverConfirmedAt: nextGiverConfirmedAt,
				receiverConfirmedAt: nextReceiverConfirmedAt,
				...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
				...(nextDocumentNo ? { documentNo: nextDocumentNo } : {})
			},
			include: HANDOVER_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'HANDOVER_CONFIRMED',
			entityType: 'Handover',
			entityId: handover.id,
			before: {
				giverConfirmedAt: existing.giverConfirmedAt?.toISOString() ?? null,
				receiverConfirmedAt: existing.receiverConfirmedAt?.toISOString() ?? null,
				documentNo: existing.documentNo
			},
			after: {
				confirmedByRole: isGiver ? 'GIVER' : 'RECEIVER',
				giverConfirmedAt: handover.giverConfirmedAt?.toISOString() ?? null,
				receiverConfirmedAt: handover.receiverConfirmedAt?.toISOString() ?? null,
				documentNo: handover.documentNo
			},
			ip: ip ?? null
		});

		return handover;
	});

	return {
		handover: formatHandoverRecord(updated)
	};
}

export async function listHandovers(
	actor: PolicyUser | null | undefined,
	params: {
		loanId?: string;
		unconfirmedOnly?: boolean;
		page?: number;
		pageSize?: number;
	} = {}
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;

	const roleFilter: Prisma.HandoverWhereInput =
		actor.role === 'ADMIN' || actor.role === 'OFFICER'
			? {}
			: {
					OR: [{ giverId: actor.id }, { receiverId: actor.id }, { loan: { borrowerId: actor.id } }]
				};

	const where: Prisma.HandoverWhereInput = {
		...roleFilter,
		...(params.loanId ? { loanId: params.loanId } : {}),
		...(params.unconfirmedOnly
			? {
					OR: [{ giverConfirmedAt: null }, { receiverConfirmedAt: null }]
				}
			: {})
	};

	const [total, rows, participants] = await Promise.all([
		prisma.handover.count({ where }),
		prisma.handover.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			skip,
			take: pageSize,
			include: HANDOVER_INCLUDE
		}),
		prisma.user.findMany({
			where: { isActive: true },
			orderBy: { name: 'asc' },
			select: { id: true, name: true, email: true, role: true }
		})
	]);

	return {
		items: rows.map(formatHandoverRecord),
		participants,
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}
