import { randomUUID } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';
import { resolveAuthenticatedSession } from '$lib/server/auth/service';
import { ACCESSTOKEN_COOKIE } from '$lib/server/auth/tokens';
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

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();
	event.locals.user = null;
	event.locals.sessionId = null;

	// Bagian 15: Paksa pembaruan aplikasi Android lama bila header X-App-Version di bawah MIN_APP_VERSION
	const minVersion = process.env.MIN_APP_VERSION?.trim();
	const clientVersion = event.request.headers.get('x-app-version')?.trim();
	if (minVersion && clientVersion && compareSemver(clientVersion, minVersion) < 0) {
		return toErrorResponse(
			new AppError(
				'APP_UPDATE_REQUIRED',
				`Versi aplikasi (${clientVersion}) sudah usang. Harap perbarui ke minimal versi ${minVersion}.`,
				{ minAppVersion: minVersion, currentVersion: clientVersion }
			)
		);
	}

	const authHeader = event.request.headers.get('authorization');
	let token: string | null = null;
	if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
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
	return response;
};
