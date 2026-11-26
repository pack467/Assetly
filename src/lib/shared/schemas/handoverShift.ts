import { z } from 'zod';

export const createHandoverSchema = z.object({
	loanId: z.string().uuid('ID peminjaman tidak valid.'),
	giverId: z.string().uuid('ID pemberi tidak valid.').optional(),
	receiverId: z.string().uuid('ID penerima wajib dipilih dan harus valid.'),
	evidenceId: z.string().uuid('ID bukti foto tidak valid.').nullable().optional(),
	autoConfirmGiver: z.boolean().default(true)
});

export const confirmHandoverSchema = z.object({
	evidenceId: z.string().uuid('ID bukti foto tidak valid.').nullable().optional()
});

export const openShiftSchema = z.object({
	note: z.string().trim().max(1000).nullable().optional()
});

export const shiftItemClosureInputSchema = z
	.object({
		loanItemId: z.string().uuid('ID item peminjaman tidak valid.').optional(),
		assetId: z.string().uuid('ID barang (assetId) tidak valid.').optional(),
		assetCode: z.string().trim().max(100).optional(),
		reason: z
			.string()
			.trim()
			.min(3, 'Alasan barang belum kembali wajib diisi minimal 3 karakter (BR-12).')
			.max(1000),
		responsibleUserId: z.string().uuid('ID penanggung jawab tidak valid.').nullable().optional()
	})
	.refine((val) => Boolean(val.loanItemId || val.assetId || val.assetCode), {
		message: 'Setiap item penutupan shift wajib mencantumkan loanItemId, assetId, atau assetCode.'
	});

export const closeShiftSchema = z.object({
	note: z.string().trim().max(1000).nullable().optional(),
	emergencyCloseReason: z.string().trim().max(1000).nullable().optional(),
	evidenceId: z.string().uuid('ID bukti foto tidak valid.').nullable().optional(),
	items: z.array(shiftItemClosureInputSchema).default([])
});

export const listHandoversQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	loanId: z.string().uuid('ID peminjaman tidak valid.').optional(),
	unconfirmedOnly: z.enum(['true', 'false']).optional()
});

export const listShiftsQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	status: z.enum(['OPEN', 'CLOSED']).optional(),
	userId: z.string().uuid('ID petugas tidak valid.').optional()
});
