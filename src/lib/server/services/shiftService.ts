import type { Prisma, ShiftStatus } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { AppError } from '$lib/shared/errors';
import { assertEvidenceNotUsed } from './loanService';
import type { z } from 'zod';
import type { closeShiftSchema, openShiftSchema } from '$lib/shared/schemas/handoverShift';

const SHIFT_DETAIL_INCLUDE = {
	user: {
		select: { id: true, name: true, email: true, role: true }
	},
	items: {
		include: {
			responsible: {
				select: { id: true, name: true, email: true, role: true }
			},
			loanItem: {
				include: {
					asset: {
						select: { id: true, code: true, name: true, status: true }
					},
					loan: {
						include: {
							borrower: {
								select: { id: true, name: true, email: true }
							}
						}
					}
				}
			}
		}
	}
} satisfies Prisma.ShiftInclude;

/**
 * Mengambil seluruh LoanItem aktif (returnedAt IS NULL) dari database untuk pengecekan tutup shift (Bagian 7.4 & BR-12).
 */
export async function getActiveOutstandingLoanItems() {
	const now = new Date();
	const items = await prisma.loanItem.findMany({
		where: {
			returnedAt: null,
			loan: {
				status: 'ACTIVE'
			}
		},
		orderBy: {
			loan: { expectedReturnAt: 'asc' }
		},
		include: {
			asset: {
				select: { id: true, code: true, name: true, status: true }
			},
			loan: {
				include: {
					borrower: {
						select: { id: true, name: true, email: true }
					},
					createdBy: {
						select: { id: true, name: true, email: true }
					}
				}
			}
		}
	});

	return items.map((li) => ({
		loanItemId: li.id,
		loanId: li.loanId,
		asset: li.asset,
		purpose: li.loan.purpose,
		expectedReturnAt: li.loan.expectedReturnAt,
		isOverdue: li.loan.expectedReturnAt < now,
		borrower: li.loan.borrower,
		// BR-12: responsibleUserId bawaan = peminjam pada Loan tersebut
		defaultResponsibleUserId: li.loan.borrowerId
	}));
}

export async function openShift(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof openShiftSchema> = {},
	ip?: string
) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;

	const existingOpen = await prisma.shift.findFirst({
		where: {
			userId: officerActor.id,
			status: 'OPEN'
		}
	});

	if (existingOpen) {
		throw new AppError(
			'DUPLICATE_OPERATION',
			'Anda masih memiliki shift yang sedang terbuka. Tutup shift aktif terlebih dahulu sebelum membuka shift baru.',
			{ shiftId: existingOpen.id }
		);
	}

	const created = await prisma.$transaction(async (tx) => {
		const shift = await tx.shift.create({
			data: {
				userId: officerActor.id,
				status: 'OPEN',
				note: input.note?.trim() || null
			},
			include: SHIFT_DETAIL_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: officerActor.id,
			action: 'SHIFT_OPENED',
			entityType: 'Shift',
			entityId: shift.id,
			after: {
				userId: shift.userId,
				status: shift.status,
				openedAt: shift.openedAt.toISOString(),
				note: shift.note
			},
			ip: ip ?? null
		});

		return shift;
	});

	return { shift: created };
}

export async function getCurrentShiftState(actor: PolicyUser | null | undefined) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;

	const [currentShift, outstandingItems, previousClosedShift] = await Promise.all([
		prisma.shift.findFirst({
			where: {
				userId: officerActor.id,
				status: 'OPEN'
			},
			orderBy: { openedAt: 'desc' },
			include: SHIFT_DETAIL_INCLUDE
		}),
		getActiveOutstandingLoanItems(),
		// Bagian 7.4 langkah 4: Catatan shift sebelumnya tampil bagi petugas shift berikutnya sebagai daftar serah terima antar shift
		prisma.shift.findFirst({
			where: {
				status: 'CLOSED'
			},
			orderBy: { closedAt: 'desc' },
			include: SHIFT_DETAIL_INCLUDE
		})
	]);

	return {
		currentShift,
		outstandingItems,
		previousClosedShift
	};
}

export async function closeShift(
	actor: PolicyUser | null | undefined,
	shiftId: string,
	input: z.infer<typeof closeShiftSchema>,
	ip?: string
) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;

	const existingShift = await prisma.shift.findUnique({
		where: { id: shiftId }
	});

	if (!existingShift) {
		throw new AppError('NOT_FOUND', 'Data shift tidak ditemukan.');
	}

	if (officerActor.role !== 'ADMIN' && existingShift.userId !== officerActor.id) {
		throw new AppError('FORBIDDEN', 'Anda hanya dapat menutup shift milik Anda sendiri.');
	}

	if (existingShift.status !== 'OPEN') {
		throw new AppError('INVALID_STATUS_TRANSITION', 'Shift ini sudah ditutup sebelumnya.');
	}

	// Bagian 7.4 langkah 1 & BR-12: Server menghitung LoanItem aktif yang masih keluar dari database
	const outstandingItems = await getActiveOutstandingLoanItems();

	const reasonMap = new Map<
		string,
		{ reason: string; responsibleUserId: string | null | undefined }
	>();
	for (const item of input.items ?? []) {
		reasonMap.set(item.loanItemId, {
			reason: item.reason.trim(),
			responsibleUserId: item.responsibleUserId
		});
	}

	// BR-12: Tiap barang yang belum kembali wajib diberi alasan
	const missingLoanItemCodes: string[] = [];
	for (const activeItem of outstandingItems) {
		const provided = reasonMap.get(activeItem.loanItemId);
		if (!provided || provided.reason.length < 3) {
			missingLoanItemCodes.push(activeItem.asset.code);
		}
	}

	if (missingLoanItemCodes.length > 0) {
		throw new AppError(
			'VALIDATION_ERROR',
			`Terdapat ${missingLoanItemCodes.length} barang yang masih keluar dan wajib diberi alasan sebelum menutup shift (${missingLoanItemCodes.join(', ')}) (BR-12).`,
			{ missingAssetCodes: missingLoanItemCodes }
		);
	}

	const now = new Date();

	const closed = await prisma.$transaction(async (tx) => {
		// Bila tutup shift melampirkan foto bukti (evidenceId), terapkan aturan Evidence yang sama
		if (input.evidenceId) {
			const ev = await tx.evidence.findUnique({ where: { id: input.evidenceId } });
			if (!ev) {
				throw new AppError('EVIDENCE_REQUIRED', 'Foto bukti tutup shift tidak ditemukan.');
			}
			if (ev.purpose !== 'HANDOVER') {
				throw new AppError(
					'VALIDATION_ERROR',
					`Foto bukti tutup shift wajib ber-purpose HANDOVER (diterima: ${ev.purpose}).`
				);
			}
			if (ev.userId !== officerActor.id) {
				throw new AppError(
					'FORBIDDEN',
					'Foto bukti tutup shift harus diunggah oleh petugas yang sedang menutup shift.'
				);
			}
			const blockOnMock = (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false';
			if (ev.isMockLocation && blockOnMock) {
				throw new AppError(
					'MOCK_LOCATION_BLOCKED',
					'Foto bukti tutup shift menggunakan lokasi palsu (mock location) dan diblokir (BR-07).'
				);
			}
			await assertEvidenceNotUsed(tx, [input.evidenceId]);
		}

		if (outstandingItems.length > 0) {
			await tx.shiftItem.createMany({
				data: outstandingItems.map((activeItem) => {
					const provided = reasonMap.get(activeItem.loanItemId)!;
					return {
						shiftId,
						loanItemId: activeItem.loanItemId,
						reason: provided.reason,
						// BR-12: responsibleUserId bawaan = peminjam pada Loan tersebut
						responsibleUserId: provided.responsibleUserId ?? activeItem.defaultResponsibleUserId
					};
				})
			});
		}

		const updatedShift = await tx.shift.update({
			where: { id: shiftId },
			data: {
				status: 'CLOSED',
				closedAt: now,
				...(input.note !== undefined ? { note: input.note?.trim() || existingShift.note } : {})
			},
			include: SHIFT_DETAIL_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: officerActor.id,
			action: 'SHIFT_CLOSED',
			entityType: 'Shift',
			entityId: updatedShift.id,
			before: { status: 'OPEN', closedAt: null },
			after: {
				status: 'CLOSED',
				closedAt: now.toISOString(),
				outstandingItemCount: outstandingItems.length,
				...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
				items: outstandingItems.map((a) => ({
					loanItemId: a.loanItemId,
					assetCode: a.asset.code,
					reason: reasonMap.get(a.loanItemId)?.reason,
					responsibleUserId:
						reasonMap.get(a.loanItemId)?.responsibleUserId ?? a.defaultResponsibleUserId
				}))
			},
			ip: ip ?? null
		});

		return updatedShift;
	});

	return { shift: closed };
}

export async function listShifts(
	actor: PolicyUser | null | undefined,
	params: {
		page?: number;
		pageSize?: number;
		status?: ShiftStatus;
		userId?: string;
	} = {}
) {
	assertCan(actor, 'shift:read_all');

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;

	const where: Prisma.ShiftWhereInput = {
		...(params.status ? { status: params.status } : {}),
		...(params.userId ? { userId: params.userId } : {})
	};

	const [total, items] = await Promise.all([
		prisma.shift.count({ where }),
		prisma.shift.findMany({
			where,
			orderBy: { openedAt: 'desc' },
			skip,
			take: pageSize,
			include: SHIFT_DETAIL_INCLUDE
		})
	]);

	return {
		items,
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}
