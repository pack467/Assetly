import { z } from 'zod';

export const evidencePurposeSchema = z.enum([
	'CHECKOUT',
	'RETURN',
	'DAMAGE',
	'HANDOVER',
	'MAINTENANCE'
]);

export const uploadEvidenceMetaSchema = z.object({
	purpose: evidencePurposeSchema,
	captureSource: z.string().trim().toUpperCase().default('CAMERA'),
	takenAtDevice: z.string().datetime({ offset: true }).or(z.string().min(10)),
	uploadedAtDevice: z
		.string()
		.datetime({ offset: true })
		.or(z.string().min(10))
		.nullable()
		.optional(),
	gpsAvailable: z.boolean().default(false),
	latitude: z.number().min(-90).max(90).nullable().optional(),
	longitude: z.number().min(-180).max(180).nullable().optional(),
	accuracyM: z.number().min(0).nullable().optional(),
	isMockLocation: z.boolean().default(false),
	locationId: z.string().uuid('Lokasi tidak valid.').nullable().optional(),
	locationNote: z.string().trim().max(500).nullable().optional(),
	imageBase64: z.string().optional(),
	mimeType: z.string().optional()
});

export const accessoryCheckInputSchema = z.object({
	name: z.string().trim().min(1).max(100),
	quantity: z.number().int().min(1).default(1),
	outOk: z.boolean().default(true)
});

export const loanItemInputSchema = z.object({
	assetId: z.string().uuid('ID barang tidak valid.'),
	checkoutEvidenceId: z.string().uuid('ID bukti foto tidak valid.').optional(),
	accessoryChecks: z.array(accessoryCheckInputSchema).optional()
});

export const createLoanSchema = z.object({
	borrowerId: z.string().uuid('ID peminjam tidak valid.').optional(),
	purpose: z.string().trim().min(2, 'Keperluan wajib diisi.').max(120),
	purposeNote: z.string().trim().max(1000).nullable().optional(),
	expectedReturnAt: z.string().min(8, 'Tanggal rencana kembali wajib diisi.'),
	evidenceId: z.string().uuid('Bukti foto wajib disertakan.').optional(),
	assetId: z.string().uuid('ID barang tidak valid.').optional(),
	items: z.array(loanItemInputSchema).min(1).optional(),
	clientOpId: z.string().trim().min(4).max(120).optional()
});

export const returnAccessoryCheckSchema = z.object({
	id: z.string().uuid().optional(),
	name: z.string().trim().min(1).max(100).optional(),
	returnOk: z.boolean()
});

export const returnLoanItemSchema = z.object({
	returnCondition: z.enum(['NORMAL', 'DAMAGED']),
	evidenceId: z.string().uuid('Bukti foto pengembalian wajib disertakan.'),
	damageNote: z.string().trim().max(1000).nullable().optional(),
	damageEvidenceId: z.string().uuid().nullable().optional(),
	accessoryChecks: z.array(returnAccessoryCheckSchema).optional(),
	clientOpId: z.string().trim().min(4).max(120).optional()
});

export const rejectLoanSchema = z.object({
	reason: z.string().trim().min(3, 'Alasan penolakan wajib diisi minimal 3 karakter.').max(1000)
});

export const loanStatusEnumSchema = z.enum([
	'PENDING_APPROVAL',
	'REJECTED',
	'ACTIVE',
	'COMPLETED',
	'CANCELLED'
]);

export const listLoansQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	status: loanStatusEnumSchema.optional(),
	overdueOnly: z.enum(['true', 'false']).optional(),
	borrowerId: z.string().uuid('ID peminjam tidak valid.').optional()
});
