import { z } from 'zod';

export const loginSchema = z.object({
	email: z.string().trim().email('Format email tidak valid.'),
	password: z.string().min(1, 'Password wajib diisi.'),
	totpCode: z
		.string()
		.trim()
		.regex(/^\d{6}$/, 'Kode TOTP harus 6 angka.')
		.optional(),
	deviceInfo: z.string().trim().max(255).optional()
});

export const refreshSchema = z.object({
	refreshToken: z.string().min(10, 'Refresh token tidak valid.').optional(),
	deviceInfo: z.string().trim().max(255).optional()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
