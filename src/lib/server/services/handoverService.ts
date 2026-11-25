import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { runInTx, writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { createEvidenceSignedUrl } from '$lib/server/storage';
import { AppError } from '$lib/shared/errors';
import { validateAndAssertEvidenceUnused } from './evidenceService';
import type { z } from 'zod';
import type {
	confirmHandoverSchema,
	createHandoverSchema
} from '$lib/shared/schemas/handoverShift';

const HANDOVER_CONFIRMATION_SLA_MS = 24 * 60 * 60 * 1000; // 24 jam (Bagian 21 No. 10)
const SUPERSEDED_PREFIX = 'SUPERSEDED-';

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

function generateSupersededMarker(handoverId: string): string {
	const randPart = randomBytes(2).toString('hex').toUpperCase();
	return `${SUPERSEDED_PREFIX}${handoverId.slice(0, 8)}-${randPart}`;
}

async function validateHandoverEvidence(
	tx: DbTx,
	actor: PolicyUser,
	evidenceId: string
): Promise<void> {
	await validateAndAssertEvidenceUnused(tx, {
		actor,
		evidenceIds: [evidenceId],
		expectedPurpose: 'HANDOVER',
		actionLabel: 'serah terima'
	});
}

function formatHandoverRecord(h: Prisma.HandoverGetPayload<{ include: typeof HANDOVER_INCLUDE }>) {
	const isSuperseded = Boolean(h.documentNo?.startsWith(SUPERSEDED_PREFIX));
	const isConfirmed = !isSuperseded && Boolean(h.giverConfirmedAt && h.receiverConfirmedAt);
	const ageMs = Date.now() - h.createdAt.getTime();
	return {
		...h,
		isConfirmed,
		isSuperseded,
		isOverdueConfirmation: !isConfirmed && !isSuperseded && ageMs > HANDOVER_CONFIRMATION_SLA_MS,
		evidenceSignedUrl: h.evidence
			? createEvidenceSignedUrl(h.evidence.id, h.evidence.imageKey).url
			: null
	};
}

/**
 * Memeriksa apakah pasangan (giver, receiver) sah terhadap pemegang Loan saat ini:
 * - Pemberi adalah pemegang saat ini (giverId === currentHolderId), ATAU
 * - Kasus petugas/admin menyerahkan fisik barang ke peminjam yang memang sudah tercatat sebagai peminjam (receiverId === currentHolderId).
 */
function verifyGiverEligibility(params: {
	giverId: string;
	giverRole: string;
	receiverId: string;
	currentHolderId: string;
}): { valid: boolean; isOfficerInitialDelivery: boolean } {
	const isCurrentHolder = params.giverId === params.currentHolderId;
	const isOfficerInitialDelivery =
		(params.giverRole === 'OFFICER' || params.giverRole === 'ADMIN') &&
		params.receiverId === params.currentHolderId;

	return {
		valid: isCurrentHolder || isOfficerInitialDelivery,
		isOfficerInitialDelivery
	};
}

export async function createHandover(
	actor: PolicyUser | null | undefined,
	input: z.input<typeof createHandoverSchema>,
	ip?: string,
	outerTx?: DbTx
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const db = outerTx ?? prisma;

	const loan = await db.loan.findUnique({
		where: { id: input.loanId },
		include: {
			items: { where: { returnedAt: null } }
		}
	});

	if (!loan) {
		throw new AppError('NOT_FOUND', 'Data peminjaman tidak ditemukan.');
	}

	if (loan.status !== 'ACTIVE' || loan.items.length === 0) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Serah terima hanya dapat dibuat untuk peminjaman berstatus ACTIVE yang masih memiliki barang keluar (saat ini: ${loan.status}).`,
			{ loanId: loan.id, loanStatus: loan.status },
			409
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
		db.user.findUnique({ where: { id: giverId } }),
		db.user.findUnique({ where: { id: receiverId } })
	]);

	if (!giverUser || !giverUser.isActive) {
		throw new AppError('VALIDATION_ERROR', 'Pengguna pemberi tidak ditemukan atau tidak aktif.');
	}
	if (!receiverUser || !receiverUser.isActive) {
		throw new AppError('VALIDATION_ERROR', 'Pengguna penerima tidak ditemukan atau tidak aktif.');
	}

	const eligibility = verifyGiverEligibility({
		giverId,
		giverRole: giverUser.role,
		receiverId,
		currentHolderId: loan.borrowerId
	});

	if (!eligibility.valid) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			'Konflik serah terima: pihak pemberi bukan pemegang barang saat ini.',
			{
				giverId,
				currentHolderId: loan.borrowerId
			},
			409
		);
	}

	const now = new Date();
	const giverConfirmedAt = (input.autoConfirmGiver ?? true) && actor.id === giverId ? now : null;

	const created = await runInTx(outerTx, async (tx) => {
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
	ip?: string,
	outerTx?: DbTx
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const db = outerTx ?? prisma;

	const existing = await db.handover.findUnique({
		where: { id: handoverId },
		include: {
			giver: { select: { id: true, role: true } },
			loan: {
				include: {
					items: { where: { returnedAt: null } }
				}
			}
		}
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

	// Tolak bila serah terima ini sudah dibatalkan/kedaluwarsa karena pemegang telah berpindah pada serah terima lain
	if (existing.documentNo?.startsWith(SUPERSEDED_PREFIX)) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			'Konflik serah terima: serah terima ini sudah kedaluwarsa karena barang telah diserahterimakan ke pihak lain.',
			{
				handoverId: existing.id,
				currentHolderId: existing.loan.borrowerId
			},
			409
		);
	}

	// 1. Loan wajib masih ACTIVE dan masih memiliki barang yang belum dikembalikan saat konfirmasi
	if (existing.loan.status !== 'ACTIVE' || existing.loan.items.length === 0) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Serah terima tidak dapat dikonfirmasi karena peminjaman sudah tidak aktif atau barang telah dikembalikan (status: ${existing.loan.status}).`,
			{
				loanId: existing.loanId,
				loanStatus: existing.loan.status
			},
			409
		);
	}

	const alreadyConfirmedOutsideTx =
		((isGiver && existing.giverConfirmedAt !== null) ||
			(isReceiver && existing.receiverConfirmedAt !== null)) &&
		(!input.evidenceId || input.evidenceId === existing.evidenceId);

	const preCheckEligibility = verifyGiverEligibility({
		giverId: existing.giverId,
		giverRole: existing.giver.role,
		receiverId: existing.receiverId,
		currentHolderId: existing.loan.borrowerId
	});

	if (!alreadyConfirmedOutsideTx && !preCheckEligibility.valid) {
		// Batalkan serah terima menggantung yang tidak lagi valid untuk loan ini sebelum menolak konfirmasi sebagai konflik
		if (!outerTx) {
			await prisma.$transaction(async (tx) => {
				const staleHandovers = await tx.handover.findMany({
					where: {
						loanId: existing.loanId,
						documentNo: null,
						OR: [{ giverConfirmedAt: null }, { receiverConfirmedAt: null }]
					}
				});
				for (const stale of staleHandovers) {
					if (stale.giverId !== existing.loan.borrowerId) {
						const marker = generateSupersededMarker(stale.id);
						await tx.handover.update({
							where: { id: stale.id },
							data: { documentNo: marker }
						});
						await writeAuditLog(tx, {
							actorId: actor.id,
							action: 'HANDOVER_SUPERSEDED',
							entityType: 'Handover',
							entityId: stale.id,
							before: { documentNo: null },
							after: {
								documentNo: marker,
								reason: 'GIVER_NOT_CURRENT_HOLDER',
								currentHolderId: existing.loan.borrowerId
							},
							ip: ip ?? null
						});
					}
				}
			});
		}

		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			'Konflik serah terima: pihak pemberi bukan lagi pemegang barang saat ini.',
			{
				handoverId: existing.id,
				giverId: existing.giverId,
				currentHolderId: existing.loan.borrowerId
			},
			409
		);
	}

	const updated = await runInTx(outerTx, async (tx) => {
		// Kunci eksklusif per handoverId agar konfirmasi paralel dari pemberi & penerima (atau klik ganda) dieksekusi berurutan (#5)
		const lockKey = `handover:${handoverId}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

		// Baca ulang Handover dan Loan di dalam transaksi setelah kunci diperoleh untuk mencegah TOCTOU
		const freshHandover = await tx.handover.findUniqueOrThrow({
			where: { id: handoverId },
			include: HANDOVER_INCLUDE
		});

		if (freshHandover.documentNo?.startsWith(SUPERSEDED_PREFIX)) {
			throw new AppError(
				'INVALID_STATUS_TRANSITION',
				'Konflik serah terima: serah terima ini sudah kedaluwarsa karena barang telah diserahterimakan ke pihak lain.',
				{
					handoverId: freshHandover.id,
					currentHolderId: freshHandover.loan.borrower.id
				},
				409
			);
		}

		const freshLoan = await tx.loan.findUniqueOrThrow({
			where: { id: freshHandover.loanId },
			include: {
				items: { where: { returnedAt: null } }
			}
		});

		if (freshLoan.status !== 'ACTIVE' || freshLoan.items.length === 0) {
			throw new AppError(
				'INVALID_STATUS_TRANSITION',
				'Serah terima tidak dapat dikonfirmasi karena barang sudah dikembalikan.',
				{ loanId: freshHandover.loanId, loanStatus: freshLoan.status },
				409
			);
		}

		// Bila pihak ini sudah pernah mengonfirmasi dan tidak mengirim evidenceId baru, kembalikan secara idempoten
		const alreadyConfirmedByActor =
			(isGiver && freshHandover.giverConfirmedAt !== null) ||
			(isReceiver && freshHandover.receiverConfirmedAt !== null);
		const hasNewEvidence = Boolean(
			input.evidenceId && input.evidenceId !== freshHandover.evidenceId
		);
		if (alreadyConfirmedByActor && !hasNewEvidence) {
			return freshHandover;
		}

		// 2. Pastikan pemberi adalah pemegang saat ini, kecuali kasus petugas menyerahkan ke peminjam yang memang sudah tercatat sebagai peminjam
		const eligibility = verifyGiverEligibility({
			giverId: freshHandover.giverId,
			giverRole: freshHandover.giver.role,
			receiverId: freshHandover.receiverId,
			currentHolderId: freshLoan.borrowerId
		});

		if (!eligibility.valid) {
			throw new AppError(
				'INVALID_STATUS_TRANSITION',
				'Konflik serah terima: pihak pemberi bukan lagi pemegang barang saat ini.',
				{
					handoverId: freshHandover.id,
					giverId: freshHandover.giverId,
					currentHolderId: freshLoan.borrowerId
				},
				409
			);
		}

		if (hasNewEvidence && input.evidenceId) {
			await validateHandoverEvidence(tx, actor, input.evidenceId);
		}

		const now = new Date();
		const nextGiverConfirmedAt = isGiver
			? (freshHandover.giverConfirmedAt ?? now)
			: freshHandover.giverConfirmedAt;
		const nextReceiverConfirmedAt = isReceiver
			? (freshHandover.receiverConfirmedAt ?? now)
			: freshHandover.receiverConfirmedAt;

		const bothConfirmed = Boolean(nextGiverConfirmedAt && nextReceiverConfirmedAt);
		const nextDocumentNo =
			bothConfirmed && !freshHandover.documentNo
				? generateHandoverDocumentNo()
				: freshHandover.documentNo;

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

		// Pilihan (a): Setelah serah terima dikonfirmasi kedua pihak, pemegang barang berpindah ke penerima
		// (Tidak berpindah bila kasus petugas menyerahkan ke peminjam yang memang sudah tercatat sebagai borrowerId)
		const previousBorrowerId = freshLoan.borrowerId;
		const holderTransferred =
			bothConfirmed &&
			!eligibility.isOfficerInitialDelivery &&
			previousBorrowerId !== freshHandover.receiverId;

		const supersededHandoverIds: string[] = [];

		if (holderTransferred) {
			await tx.loan.update({
				where: { id: freshHandover.loanId },
				data: {
					borrowerId: freshHandover.receiverId
				}
			});

			await writeAuditLog(tx, {
				actorId: actor.id,
				action: 'LOAN_HOLDER_TRANSFERRED',
				entityType: 'Loan',
				entityId: freshHandover.loanId,
				before: { borrowerId: previousBorrowerId },
				after: {
					borrowerId: freshHandover.receiverId,
					handoverId: handover.id,
					documentNo: handover.documentNo
				},
				ip: ip ?? null
			});

			// 3. Batalkan/tandai kedaluwarsa serah terima lain yang masih menunggu untuk peminjaman yang sama
			const otherPendingHandovers = await tx.handover.findMany({
				where: {
					loanId: freshHandover.loanId,
					id: { not: handoverId },
					documentNo: null,
					OR: [{ giverConfirmedAt: null }, { receiverConfirmedAt: null }]
				}
			});

			for (const stale of otherPendingHandovers) {
				const marker = generateSupersededMarker(stale.id);
				await tx.handover.update({
					where: { id: stale.id },
					data: { documentNo: marker }
				});
				supersededHandoverIds.push(stale.id);

				await writeAuditLog(tx, {
					actorId: actor.id,
					action: 'HANDOVER_SUPERSEDED',
					entityType: 'Handover',
					entityId: stale.id,
					before: { documentNo: null },
					after: {
						documentNo: marker,
						supersededByHandoverId: handover.id,
						newHolderId: freshHandover.receiverId
					},
					ip: ip ?? null
				});
			}
		}

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'HANDOVER_CONFIRMED',
			entityType: 'Handover',
			entityId: handover.id,
			before: {
				giverConfirmedAt: freshHandover.giverConfirmedAt?.toISOString() ?? null,
				receiverConfirmedAt: freshHandover.receiverConfirmedAt?.toISOString() ?? null,
				documentNo: freshHandover.documentNo
			},
			after: {
				confirmedByRole: isGiver ? 'GIVER' : 'RECEIVER',
				giverConfirmedAt: handover.giverConfirmedAt?.toISOString() ?? null,
				receiverConfirmedAt: handover.receiverConfirmedAt?.toISOString() ?? null,
				documentNo: handover.documentNo,
				holderTransferred,
				newHolderId: holderTransferred ? freshHandover.receiverId : previousBorrowerId,
				...(supersededHandoverIds.length > 0 ? { supersededHandoverIds } : {})
			},
			ip: ip ?? null
		});

		if (holderTransferred) {
			return tx.handover.findUniqueOrThrow({
				where: { id: handoverId },
				include: HANDOVER_INCLUDE
			});
		}

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
					documentNo: null,
					loan: { status: 'ACTIVE' },
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
