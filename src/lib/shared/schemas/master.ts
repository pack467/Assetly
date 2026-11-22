import { z } from 'zod';

export const paginationQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

export const roleEnumSchema = z.enum(['ADMIN', 'OFFICER', 'BORROWER']);

export const createUserSchema = z.object({
	name: z.string().trim().min(2, 'Nama minimal 2 karakter.').max(120),
	email: z.string().trim().toLowerCase().email('Format email tidak valid.'),
	password: z.string().min(8, 'Password minimal 8 karakter.').max(128),
	role: roleEnumSchema.default('BORROWER'),
	isActive: z.boolean().default(true)
});

export const updateUserSchema = z.object({
	name: z.string().trim().min(2, 'Nama minimal 2 karakter.').max(120).optional(),
	role: roleEnumSchema.optional(),
	password: z.string().min(8, 'Password minimal 8 karakter.').max(128).optional(),
	isActive: z.boolean().optional(),
	regenerateTotp: z.boolean().optional()
});

export const createCategorySchema = z.object({
	name: z.string().trim().min(2, 'Nama kategori minimal 2 karakter.').max(100),
	requiresApproval: z.boolean().default(false),
	maintenanceIntervalDays: z.number().int().min(1).max(3650).nullable().optional()
});

export const updateCategorySchema = z.object({
	name: z.string().trim().min(2, 'Nama kategori minimal 2 karakter.').max(100).optional(),
	requiresApproval: z.boolean().optional(),
	maintenanceIntervalDays: z.number().int().min(1).max(3650).nullable().optional()
});

export const createLocationSchema = z.object({
	name: z.string().trim().min(2, 'Nama lokasi minimal 2 karakter.').max(120),
	latitude: z.number().min(-90).max(90).nullable().optional(),
	longitude: z.number().min(-180).max(180).nullable().optional(),
	radiusM: z.number().int().min(5).max(10000).default(100),
	isActive: z.boolean().default(true)
});

export const updateLocationSchema = z.object({
	name: z.string().trim().min(2, 'Nama lokasi minimal 2 karakter.').max(120).optional(),
	latitude: z.number().min(-90).max(90).nullable().optional(),
	longitude: z.number().min(-180).max(180).nullable().optional(),
	radiusM: z.number().int().min(5).max(10000).optional(),
	isActive: z.boolean().optional()
});

export const accessoryTemplateInputSchema = z.object({
	name: z.string().trim().min(1, 'Nama kelengkapan wajib diisi.').max(100),
	quantity: z.number().int().min(1).max(100).default(1)
});

export const createAssetSchema = z.object({
	name: z.string().trim().min(2, 'Nama barang minimal 2 karakter.').max(160),
	code: z
		.string()
		.trim()
		.min(3)
		.max(40)
		.regex(/^[A-Za-z0-9-_]+$/, 'Kode hanya boleh huruf, angka, tanda hubung, atau garis bawah.')
		.optional(),
	categoryId: z.string().uuid('Kategori tidak valid.'),
	serialNumber: z.string().trim().max(120).nullable().optional(),
	homeLocationId: z.string().uuid('Lokasi tidak valid.').nullable().optional(),
	photoUrl: z.string().trim().max(500).nullable().optional(),
	purchasedAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
	notes: z.string().trim().max(1000).nullable().optional(),
	accessories: z.array(accessoryTemplateInputSchema).optional()
});

export const updateAssetSchema = z.object({
	name: z.string().trim().min(2, 'Nama barang minimal 2 karakter.').max(160).optional(),
	categoryId: z.string().uuid('Kategori tidak valid.').optional(),
	serialNumber: z.string().trim().max(120).nullable().optional(),
	homeLocationId: z.string().uuid('Lokasi tidak valid.').nullable().optional(),
	photoUrl: z.string().trim().max(500).nullable().optional(),
	purchasedAt: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
	notes: z.string().trim().max(1000).nullable().optional(),
	accessories: z.array(accessoryTemplateInputSchema).optional(),
	version: z.number().int().min(0).optional()
});

export const changeAssetStatusSchema = z.object({
	status: z.enum(['AVAILABLE', 'LOST', 'RETIRED']),
	note: z.string().trim().min(3, 'Catatan alasan wajib diisi minimal 3 karakter.').max(1000)
});

export const reprintQrSchema = z.object({
	rotateToken: z.boolean().default(false),
	reason: z.string().trim().max(500).optional()
});

export const csvImportSchema = z.object({
	csvText: z.string().min(1, 'Isi CSV tidak boleh kosong.'),
	mode: z.enum(['preview', 'commit']).default('preview')
});
