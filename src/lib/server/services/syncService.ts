import { ZodError } from 'zod';
import type { Prisma, SyncStatus } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import type { PolicyUser } from '$lib/server/policy';
import { AppError, type ErrorCode } from '$lib/shared/errors';
import { createLoanSchema, returnLoanItemSchema } from '$lib/shared/schemas/loan';
import {
	closeShiftSchema,
	confirmHandoverSchema,
	createHandoverSchema,
	openShiftSchema
} from '$lib/shared/schemas/handoverShift';
import type { SyncBatchRequestInput, SyncOperationItemInput } from '$lib/shared/schemas/sync';
import { createLoan, returnLoanItem } from './loanService';
import { confirmHandover, createHandover } from './handoverService';
import { closeShift, openShift } from './shiftService';

const CONFLICT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
	'ASSET_NOT_AVAILABLE',
	'ALREADY_BORROWED_CONFLICT',
	'INVALID_STATUS_TRANSITION'
]);

export interface SyncOperationResultItem {
	clientOpId: string;
	type: string;
	status: SyncStatus;
	idempotentReplay: boolean;
	syncOperationId: string;
	code?: string;
	conflictReason: string | null;
	details?: Record<string, unknown>;
	data?: unknown;
}

async function executeSingleOperation(
	actor: PolicyUser,
	op: SyncOperationItemInput,
	ip?: string
): Promise<unknown> {
	const rawPayload = op.payload ?? {};

	switch (op.type) {
		case 'LOAN_CREATE': {
			const parsed = createLoanSchema.parse({
				...rawPayload,
				clientOpId: op.clientOpId
			});
			const res = await createLoan(actor, parsed, ip);
			return { loanId: res.loan.id, status: res.loan.status };
		}

		case 'LOAN_RETURN': {
			let loanItemId =
				typeof rawPayload.loanItemId === 'string' ? rawPayload.loanItemId.trim() : '';

			// Bila klien offline mengirim assetId (karena meminjam & mengembalikan dalam antrean offline),
			// temukan LoanItem aktif untuk assetId tersebut
			if (!loanItemId && typeof rawPayload.assetId === 'string') {
				const activeLoanItem = await prisma.loanItem.findFirst({
					where: {
						assetId: rawPayload.assetId.trim(),
						returnedAt: null
					},
					select: { id: true }
				});
				if (activeLoanItem) {
					loanItemId = activeLoanItem.id;
				}
			}

			if (!loanItemId) {
				throw new AppError(
					'INVALID_STATUS_TRANSITION',
					'Tidak ditemukan peminjaman aktif yang dapat dikembalikan untuk barang ini.'
				);
			}

			const parsed = returnLoanItemSchema.parse({
				...rawPayload,
				clientOpId: op.clientOpId
			});
			const res = await returnLoanItem(actor, loanItemId, parsed, ip);
			return {
				loanItemId: res.loanItem.id,
				loanId: res.loan.id,
				assetStatus: res.asset.status
			};
		}

		case 'HANDOVER_CREATE': {
			const parsed = createHandoverSchema.parse(rawPayload);
			const res = await createHandover(actor, parsed, ip);
			return { handoverId: res.handover.id, isConfirmed: res.handover.isConfirmed };
		}

		case 'HANDOVER_CONFIRM': {
			const handoverId =
				typeof rawPayload.handoverId === 'string' ? rawPayload.handoverId.trim() : '';
			if (!handoverId) {
				throw new AppError('VALIDATION_ERROR', 'handoverId wajib disertakan.');
			}
			const parsed = confirmHandoverSchema.parse(rawPayload);
			const res = await confirmHandover(actor, handoverId, parsed, ip);
			return {
				handoverId: res.handover.id,
				isConfirmed: res.handover.isConfirmed,
				documentNo: res.handover.documentNo
			};
		}

		case 'SHIFT_OPEN': {
			const parsed = openShiftSchema.parse(rawPayload);
			const res = await openShift(actor, parsed, ip);
			return { shiftId: res.shift.id, status: res.shift.status };
		}

		case 'SHIFT_CLOSE': {
			let shiftId = typeof rawPayload.shiftId === 'string' ? rawPayload.shiftId.trim() : '';
			if (!shiftId) {
				const openForUser = await prisma.shift.findFirst({
					where: { userId: actor.id, status: 'OPEN' },
					select: { id: true }
				});
				if (openForUser) {
					shiftId = openForUser.id;
				}
			}
			if (!shiftId) {
				throw new AppError(
					'INVALID_STATUS_TRANSITION',
					'Tidak ada shift terbuka yang dapat ditutup.'
				);
			}
			const parsed = closeShiftSchema.parse(rawPayload);
			const res = await closeShift(actor, shiftId, parsed, ip);
			return { shiftId: res.shift.id, status: res.shift.status };
		}

		default:
			throw new AppError(
				'VALIDATION_ERROR',
				`Tipe operasi sinkronisasi tidak didukung: ${String(op.type)}`
			);
	}
}

async function recordSyncOutcome(params: {
	actorId: string;
	op: SyncOperationItemInput;
	clientCreatedAt: Date;
	status: SyncStatus;
	conflictReason: string | null;
	ip?: string;
}) {
	return prisma.$transaction(async (tx) => {
		const syncRecord = await tx.syncOperation.create({
			data: {
				clientOpId: params.op.clientOpId,
				userId: params.actorId,
				type: params.op.type,
				payload: params.op.payload as Prisma.InputJsonValue,
				status: params.status,
				conflictReason: params.conflictReason,
				clientCreatedAt: params.clientCreatedAt
			}
		});

		await writeAuditLog(tx, {
			actorId: params.actorId,
			action: `SYNC_OPERATION_${params.status}`,
			entityType: 'SyncOperation',
			entityId: syncRecord.id,
			after: {
				clientOpId: syncRecord.clientOpId,
				type: syncRecord.type,
				status: syncRecord.status,
				conflictReason: syncRecord.conflictReason,
				clientCreatedAt: params.clientCreatedAt.toISOString()
			},
			ip: params.ip ?? null
		});

		return syncRecord;
	});
}

/**
 * Memproses batch operasi antrean offline (Bagian 10.2 & 10.3 PROJECT_SPEC.md).
 * - Diurutkan berdasarkan clientCreatedAt.
 * - Idempoten berdasarkan clientOpId (BR-14).
 * - Hasil per operasi: ACCEPTED / CONFLICT / REJECTED.
 */
export async function processSyncBatch(
	actor: PolicyUser | null | undefined,
	input: SyncBatchRequestInput,
	ip?: string
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	// Bagian 10.2: Server memproses operasi per pengguna berdasarkan clientCreatedAt
	const indexedOps = input.operations.map((op, index) => {
		const parsedDate = new Date(op.clientCreatedAt);
		const timestamp = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();
		return {
			op,
			index,
			clientCreatedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
			timestamp
		};
	});

	indexedOps.sort((a, b) => {
		if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
		return a.index - b.index;
	});

	const results: SyncOperationResultItem[] = [];

	for (const entry of indexedOps) {
		const { op, clientCreatedAt } = entry;

		// 1. Cek idempotensi berdasarkan clientOpId di tabel SyncOperation (BR-14)
		const existingSyncOp = await prisma.syncOperation.findUnique({
			where: { clientOpId: op.clientOpId }
		});

		if (existingSyncOp) {
			if (existingSyncOp.userId !== actor.id) {
				results.push({
					clientOpId: op.clientOpId,
					type: op.type,
					status: 'REJECTED',
					code: 'DUPLICATE_OPERATION',
					conflictReason: 'clientOpId sudah digunakan oleh pengguna lain.',
					idempotentReplay: false,
					syncOperationId: existingSyncOp.id
				});
				continue;
			}

			// Operasi yang sama dikirim ulang: kembalikan hasil sebelumnya tanpa mengeksekusi ulang
			results.push({
				clientOpId: existingSyncOp.clientOpId,
				type: existingSyncOp.type,
				status: existingSyncOp.status,
				conflictReason: existingSyncOp.conflictReason,
				idempotentReplay: true,
				syncOperationId: existingSyncOp.id
			});
			continue;
		}

		// 2. Jalankan operasi bisnis dengan seluruh aturan validasi, bukti, dan transaksi yang ada
		try {
			const data = await executeSingleOperation(actor, op, ip);
			const saved = await recordSyncOutcome({
				actorId: actor.id,
				op,
				clientCreatedAt,
				status: 'ACCEPTED',
				conflictReason: null,
				ip
			});

			results.push({
				clientOpId: op.clientOpId,
				type: op.type,
				status: 'ACCEPTED',
				conflictReason: null,
				idempotentReplay: false,
				syncOperationId: saved.id,
				data
			});
		} catch (err) {
			if (err instanceof AppError) {
				const isConflict = CONFLICT_ERROR_CODES.has(err.code);
				const syncStatus: SyncStatus = isConflict ? 'CONFLICT' : 'REJECTED';

				const saved = await recordSyncOutcome({
					actorId: actor.id,
					op,
					clientCreatedAt,
					status: syncStatus,
					conflictReason: err.message,
					ip
				});

				results.push({
					clientOpId: op.clientOpId,
					type: op.type,
					status: syncStatus,
					code: err.code,
					conflictReason: err.message,
					...(err.details ? { details: err.details } : {}),
					idempotentReplay: false,
					syncOperationId: saved.id
				});
				continue;
			}

			if (err instanceof ZodError) {
				const reason = err.issues
					.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
					.join('; ');

				const saved = await recordSyncOutcome({
					actorId: actor.id,
					op,
					clientCreatedAt,
					status: 'REJECTED',
					conflictReason: reason,
					ip
				});

				results.push({
					clientOpId: op.clientOpId,
					type: op.type,
					status: 'REJECTED',
					code: 'VALIDATION_ERROR',
					conflictReason: reason,
					idempotentReplay: false,
					syncOperationId: saved.id
				});
				continue;
			}

			throw err;
		}
	}

	const summary = {
		total: results.length,
		acceptedCount: results.filter((r) => r.status === 'ACCEPTED').length,
		conflictCount: results.filter((r) => r.status === 'CONFLICT').length,
		rejectedCount: results.filter((r) => r.status === 'REJECTED').length,
		replayCount: results.filter((r) => r.idempotentReplay).length
	};

	return {
		summary,
		results
	};
}

export async function listSyncOperations(
	actor: PolicyUser | null | undefined,
	params: {
		status?: SyncStatus;
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

	const where: Prisma.SyncOperationWhereInput = {
		...(actor.role === 'ADMIN' ? {} : { userId: actor.id }),
		...(params.status ? { status: params.status } : {})
	};

	const [total, items] = await Promise.all([
		prisma.syncOperation.count({ where }),
		prisma.syncOperation.findMany({
			where,
			orderBy: { receivedAt: 'desc' },
			skip,
			take: pageSize
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
