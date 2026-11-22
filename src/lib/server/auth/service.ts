import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { AppError } from '$lib/shared/errors';
import { verifyPassword } from './password';
import { assertLoginRateLimit, clearLoginRateLimit, recordFailedLoginAttempt } from './rateLimit';
import {
	generateRefreshToken,
	hashRefreshToken,
	REFRESH_TOKEN_TTL_MS,
	signAccessToken,
	verifyAccessToken
} from './tokens';
import { verifyTotpCode } from './totp';

export interface LoginParams {
	email: string;
	password: string;
	totpCode?: string;
	deviceInfo?: string;
	ip?: string;
}

export async function loginUser(params: LoginParams) {
	const normalizedEmail = params.email.trim().toLowerCase();
	const rateKey = `${normalizedEmail}:${params.ip ?? 'unknown'}`;

	assertLoginRateLimit(rateKey);

	const user = await prisma.user.findUnique({
		where: { email: normalizedEmail }
	});

	if (!user || !user.isActive) {
		recordFailedLoginAttempt(rateKey);
		throw new AppError('UNAUTHENTICATED', 'Email atau password salah.');
	}

	const validPassword = await verifyPassword(user.passwordHash, params.password);
	if (!validPassword) {
		recordFailedLoginAttempt(rateKey);
		throw new AppError('UNAUTHENTICATED', 'Email atau password salah.');
	}

	// BR-19: Akun ADMIN wajib verifikasi dua langkah (TOTP) bila mfaSecret sudah diatur
	if (user.role === 'ADMIN' && user.mfaSecret) {
		if (!params.totpCode || !verifyTotpCode(user.mfaSecret, params.totpCode)) {
			recordFailedLoginAttempt(rateKey);
			throw new AppError('UNAUTHENTICATED', 'Kode verifikasi dua langkah (TOTP) tidak valid.');
		}
	}

	clearLoginRateLimit(rateKey);

	const rawRefreshToken = generateRefreshToken();
	const refreshTokenHash = hashRefreshToken(rawRefreshToken);
	const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

	const session = await prisma.$transaction(async (tx) => {
		const createdSession = await tx.session.create({
			data: {
				userId: user.id,
				refreshTokenHash,
				deviceInfo: params.deviceInfo ?? null,
				expiresAt
			}
		});

		await writeAuditLog(tx, {
			actorId: user.id,
			action: 'USER_LOGIN',
			entityType: 'Session',
			entityId: createdSession.id,
			after: {
				userId: user.id,
				deviceInfo: params.deviceInfo ?? null,
				expiresAt: expiresAt.toISOString()
			},
			ip: params.ip ?? null
		});

		return createdSession;
	});

	const accessToken = await signAccessToken({
		sub: user.id,
		sid: session.id,
		role: user.role,
		email: user.email,
		name: user.name
	});

	return {
		accessToken,
		refreshToken: rawRefreshToken,
		sessionId: session.id,
		expiresAt,
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			isActive: user.isActive
		}
	};
}

export async function refreshUserSession(params: {
	refreshToken: string;
	deviceInfo?: string;
	ip?: string;
}) {
	const currentHash = hashRefreshToken(params.refreshToken);

	const existingSession = await prisma.session.findUnique({
		where: { refreshTokenHash: currentHash },
		include: { user: true }
	});

	if (
		!existingSession ||
		existingSession.revokedAt !== null ||
		existingSession.expiresAt <= new Date() ||
		!existingSession.user.isActive
	) {
		throw new AppError('UNAUTHENTICATED', 'Sesi tidak valid atau telah dicabut.');
	}

	const newRawRefreshToken = generateRefreshToken();
	const newRefreshTokenHash = hashRefreshToken(newRawRefreshToken);
	const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

	const updatedSession = await prisma.$transaction(async (tx) => {
		const updated = await tx.session.update({
			where: { id: existingSession.id },
			data: {
				refreshTokenHash: newRefreshTokenHash,
				expiresAt: newExpiresAt,
				...(params.deviceInfo ? { deviceInfo: params.deviceInfo } : {})
			}
		});

		await writeAuditLog(tx, {
			actorId: existingSession.userId,
			action: 'SESSION_REFRESHED',
			entityType: 'Session',
			entityId: existingSession.id,
			after: {
				expiresAt: newExpiresAt.toISOString()
			},
			ip: params.ip ?? null
		});

		return updated;
	});

	const user = existingSession.user;
	const accessToken = await signAccessToken({
		sub: user.id,
		sid: updatedSession.id,
		role: user.role,
		email: user.email,
		name: user.name
	});

	return {
		accessToken,
		refreshToken: newRawRefreshToken,
		sessionId: updatedSession.id,
		expiresAt: newExpiresAt,
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			isActive: user.isActive
		}
	};
}

export async function logoutUserSession(params: {
	sessionId: string;
	actorId: string;
	ip?: string;
}) {
	const now = new Date();
	await prisma.$transaction(async (tx) => {
		const existing = await tx.session.findUnique({
			where: { id: params.sessionId }
		});
		if (!existing) return;

		await tx.session.update({
			where: { id: params.sessionId },
			data: { revokedAt: now }
		});

		await writeAuditLog(tx, {
			actorId: params.actorId,
			action: 'USER_LOGOUT',
			entityType: 'Session',
			entityId: params.sessionId,
			before: { revokedAt: existing.revokedAt?.toISOString() ?? null },
			after: { revokedAt: now.toISOString() },
			ip: params.ip ?? null
		});
	});
}

export async function revokeSessionByAdmin(params: {
	actor: PolicyUser | null | undefined;
	targetSessionId: string;
	ip?: string;
}) {
	assertCan(params.actor, 'session:revoke');
	const actor = params.actor;

	const existing = await prisma.session.findUnique({
		where: { id: params.targetSessionId }
	});

	if (!existing) {
		throw new AppError('NOT_FOUND', 'Sesi tidak ditemukan.');
	}

	const now = new Date();
	const updated = await prisma.$transaction(async (tx) => {
		const revoked = await tx.session.update({
			where: { id: params.targetSessionId },
			data: { revokedAt: now }
		});

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'SESSION_REVOKED',
			entityType: 'Session',
			entityId: params.targetSessionId,
			before: { revokedAt: existing.revokedAt?.toISOString() ?? null },
			after: { revokedAt: now.toISOString(), targetUserId: existing.userId },
			ip: params.ip ?? null
		});

		return revoked;
	});

	return updated;
}

export async function resolveAuthenticatedSession(rawAccessToken: string | null | undefined) {
	if (!rawAccessToken) return null;

	const payload = await verifyAccessToken(rawAccessToken);
	if (!payload) return null;

	// Bagian 12: Pencabutan sesi oleh admin harus berlaku segera pada permintaan berikutnya
	const session = await prisma.session.findUnique({
		where: { id: payload.sid },
		include: { user: true }
	});

	if (
		!session ||
		session.revokedAt !== null ||
		session.expiresAt <= new Date() ||
		!session.user.isActive
	) {
		return null;
	}

	return {
		sessionId: session.id,
		user: {
			id: session.user.id,
			name: session.user.name,
			email: session.user.email,
			role: session.user.role,
			isActive: session.user.isActive
		}
	};
}
