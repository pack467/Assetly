import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateLocation } from '$lib/server/services/locationService';
import { updateLocationSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const PATCH: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = updateLocationSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await updateLocation(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
