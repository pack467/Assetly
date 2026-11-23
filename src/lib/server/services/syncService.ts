import { ZodError } from 'zod';
import { Prisma, type SyncStatus } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog, type DbTx } from '$lib/server/audit';
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
			return {
				loanId: res.loan.id,
				status: res.loan.status,
				recoveredReplay: res.idempotentReplay
			};
		}

		case 'LOAN_RETURN': {
			let loanItemId =
				typeof rawPayload.loanItemId === 'string' ? rawPayload.loanItemId.trim() : '';

			// Bila klien offline mengirim assetId, cari LoanItem aktif ATAU LoanItem yang baru saja dikembalikan
			// oleh operasi dengan evidenceId yang sama (pemulihan crash sebelum SyncOperation tercatat)
			if (!loanItemId && typeof rawPayload.assetId === 'string') {
				const assetId = rawPayload.assetId.trim();
				const activeLoanItem = await prisma.loanItem.findFirst({
					where: {
						assetId,
						returnedAt: null
					},
					select: { id: true }
				});
				if (activeLoanItem) {
					loanItemId = activeLoanItem.id;
				} else if (typeof rawPayload.evidenceId === 'string') {
					const alreadyReturnedBySameEv = await prisma.loanItem.findFirst({
						where: {
							assetId,
							returnEvidenceId: rawPayload.evidenceId.trim()
						},
						select: { id: true }
					});
					if (alreadyReturnedBySameEv) {
						loanItemId = alreadyReturnedBySameEv.id;
					}
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

async function saveSyncOperationInTx(
	tx: DbTx,
	params: {
		actorId: string;
		op: SyncOperationItemInput;
		clientCreatedAt: Date;
		status: SyncStatus;
		conflictReason: string | null;
		ip?: string;
	}
) {
	const existing = await tx.syncOperation.findUnique({
		where: { clientOpId: params.op.clientOpId }
	});
	if (existing) {
		return { record: existing, alreadyExisted: true };
	}

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

	return { record: syncRecord, alreadyExisted: false };
}

function buildReplayOrHijackResult(
	existingSyncOp: {
		id: string;
		clientOpId: string;
		userId: string;
		type: string;
		status: SyncStatus;
		conflictReason: string | null;
	},
	actorId: string,
	requestedType: string
): SyncOperationResultItem {
	if (existingSyncOp.userId !== actorId) {
		return {
			clientOpId: existingSyncOp.clientOpId,
			type: requestedType,
			status: 'REJECTED',
			code: 'DUPLICATE_OPERATION',
			conflictReason: 'clientOpId sudah digunakan oleh pengguna lain.',
			idempotentReplay: false,
			syncOperationId: existingSyncOp.id
		};
	}

	return {
		clientOpId: existingSyncOp.clientOpId,
		type: existingSyncOp.type,
		status: existingSyncOp.status,
		conflictReason: existingSyncOp.conflictReason,
		idempotentReplay: true,
		syncOperationId: existingSyncOp.id
	};
}

/**
 * Memproses satu operasi sinkronisasi di bawah kunci eksklusif PostgreSQL pg_advisory_xact_lock(hashtext(clientOpId))
 * sehingga tahan terhadap pengiriman ulang maupun request paralel dengan clientOpId yang sama.
 */
async function processSingleSyncOperationWithLock(
	actor: PolicyUser,
	op: SyncOperationItemInput,
	clientCreatedAt: Date,
	ip?: string
): Promise<SyncOperationResultItem> {
	try {
		return await prisma.$transaction(
			async (lockTx) => {
				// 1. Kunci eksklusif tingkat transaksi PostgreSQL per clientOpId
				await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${op.clientOpId}))`;

				// 2. Cek apakah clientOpId sudah pernah tercatat di SyncOperation
				const existingSyncOp = await lockTx.syncOperation.findUnique({
					where: { clientOpId: op.clientOpId }
				});

				if (existingSyncOp) {
					return buildReplayOrHijackResult(existingSyncOp, actor.id, op.type);
				}

				// 3. Eksekusi operasi bisnis selama kunci pg_advisory_xact_lock masih dipegang
				try {
					const data = await executeSingleOperation(actor, op, ip);
					const { record, alreadyExisted } = await saveSyncOperationInTx(lockTx, {
						actorId: actor.id,
						op,
						clientCreatedAt,
						status: 'ACCEPTED',
						conflictReason: null,
						ip
					});

					return {
						clientOpId: op.clientOpId,
						type: op.type,
						status: record.status,
						conflictReason: record.conflictReason,
						idempotentReplay: alreadyExisted,
						syncOperationId: record.id,
						data
					};
				} catch (err) {
					if (err instanceof AppError) {
						const isConflict = CONFLICT_ERROR_CODES.has(err.code);
						const syncStatus: SyncStatus = isConflict ? 'CONFLICT' : 'REJECTED';

						const { record, alreadyExisted } = await saveSyncOperationInTx(lockTx, {
							actorId: actor.id,
							op,
							clientCreatedAt,
							status: syncStatus,
							conflictReason: err.message,
							ip
						});

						if (alreadyExisted) {
							return buildReplayOrHijackResult(record, actor.id, op.type);
						}

						return {
							clientOpId: op.clientOpId,
							type: op.type,
							status: syncStatus,
							code: err.code,
							conflictReason: err.message,
							...(err.details ? { details: err.details } : {}),
							idempotentReplay: false,
							syncOperationId: record.id
						};
					}

					if (err instanceof ZodError) {
						const reason = err.issues
							.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
							.join('; ');

						const { record, alreadyExisted } = await saveSyncOperationInTx(lockTx, {
							actorId: actor.id,
							op,
							clientCreatedAt,
							status: 'REJECTED',
							conflictReason: reason,
							ip
						});

						if (alreadyExisted) {
							return buildReplayOrHijackResult(record, actor.id, op.type);
						}

						return {
							clientOpId: op.clientOpId,
							type: op.type,
							status: 'REJECTED',
							code: 'VALIDATION_ERROR',
							conflictReason: reason,
							idempotentReplay: false,
							syncOperationId: record.id
						};
					}

					throw err;
				}
			},
			{
				maxWait: 10000,
				timeout: 20000
			}
		);
	} catch (err) {
		// Pengaman tambahan: bila terjadi pelanggaran unique clientOpId (P2002), kembalikan hasil yang sudah tersimpan
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			const existing = await prisma.syncOperation.findUnique({
				where: { clientOpId: op.clientOpId }
			});
			if (existing) {
				return buildReplayOrHijackResult(existing, actor.id, op.type);
			}
		}
		throw err;
	}
}

/**
 * Memproses batch operasi antrean offline (Bagian 10.2 & 10.3 PROJECT_SPEC.md).
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
		const itemResult = await processSingleSyncOperationWithLock(
			actor,
			entry.op,
			entry.clientCreatedAt,
			ip
		);
		results.push(itemResult);
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
