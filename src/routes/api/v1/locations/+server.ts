import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createLocation, listLocations } from '$lib/server/services/locationService';
import { createLocationSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const onlyActive = event.url.searchParams.get('onlyActive') === 'true';
		const result = await listLocations(event.locals.user, { onlyActive });
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createLocationSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createLocation(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
