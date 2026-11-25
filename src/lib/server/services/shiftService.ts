import type { Prisma, ShiftStatus } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { runInTx, writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, can, type PolicyUser } from '$lib/server/policy';
import { AppError } from '$lib/shared/errors';
import { validateAndAssertEvidenceUnused } from './evidenceService';
import type { z } from 'zod';
import type { closeShiftSchema, openShiftSchema } from '$lib/shared/schemas/handoverShift';

export interface ForceClosedByAdminInfo {
	adminId: string;
	adminName: string;
	adminEmail: string;
	emergencyCloseReason: string;
	closedAt: string;
}

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

type ShiftWithDetail = Prisma.ShiftGetPayload<{ include: typeof SHIFT_DETAIL_INCLUDE }>;

export type ShiftWithForceCloseInfo = ShiftWithDetail & {
	forceClosedByAdmin: ForceClosedByAdminInfo | null;
};

function parseForceCloseAuditAfter(
	afterJson: Prisma.JsonValue | null
): ForceClosedByAdminInfo | null {
	if (!afterJson || typeof afterJson !== 'object' || Array.isArray(afterJson)) {
		return null;
	}
	const obj = afterJson as Record<string, unknown>;
	const adminObj =
		obj.closedByAdmin && typeof obj.closedByAdmin === 'object'
			? (obj.closedByAdmin as Record<string, unknown>)
			: null;
	const reason = typeof obj.emergencyCloseReason === 'string' ? obj.emergencyCloseReason : '';
	if (!adminObj || !reason) return null;

	return {
		adminId: typeof adminObj.id === 'string' ? adminObj.id : '',
		adminName: typeof adminObj.name === 'string' ? adminObj.name : 'Administrator',
		adminEmail: typeof adminObj.email === 'string' ? adminObj.email : '',
		emergencyCloseReason: reason,
		closedAt: typeof obj.closedAt === 'string' ? obj.closedAt : new Date().toISOString()
	};
}

async function attachForceCloseInfoToShifts(
	db: DbTx,
	shifts: ShiftWithDetail[]
): Promise<ShiftWithForceCloseInfo[]> {
	if (shifts.length === 0) return [];
	const shiftIds = shifts.map((s) => s.id);
	const forceLogs = await db.auditLog.findMany({
		where: {
			entityType: 'Shift',
			action: 'SHIFT_FORCE_CLOSED_BY_ADMIN',
			entityId: { in: shiftIds }
		},
		orderBy: { createdAt: 'desc' }
	});

	const forceMap = new Map<string, ForceClosedByAdminInfo>();
	for (const log of forceLogs) {
		if (!forceMap.has(log.entityId)) {
			const parsed = parseForceCloseAuditAfter(log.after);
			if (parsed) {
				forceMap.set(log.entityId, parsed);
			}
		}
	}

	return shifts.map((s) => ({
		...s,
		forceClosedByAdmin: forceMap.get(s.id) ?? null
	}));
}

/**
 * Mengambil seluruh LoanItem aktif (returnedAt IS NULL) dari database untuk pengecekan tutup shift (Bagian 7.4 & BR-12).
 */
export async function getActiveOutstandingLoanItems(db: DbTx = prisma) {
	const now = new Date();
	const items = await db.loanItem.findMany({
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
		assetId: li.assetId,
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
	ip?: string,
	outerTx?: DbTx
) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;

	const created = await runInTx(outerTx, async (tx) => {
		const lockKey = `shift_open:${officerActor.id}`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

		const existingOpen = await tx.shift.findFirst({
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

	return {
		shift: {
			...created,
			forceClosedByAdmin: null
		}
	};
}

async function throwAlreadyClosedShiftError(db: DbTx, shiftId: string): Promise<never> {
	const forceLog = await db.auditLog.findFirst({
		where: {
			entityType: 'Shift',
			entityId: shiftId,
			action: 'SHIFT_FORCE_CLOSED_BY_ADMIN'
		},
		orderBy: { createdAt: 'desc' }
	});
	const forceInfo = forceLog ? parseForceCloseAuditAfter(forceLog.after) : null;
	if (forceInfo) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Shift ini telah ditutup secara darurat oleh Admin (${forceInfo.adminName}) dengan alasan: "${forceInfo.emergencyCloseReason}". Anda dapat menghapus operasi tutup shift ini dari antrean HP.`,
			{
				shiftId,
				forceClosedByAdmin: forceInfo
			},
			409
		);
	}

	throw new AppError(
		'INVALID_STATUS_TRANSITION',
		'Shift ini sudah ditutup sebelumnya. Anda dapat menghapus catatan ini dari antrean.',
		{ shiftId },
		409
	);
}

export async function getCurrentShiftState(actor: PolicyUser | null | undefined) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;

	const [currentShift, outstandingItems, rawPreviousClosedShift] = await Promise.all([
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

	const [enrichedPrevious] = rawPreviousClosedShift
		? await attachForceCloseInfoToShifts(prisma, [rawPreviousClosedShift])
		: [null];

	return {
		currentShift: currentShift ? { ...currentShift, forceClosedByAdmin: null } : null,
		outstandingItems,
		previousClosedShift: enrichedPrevious
	};
}

export async function closeShift(
	actor: PolicyUser | null | undefined,
	shiftId: string,
	input: z.infer<typeof closeShiftSchema>,
	ip?: string,
	outerTx?: DbTx
) {
	assertCan(actor, 'shift:manage');
	const officerActor = actor;
	const db = outerTx ?? prisma;

	const existingShift = await db.shift.findUnique({
		where: { id: shiftId },
		include: {
			user: {
				select: { id: true, name: true, email: true, role: true }
			}
		}
	});

	if (!existingShift) {
		throw new AppError('NOT_FOUND', 'Data shift tidak ditemukan.');
	}

	const hasEmergencyReasonInput = Boolean(
		input.emergencyCloseReason && input.emergencyCloseReason.trim().length > 0
	);
	const isForceCloseByAdmin = existingShift.userId !== officerActor.id || hasEmergencyReasonInput;

	// Hanya peran yang diizinkan oleh kebijakan terpusat can('shift:force-close') yang boleh menutup shift milik petugas lain atau tutup shift darurat (BR-03)
	if (
		isForceCloseByAdmin &&
		!can(officerActor, 'shift:force-close', { userId: existingShift.userId })
	) {
		throw new AppError(
			'FORBIDDEN',
			'Hanya ADMIN yang berhak melakukan penutupan shift darurat atas nama petugas.'
		);
	}

	if (existingShift.status !== 'OPEN') {
		await throwAlreadyClosedShiftError(db, existingShift.id);
	}

	const emergencyCloseReason = (input.emergencyCloseReason ?? '').trim();
	if (isForceCloseByAdmin && emergencyCloseReason.length < 10) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Alasan penutupan shift darurat oleh Admin (emergencyCloseReason) wajib diisi minimal 10 karakter.',
			{ field: 'emergencyCloseReason' }
		);
	}

	// Bagian 7.4 langkah 1 & BR-12: Server menghitung LoanItem aktif yang masih keluar dari database
	const outstandingItems = await getActiveOutstandingLoanItems(db);

	const reasonByLoanItemId = new Map<
		string,
		{ reason: string; responsibleUserId: string | null | undefined }
	>();
	const reasonByAssetId = new Map<
		string,
		{ reason: string; responsibleUserId: string | null | undefined }
	>();
	const reasonByAssetCode = new Map<
		string,
		{ reason: string; responsibleUserId: string | null | undefined }
	>();

	for (const item of input.items ?? []) {
		const entry = {
			reason: item.reason.trim(),
			responsibleUserId: item.responsibleUserId
		};
		if (item.loanItemId) {
			reasonByLoanItemId.set(item.loanItemId, entry);
		}
		if (item.assetId) {
			reasonByAssetId.set(item.assetId, entry);
		}
		if (item.assetCode) {
			reasonByAssetCode.set(item.assetCode.trim().toUpperCase(), entry);
		}
	}

	function resolveProvidedReason(activeItem: (typeof outstandingItems)[number]) {
		return (
			reasonByLoanItemId.get(activeItem.loanItemId) ??
			reasonByAssetId.get(activeItem.asset.id) ??
			reasonByAssetCode.get(activeItem.asset.code.toUpperCase())
		);
	}

	// BR-12: Tiap barang yang belum kembali wajib diberi alasan (alasan untuk barang yang sudah kembali otomatis diabaikan)
	const missingLoanItemCodes: string[] = [];
	const missingAssets: Array<{
		loanItemId: string;
		assetId: string;
		assetCode: string;
		assetName: string;
	}> = [];
	for (const activeItem of outstandingItems) {
		const provided = resolveProvidedReason(activeItem);
		if (!provided || provided.reason.length < 3) {
			missingLoanItemCodes.push(activeItem.asset.code);
			missingAssets.push({
				loanItemId: activeItem.loanItemId,
				assetId: activeItem.asset.id,
				assetCode: activeItem.asset.code,
				assetName: activeItem.asset.name
			});
		}
	}

	if (missingLoanItemCodes.length > 0) {
		throw new AppError(
			'VALIDATION_ERROR',
			`Terdapat ${missingLoanItemCodes.length} barang yang masih keluar dan wajib diberi alasan sebelum menutup shift (${missingLoanItemCodes.join(', ')}) (BR-12).`,
			{ missingAssetCodes: missingLoanItemCodes, missingAssets }
		);
	}

	const now = new Date();

	const closed = await runInTx(outerTx, async (tx) => {
		// Bila tutup shift melampirkan foto bukti (evidenceId), terapkan aturan Evidence yang sama
		if (input.evidenceId) {
			await validateAndAssertEvidenceUnused(tx, {
				actor: officerActor,
				evidenceIds: [input.evidenceId],
				expectedPurpose: 'HANDOVER',
				actionLabel: 'tutup shift'
			});
		}

		// Klaim atomik transisi OPEN -> CLOSED sebelum menyisipkan ShiftItem agar dua request paralel tidak membuat ShiftItem ganda (#4)
		const claimed = await tx.shift.updateMany({
			where: {
				id: shiftId,
				status: 'OPEN'
			},
			data: {
				status: 'CLOSED',
				closedAt: now,
				...(input.note !== undefined ? { note: input.note?.trim() || existingShift.note } : {})
			}
		});

		if (claimed.count === 0) {
			await throwAlreadyClosedShiftError(tx, shiftId);
		}

		if (outstandingItems.length > 0) {
			await tx.shiftItem.createMany({
				data: outstandingItems.map((activeItem) => {
					const provided = resolveProvidedReason(activeItem)!;
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

		const updatedShift = await tx.shift.findUniqueOrThrow({
			where: { id: shiftId },
			include: SHIFT_DETAIL_INCLUDE
		});

		const itemDetailsForAudit = outstandingItems.map((a) => {
			const provided = resolveProvidedReason(a);
			return {
				loanItemId: a.loanItemId,
				assetId: a.asset.id,
				assetCode: a.asset.code,
				assetName: a.asset.name,
				reason: provided?.reason,
				responsibleUserId: provided?.responsibleUserId ?? a.defaultResponsibleUserId
			};
		});

		let forceClosedByAdmin: ForceClosedByAdminInfo | null = null;

		if (isForceCloseByAdmin) {
			const adminUser = await tx.user.findUniqueOrThrow({
				where: { id: officerActor.id },
				select: { id: true, name: true, email: true }
			});

			forceClosedByAdmin = {
				adminId: adminUser.id,
				adminName: adminUser.name,
				adminEmail: adminUser.email,
				emergencyCloseReason,
				closedAt: now.toISOString()
			};

			await writeAuditLog(tx, {
				actorId: officerActor.id,
				action: 'SHIFT_FORCE_CLOSED_BY_ADMIN',
				entityType: 'Shift',
				entityId: updatedShift.id,
				before: {
					status: 'OPEN',
					closedAt: null,
					targetOfficerId: existingShift.userId
				},
				after: {
					status: 'CLOSED',
					closedAt: now.toISOString(),
					closedByAdmin: {
						id: adminUser.id,
						name: adminUser.name,
						email: adminUser.email
					},
					targetOfficer: {
						id: existingShift.user.id,
						name: existingShift.user.name,
						email: existingShift.user.email
					},
					emergencyCloseReason,
					outstandingItemCount: outstandingItems.length,
					...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
					items: itemDetailsForAudit
				},
				ip: ip ?? null
			});
		} else {
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
					items: itemDetailsForAudit
				},
				ip: ip ?? null
			});
		}

		return {
			...updatedShift,
			forceClosedByAdmin
		};
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

	const [total, rawItems] = await Promise.all([
		prisma.shift.count({ where }),
		prisma.shift.findMany({
			where,
			orderBy: { openedAt: 'desc' },
			skip,
			take: pageSize,
			include: SHIFT_DETAIL_INCLUDE
		})
	]);

	const items = await attachForceCloseInfoToShifts(prisma, rawItems);

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
