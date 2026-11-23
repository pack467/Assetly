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

export const shiftItemClosureInputSchema = z.object({
	loanItemId: z.string().uuid('ID item peminjaman tidak valid.'),
	reason: z
		.string()
		.trim()
		.min(3, 'Alasan barang belum kembali wajib diisi minimal 3 karakter (BR-12).')
		.max(1000),
	responsibleUserId: z.string().uuid('ID penanggung jawab tidak valid.').nullable().optional()
});

export const closeShiftSchema = z.object({
	note: z.string().trim().max(1000).nullable().optional(),
	evidenceId: z.string().uuid('ID bukti foto tidak valid.').nullable().optional(),
	items: z.array(shiftItemClosureInputSchema).default([])
});
