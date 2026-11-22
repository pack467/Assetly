import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listUserSessions } from '$lib/server/services/userService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await listUserSessions(event.locals.user, event.params.id);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
