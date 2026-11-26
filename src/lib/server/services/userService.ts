import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { hashPassword } from '$lib/server/auth/password';
import { generateTotpSecret } from '$lib/server/auth/totp';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type { createUserSchema, updateUserSchema } from '$lib/shared/schemas/master';

export async function listUsers(
	actor: PolicyUser | null | undefined,
	params: {
		page?: number;
		pageSize?: number;
		search?: string;
		role?: 'ADMIN' | 'OFFICER' | 'BORROWER';
		isActive?: boolean;
	} = {}
) {
	assertCan(actor, 'master:manage');

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;

	const where = {
		...(params.role ? { role: params.role } : {}),
		...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
		...(params.search
			? {
					OR: [
						{ name: { contains: params.search.trim(), mode: 'insensitive' as const } },
						{ email: { contains: params.search.trim(), mode: 'insensitive' as const } }
					]
				}
			: {})
	};

	const [total, users] = await Promise.all([
		prisma.user.count({ where }),
		prisma.user.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			skip,
			take: pageSize,
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				isActive: true,
				mfaSecret: true,
				createdAt: true,
				updatedAt: true,
				_count: {
					select: {
						sessions: {
							where: {
								revokedAt: null,
								expiresAt: { gt: new Date() }
							}
						}
					}
				}
			}
		})
	]);

	return {
		items: users.map((u) => ({
			id: u.id,
			name: u.name,
			email: u.email,
			role: u.role,
			isActive: u.isActive,
			hasTotp: Boolean(u.mfaSecret),
			activeSessionCount: u._count.sessions,
			createdAt: u.createdAt,
			updatedAt: u.updatedAt
		})),
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}

export async function createUser(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createUserSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const normalizedEmail = input.email.trim().toLowerCase();
	const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
	if (existing) {
		throw new AppError('VALIDATION_ERROR', 'Email sudah terdaftar.', { field: 'email' });
	}

	const passwordHash = await hashPassword(input.password);

	// BR-19: Akun ADMIN wajib verifikasi dua langkah (TOTP)
	let totpSetup: { secret: string; uri: string } | null = null;
	if (input.role === 'ADMIN') {
		totpSetup = generateTotpSecret(normalizedEmail);
	}

	const created = await prisma.$transaction(async (tx) => {
		const user = await tx.user.create({
			data: {
				name: input.name.trim(),
				email: normalizedEmail,
				passwordHash,
				role: input.role,
				isActive: input.isActive ?? true,
				mfaSecret: totpSetup?.secret ?? null
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'USER_CREATED',
			entityType: 'User',
			entityId: user.id,
			after: {
				id: user.id,
				name: user.name,
				email: user.email,
				role: user.role,
				isActive: user.isActive,
				hasTotp: Boolean(user.mfaSecret)
			},
			ip: ip ?? null
		});

		return user;
	});

	return {
		user: {
			id: created.id,
			name: created.name,
			email: created.email,
			role: created.role,
			isActive: created.isActive,
			hasTotp: Boolean(created.mfaSecret),
			createdAt: created.createdAt
		},
		...(totpSetup ? { totpSetup } : {})
	};
}

export async function updateUser(
	actor: PolicyUser | null | undefined,
	userId: string,
	input: z.infer<typeof updateUserSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.user.findUnique({ where: { id: userId } });
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Pengguna tidak ditemukan.');
	}

	// BR-16: User tidak boleh dinonaktifkan selama masih memegang barang aktif
	if (input.isActive === false && existing.isActive === true) {
		const activeLoanItemsCount = await prisma.loanItem.count({
			where: {
				returnedAt: null,
				asset: {
					status: { notIn: ['LOST', 'RETIRED'] }
				},
				loan: {
					borrowerId: userId,
					status: { in: ['ACTIVE', 'PENDING_APPROVAL'] }
				}
			}
		});

		if (activeLoanItemsCount > 0) {
			throw new AppError(
				'USER_HOLDS_ASSETS',
				'Pengguna tidak boleh dinonaktifkan selama masih memegang barang aktif.',
				{ activeLoanItemsCount }
			);
		}
	}

	const nextRole = input.role ?? existing.role;
	let totpSetup: { secret: string; uri: string } | null = null;
	if (input.regenerateTotp || (nextRole === 'ADMIN' && !existing.mfaSecret)) {
		totpSetup = generateTotpSecret(existing.email);
	}

	const passwordHash = input.password ? await hashPassword(input.password) : undefined;

	const updated = await prisma.$transaction(async (tx) => {
		const user = await tx.user.update({
			where: { id: userId },
			data: {
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.role !== undefined ? { role: input.role } : {}),
				...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
				...(passwordHash !== undefined ? { passwordHash } : {}),
				...(totpSetup ? { mfaSecret: totpSetup.secret } : {})
			}
		});

		// Jika user dinonaktifkan, cabut seluruh sesi aktifnya segera
		if (input.isActive === false) {
			await tx.session.updateMany({
				where: { userId, revokedAt: null },
				data: { revokedAt: new Date() }
			});
		}

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: input.isActive === false ? 'USER_DEACTIVATED' : 'USER_UPDATED',
			entityType: 'User',
			entityId: user.id,
			before: {
				name: existing.name,
				role: existing.role,
				isActive: existing.isActive,
				hasTotp: Boolean(existing.mfaSecret)
			},
			after: {
				name: user.name,
				role: user.role,
				isActive: user.isActive,
				hasTotp: Boolean(user.mfaSecret),
				passwordChanged: Boolean(passwordHash),
				totpRegenerated: Boolean(totpSetup)
			},
			ip: ip ?? null
		});

		return user;
	});

	return {
		user: {
			id: updated.id,
			name: updated.name,
			email: updated.email,
			role: updated.role,
			isActive: updated.isActive,
			hasTotp: Boolean(updated.mfaSecret),
			updatedAt: updated.updatedAt
		},
		...(totpSetup ? { totpSetup } : {})
	};
}

export async function listUserSessions(actor: PolicyUser | null | undefined, userId: string) {
	assertCan(actor, 'master:manage');

	const sessions = await prisma.session.findMany({
		where: { userId },
		orderBy: { createdAt: 'desc' },
		take: 25,
		select: {
			id: true,
			userId: true,
			deviceInfo: true,
			createdAt: true,
			expiresAt: true,
			revokedAt: true
		}
	});

	return { items: sessions };
}
