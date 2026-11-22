import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { changeAssetSpecialStatus } from '$lib/server/services/assetService';
import { changeAssetStatusSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = changeAssetStatusSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await changeAssetSpecialStatus(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
