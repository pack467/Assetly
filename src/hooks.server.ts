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

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();
	event.locals.user = null;
	event.locals.sessionId = null;

	const requestOrigin = event.request.headers.get('origin');
	const corsHeaders = getCorsHeadersForOrigin(requestOrigin);

	// Tangani preflight OPTIONS untuk endpoint API (termasuk origin Capacitor)
	if (event.request.method === 'OPTIONS' && event.url.pathname.startsWith('/api/')) {
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

	// #5: Refresh otomatis sesi berbasis cookie (Web Admin) ketika access token kedaluwarsa/tidak ada namun cookie refresh token masih valid
	const isAuthTokenEndpoint =
		event.url.pathname === '/api/v1/auth/login' || event.url.pathname === '/api/v1/auth/refresh';
	if (!event.locals.user && !hasBearerHeader && !isAuthTokenEndpoint) {
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
