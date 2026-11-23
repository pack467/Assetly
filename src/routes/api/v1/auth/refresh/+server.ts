import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { refreshSchema } from '$lib/shared/schemas/auth';
import { refreshUserSession } from '$lib/server/auth/service';
import { AppError, toErrorResponse } from '$lib/shared/errors';
import { ACCESSTOKEN_COOKIE, REFRESHTOKEN_COOKIE } from '$lib/server/auth/tokens';

export const POST: RequestHandler = async (event) => {
	try {
		let body: Record<string, unknown> = {};
		try {
			body = await event.request.json();
		} catch {
			// Body opsional jika refresh token dikirim via cookie httpOnly
		}

		const parsed = refreshSchema.parse(body);
		const rawRefreshToken = parsed.refreshToken ?? event.cookies.get(REFRESHTOKEN_COOKIE);

		if (!rawRefreshToken) {
			throw new AppError('UNAUTHENTICATED', 'Refresh token tidak ditemukan.');
		}

		const ip = event.getClientAddress?.() ?? null;
		const result = await refreshUserSession({
			refreshToken: rawRefreshToken,
			deviceInfo: parsed.deviceInfo ?? event.request.headers.get('user-agent') ?? undefined,
			ip: ip ?? undefined
		});

		const isSecure = process.env.NODE_ENV === 'production';

		event.cookies.set(ACCESSTOKEN_COOKIE, result.accessToken, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: isSecure,
			maxAge: 15 * 60
		});

		event.cookies.set(REFRESHTOKEN_COOKIE, result.refreshToken, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: isSecure,
			maxAge: 30 * 24 * 60 * 60
		});

		return json({
			accessToken: result.accessToken,
			refreshToken: result.refreshToken,
			sessionId: result.sessionId,
			expiresAt: result.expiresAt.toISOString(),
			user: result.user
		});
	} catch (err) {
		return toErrorResponse(err);
	}
};
