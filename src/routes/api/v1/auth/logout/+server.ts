import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logoutUserSession } from '$lib/server/auth/service';
import { AppError, toErrorResponse } from '$lib/shared/errors';
import { ACCESSTOKEN_COOKIE, REFRESHTOKEN_COOKIE } from '$lib/server/auth/tokens';

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.locals.user || !event.locals.sessionId) {
			throw new AppError('UNAUTHENTICATED', 'Sesi login tidak ditemukan.');
		}

		const ip = event.getClientAddress?.() ?? null;
		await logoutUserSession({
			sessionId: event.locals.sessionId,
			actorId: event.locals.user.id,
			ip: ip ?? undefined
		});

		event.cookies.delete(ACCESSTOKEN_COOKIE, { path: '/' });
		event.cookies.delete(REFRESHTOKEN_COOKIE, { path: '/' });

		return json({ status: 'logged_out' });
	} catch (err) {
		return toErrorResponse(err);
	}
};
