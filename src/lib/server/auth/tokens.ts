import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@prisma/client';
import { env } from '$env/dynamic/private';

export interface AccessTokenPayload {
	sub: string;
	sid: string;
	role: Role;
	email: string;
	name: string;
}

const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 15 menit
const MIN_SECRET_LENGTH = 32;
const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(['ADMIN', 'OFFICER', 'BORROWER']);

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
export const ACCESSTOKEN_COOKIE = 'itam_access_token';
export const REFRESHTOKEN_COOKIE = 'itam_refresh_token';

export function isValidRole(value: unknown): value is Role {
	return typeof value === 'string' && VALID_ROLES.has(value as Role);
}

export function getAccessSecret(): Uint8Array {
	const rawSecret = (process.env.JWT_ACCESS_SECRET ?? env.JWT_ACCESS_SECRET ?? '').trim();
	if (!rawSecret) {
		throw new Error(
			'JWT_ACCESS_SECRET wajib diatur pada variabel lingkungan (.env) dan tidak boleh kosong.'
		);
	}
	if (rawSecret.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`JWT_ACCESS_SECRET terlalu pendek (${rawSecret.length} karakter). Gunakan minimal ${MIN_SECRET_LENGTH} karakter.`
		);
	}
	return new TextEncoder().encode(rawSecret);
}

export async function signAccessToken(
	payload: AccessTokenPayload,
	options?: { expiresInSec?: number }
): Promise<string> {
	if (!isValidRole(payload.role)) {
		throw new Error(`Role tidak sah pada payload token: ${String(payload.role)}`);
	}
	const ttlSec = options?.expiresInSec ?? ACCESS_TOKEN_TTL_SEC;
	const expirationTimestamp = Math.floor(Date.now() / 1000) + ttlSec;

	return new SignJWT({
		sid: payload.sid,
		role: payload.role,
		email: payload.email,
		name: payload.name
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(payload.sub)
		.setIssuedAt()
		.setExpirationTime(expirationTimestamp)
		.sign(getAccessSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
	const secret = getAccessSecret();
	try {
		const { payload } = await jwtVerify(token, secret, {
			algorithms: ['HS256']
		});
		if (
			typeof payload.sub !== 'string' ||
			typeof payload.sid !== 'string' ||
			!isValidRole(payload.role) ||
			typeof payload.email !== 'string' ||
			typeof payload.name !== 'string'
		) {
			return null;
		}
		return {
			sub: payload.sub,
			sid: payload.sid,
			role: payload.role,
			email: payload.email,
			name: payload.name
		};
	} catch {
		return null;
	}
}

export function generateRefreshToken(): string {
	return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(rawToken: string): string {
	return createHash('sha256').update(rawToken).digest('hex');
}
