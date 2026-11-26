import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logoutUserSession } from '$lib/server/auth/service';
import { toErrorResponse } from '$lib/shared/errors';
import { ACCESSTOKEN_COOKIE, REFRESHTOKEN_COOKIE } from '$lib/server/auth/tokens';

export const POST: RequestHandler = async (event) => {
	try {
		let ip: string | undefined;
		try {
			ip = event.getClientAddress?.();
		} catch {
			ip = undefined;
		}

		const cookieRefreshToken = event.cookies.get(REFRESHTOKEN_COOKIE) ?? null;

		if (event.locals.sessionId || cookieRefreshToken) {
			await logoutUserSession({
				sessionId: event.locals.sessionId ?? undefined,
				actorId: event.locals.user?.id ?? undefined,
				refreshToken: cookieRefreshToken ?? undefined,
				ip
			});
		}

		return json({ status: 'logged_out' });
	} catch (err) {
		return toErrorResponse(err);
	} finally {
		event.cookies.delete(ACCESSTOKEN_COOKIE, { path: '/' });
		event.cookies.delete(REFRESHTOKEN_COOKIE, { path: '/' });
	}
};
