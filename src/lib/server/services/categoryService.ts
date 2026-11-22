import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type { createCategorySchema, updateCategorySchema } from '$lib/shared/schemas/master';

export async function listCategories(actor: PolicyUser | null | undefined) {
	assertCan(actor, 'asset:read');

	const items = await prisma.category.findMany({
		orderBy: { name: 'asc' },
		include: {
			_count: {
				select: { assets: true }
			}
		}
	});

	return {
		items: items.map((c) => ({
			id: c.id,
			name: c.name,
			requiresApproval: c.requiresApproval,
			maintenanceIntervalDays: c.maintenanceIntervalDays,
			assetCount: c._count.assets
		}))
	};
}

export async function createCategory(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createCategorySchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.category.findFirst({
		where: { name: { equals: input.name.trim(), mode: 'insensitive' } }
	});
	if (existing) {
		throw new AppError('VALIDATION_ERROR', 'Nama kategori sudah digunakan.', { field: 'name' });
	}

	const created = await prisma.$transaction(async (tx) => {
		const category = await tx.category.create({
			data: {
				name: input.name.trim(),
				requiresApproval: input.requiresApproval ?? false,
				maintenanceIntervalDays: input.maintenanceIntervalDays ?? null
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'CATEGORY_CREATED',
			entityType: 'Category',
			entityId: category.id,
			after: category,
			ip: ip ?? null
		});

		return category;
	});

	return { category: created };
}

export async function updateCategory(
	actor: PolicyUser | null | undefined,
	id: string,
	input: z.infer<typeof updateCategorySchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.category.findUnique({ where: { id } });
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Kategori tidak ditemukan.');
	}

	if (input.name && input.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
		const conflict = await prisma.category.findFirst({
			where: {
				id: { not: id },
				name: { equals: input.name.trim(), mode: 'insensitive' }
			}
		});
		if (conflict) {
			throw new AppError('VALIDATION_ERROR', 'Nama kategori sudah digunakan.', { field: 'name' });
		}
	}

	const updated = await prisma.$transaction(async (tx) => {
		const category = await tx.category.update({
			where: { id },
			data: {
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.requiresApproval !== undefined
					? { requiresApproval: input.requiresApproval }
					: {}),
				...(input.maintenanceIntervalDays !== undefined
					? { maintenanceIntervalDays: input.maintenanceIntervalDays }
					: {})
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'CATEGORY_UPDATED',
			entityType: 'Category',
			entityId: category.id,
			before: existing,
			after: category,
			ip: ip ?? null
		});

		return category;
	});

	return { category: updated };
}
