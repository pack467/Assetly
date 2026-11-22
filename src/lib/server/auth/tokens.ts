import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@prisma/client';

export interface AccessTokenPayload {
	sub: string;
	sid: string;
	role: Role;
	email: string;
	name: string;
}

const ACCESS_TOKEN_TTL_SEC = 15 * 60; // 15 menit
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
export const ACCESSTOKEN_COOKIE = 'itam_access_token';
export const REFRESHTOKEN_COOKIE = 'itam_refresh_token';

function getAccessSecret(): Uint8Array {
	if (!process.env.JWT_ACCESS_SECRET && typeof process.loadEnvFile === 'function') {
		try {
			process.loadEnvFile();
		} catch {
			// ignore if .env is not present
		}
	}
	const secret = process.env.JWT_ACCESS_SECRET;
	if (!secret) {
		throw new Error('JWT_ACCESS_SECRET environment variable is required');
	}
	return new TextEncoder().encode(secret);
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
	return new SignJWT({
		sid: payload.sid,
		role: payload.role,
		email: payload.email,
		name: payload.name
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(payload.sub)
		.setIssuedAt()
		.setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
		.sign(getAccessSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
	try {
		const { payload } = await jwtVerify(token, getAccessSecret(), {
			algorithms: ['HS256']
		});
		if (
			typeof payload.sub !== 'string' ||
			typeof payload.sid !== 'string' ||
			typeof payload.role !== 'string' ||
			typeof payload.email !== 'string' ||
			typeof payload.name !== 'string'
		) {
			return null;
		}
		return {
			sub: payload.sub,
			sid: payload.sid,
			role: payload.role as Role,
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
