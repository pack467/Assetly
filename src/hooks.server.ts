import { randomUUID } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';
import {
	refreshSessionFromCookie,
	resolveAuthenticatedSession
} from '$lib/server/auth/service';
import { ACCESSTOKEN_COOKIE, REFRESHTOKEN_COOKIE } from '$lib/server/auth/tokens';
import { getCorsHeadersForOrigin } from '$lib/server/cors';
import { logger } from '$lib/server/logger';
import { AppError, toErrorResponse } from '$lib/shared/errors';

function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
	const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function applyHeaders(response: Response, headersToApply: Record<string, string>): Response {
	for (const [key, value] of Object.entries(headersToApply)) {
		response.headers.set(key, value);
	}
	return response;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();
	event.locals.user = null;
	event.locals.sessionId = null;

	const requestOrigin = event.request.headers.get('origin')?.trim() || null;
	const corsHeaders = getCorsHeadersForOrigin(requestOrigin);
	const method = event.request.method.toUpperCase();

	// Tangani preflight OPTIONS untuk endpoint API (termasuk origin Capacitor)
	if (method === 'OPTIONS' && event.url.pathname.startsWith('/api/')) {
		if (!corsHeaders) {
			return new Response(null, {
				status: 403,
				headers: {
					vary: 'Origin',
					'x-request-id': event.locals.requestId
				}
			});
		}

		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders,
				'x-request-id': event.locals.requestId
			}
		});
	}

	// Bagian 15: Paksa pembaruan aplikasi Android lama bila header X-App-Version di bawah MIN_APP_VERSION
	const minVersion = process.env.MIN_APP_VERSION?.trim();
	const clientVersion = event.request.headers.get('x-app-version')?.trim();
	if (minVersion && clientVersion && compareSemver(clientVersion, minVersion) < 0) {
		const updateResp = toErrorResponse(
			new AppError(
				'APP_UPDATE_REQUIRED',
				`Versi aplikasi (${clientVersion}) sudah usang. Harap perbarui ke minimal versi ${minVersion}.`,
				{ minAppVersion: minVersion, currentVersion: clientVersion }
			)
		);
		updateResp.headers.set('x-request-id', event.locals.requestId);
		return corsHeaders ? applyHeaders(updateResp, corsHeaders) : updateResp;
	}

	const authHeader = event.request.headers.get('authorization');
	const hasBearerHeader = Boolean(authHeader && authHeader.toLowerCase().startsWith('bearer '));
	const isSameOrigin = Boolean(requestOrigin && requestOrigin === event.url.origin);
	const isPublicTokenBootstrapEndpoint =
		event.url.pathname === '/api/v1/auth/login' || event.url.pathname === '/api/v1/auth/refresh';

	// Bagian 12 (#1): Pengecekan Origin / CSRF eksplisit untuk seluruh metode tulis (POST, PUT, PATCH, DELETE)
	if (STATE_CHANGING_METHODS.has(method)) {
		if (hasBearerHeader) {
			// Request dengan Bearer (APK Capacitor / klien API): bila mengirim header Origin lintas-origin, wajib terdaftar di CORS_ALLOWED_ORIGINS
			if (requestOrigin && !isSameOrigin && !corsHeaders) {
				const forbiddenBearer = toErrorResponse(
					new AppError('FORBIDDEN', 'Origin permintaan tidak diizinkan oleh kebijakan CORS.')
				);
				forbiddenBearer.headers.set('x-request-id', event.locals.requestId);
				forbiddenBearer.headers.set('vary', 'Origin');
				return forbiddenBearer;
			}
		} else {
			// Request tanpa Bearer (berbasis cookie di Web Admin): WAJIB same-origin (Origin === event.url.origin).
			// Pengecualian terbatas hanya untuk /auth/login dan /auth/refresh dari origin Capacitor yang diizinkan di CORS_ALLOWED_ORIGINS
			// (di mana /auth/refresh lintas-origin hanya menerima refreshToken dari body JSON, tidak pernah dari cookie).
			const allowedCapacitorBootstrap = isPublicTokenBootstrapEndpoint && corsHeaders !== null;
			if (!isSameOrigin && !allowedCapacitorBootstrap) {
				const csrfResp = toErrorResponse(
					new AppError(
						'FORBIDDEN',
						'Permintaan ditolak: Origin tidak sah untuk sesi berbasis cookie (proteksi CSRF).'
					)
				);
				csrfResp.headers.set('x-request-id', event.locals.requestId);
				if (requestOrigin) {
					csrfResp.headers.set('vary', 'Origin');
				}
				return csrfResp;
			}
		}
	}

	let token: string | null = null;
	if (hasBearerHeader && authHeader) {
		token = authHeader.slice(7).trim();
	} else {
		token = event.cookies.get(ACCESSTOKEN_COOKIE) ?? null;
	}

	if (token) {
		const auth = await resolveAuthenticatedSession(token);
		if (auth) {
			event.locals.user = auth.user;
			event.locals.sessionId = auth.sessionId;
		}
	}

	// #5 & #1: Refresh otomatis sesi berbasis cookie (Web Admin) ketika access token kedaluwarsa, hanya untuk request non-cross-site
	const isAuthTokenEndpoint = isPublicTokenBootstrapEndpoint;
	const isCrossSiteFetch = event.request.headers.get('sec-fetch-site') === 'cross-site';
	const canAutoRefreshCookie =
		!event.locals.user &&
		!hasBearerHeader &&
		!isAuthTokenEndpoint &&
		!isCrossSiteFetch &&
		(!requestOrigin || isSameOrigin);

	if (canAutoRefreshCookie) {
		const rawRefreshToken = event.cookies.get(REFRESHTOKEN_COOKIE) ?? null;
		if (rawRefreshToken) {
			let clientIp: string | undefined;
			try {
				clientIp = event.getClientAddress?.();
			} catch {
				clientIp = undefined;
			}

			const refreshed = await refreshSessionFromCookie({
				refreshToken: rawRefreshToken,
				deviceInfo: event.request.headers.get('user-agent') ?? undefined,
				ip: clientIp
			});

			if (refreshed) {
				event.locals.user = refreshed.user;
				event.locals.sessionId = refreshed.sessionId;
				const isSecure = process.env.NODE_ENV === 'production';

				event.cookies.set(ACCESSTOKEN_COOKIE, refreshed.accessToken, {
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: isSecure,
					maxAge: 15 * 60
				});

				event.cookies.set(REFRESHTOKEN_COOKIE, refreshed.refreshToken, {
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: isSecure,
					maxAge: 30 * 24 * 60 * 60
				});
			}
		}
	}

	const start = Date.now();
	const response = await resolve(event);
	const durationMs = Date.now() - start;

	if (event.url.pathname.startsWith('/api/')) {
		logger.info({
			requestId: event.locals.requestId,
			method: event.request.method,
			path: event.url.pathname,
			status: response.status,
			durationMs,
			userId: event.locals.user?.id ?? null
		});
	}

	response.headers.set('x-request-id', event.locals.requestId);
	if (corsHeaders) {
		applyHeaders(response, corsHeaders);
	} else if (requestOrigin) {
		response.headers.set('vary', 'Origin');
	}

	return response;
};
