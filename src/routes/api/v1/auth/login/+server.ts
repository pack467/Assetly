import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loginSchema } from '$lib/shared/schemas/auth';
import { loginUser } from '$lib/server/auth/service';
import { toErrorResponse } from '$lib/shared/errors';
import { setAuthCookies } from '$lib/server/auth/tokens';

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = loginSchema.parse(body);
		const ip = event.getClientAddress?.() ?? null;

		const result = await loginUser({
			email: parsed.email,
			password: parsed.password,
			totpCode: parsed.totpCode,
			deviceInfo: parsed.deviceInfo ?? event.request.headers.get('user-agent') ?? undefined,
			ip: ip ?? undefined
		});

		setAuthCookies(event.cookies, result);

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
