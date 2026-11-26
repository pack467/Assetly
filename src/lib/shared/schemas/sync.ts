import { z } from 'zod';

export const syncOperationTypeSchema = z.enum([
	'LOAN_CREATE',
	'LOAN_RETURN',
	'HANDOVER_CREATE',
	'HANDOVER_CONFIRM',
	'SHIFT_OPEN',
	'SHIFT_CLOSE'
]);

export type SyncOperationType = z.infer<typeof syncOperationTypeSchema>;

export const syncOperationItemSchema = z.object({
	clientOpId: z
		.string()
		.trim()
		.min(4, 'clientOpId wajib diisi untuk setiap operasi sinkronisasi (BR-14).')
		.max(120),
	type: syncOperationTypeSchema,
	clientCreatedAt: z.string().datetime({ offset: true }).or(z.string().min(10)),
	payload: z.record(z.unknown())
});

export const syncBatchRequestSchema = z.object({
	operations: z
		.array(syncOperationItemSchema)
		.min(1, 'Daftar operasi sinkronisasi tidak boleh kosong.')
		.max(100, 'Maksimal 100 operasi dalam satu batch sinkronisasi.')
});

export type SyncOperationItemInput = z.infer<typeof syncOperationItemSchema>;
export type SyncBatchRequestInput = z.infer<typeof syncBatchRequestSchema>;

export const listSyncQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	status: z.enum(['ACCEPTED', 'CONFLICT', 'REJECTED']).optional()
});
