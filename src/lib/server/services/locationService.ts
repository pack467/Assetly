import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type { createLocationSchema, updateLocationSchema } from '$lib/shared/schemas/master';

export async function listLocations(
	actor: PolicyUser | null | undefined,
	params: { onlyActive?: boolean } = {}
) {
	assertCan(actor, 'asset:read');

	const items = await prisma.location.findMany({
		where: params.onlyActive ? { isActive: true } : undefined,
		orderBy: { name: 'asc' },
		include: {
			_count: {
				select: { assets: true }
			}
		}
	});

	return {
		items: items.map((l) => ({
			id: l.id,
			name: l.name,
			latitude: l.latitude,
			longitude: l.longitude,
			radiusM: l.radiusM,
			isActive: l.isActive,
			assetCount: l._count.assets
		}))
	};
}

export async function createLocation(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createLocationSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.location.findFirst({
		where: { name: { equals: input.name.trim(), mode: 'insensitive' } }
	});
	if (existing) {
		throw new AppError('VALIDATION_ERROR', 'Nama lokasi sudah digunakan.', { field: 'name' });
	}

	const created = await prisma.$transaction(async (tx) => {
		const location = await tx.location.create({
			data: {
				name: input.name.trim(),
				latitude: input.latitude ?? null,
				longitude: input.longitude ?? null,
				radiusM: input.radiusM ?? 100,
				isActive: input.isActive ?? true
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'LOCATION_CREATED',
			entityType: 'Location',
			entityId: location.id,
			after: location,
			ip: ip ?? null
		});

		return location;
	});

	return { location: created };
}

export async function updateLocation(
	actor: PolicyUser | null | undefined,
	id: string,
	input: z.infer<typeof updateLocationSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.location.findUnique({ where: { id } });
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
	}

	if (input.name && input.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
		const conflict = await prisma.location.findFirst({
			where: {
				id: { not: id },
				name: { equals: input.name.trim(), mode: 'insensitive' }
			}
		});
		if (conflict) {
			throw new AppError('VALIDATION_ERROR', 'Nama lokasi sudah digunakan.', { field: 'name' });
		}
	}

	const updated = await prisma.$transaction(async (tx) => {
		const location = await tx.location.update({
			where: { id },
			data: {
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
				...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
				...(input.radiusM !== undefined ? { radiusM: input.radiusM } : {}),
				...(input.isActive !== undefined ? { isActive: input.isActive } : {})
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'LOCATION_UPDATED',
			entityType: 'Location',
			entityId: location.id,
			before: existing,
			after: location,
			ip: ip ?? null
		});

		return location;
	});

	return { location: updated };
}
