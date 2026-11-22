import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revokeSessionByAdmin } from '$lib/server/auth/service';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const ip = event.getClientAddress?.() ?? null;
		const revoked = await revokeSessionByAdmin({
			actor: event.locals.user,
			targetSessionId: event.params.id,
			ip: ip ?? undefined
		});

		return json({
			sessionId: revoked.id,
			revokedAt: revoked.revokedAt?.toISOString() ?? null
		});
	} catch (err) {
		return toErrorResponse(err);
	}
};
