import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateUser } from '$lib/server/services/userService';
import { updateUserSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const PATCH: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = updateUserSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await updateUser(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
