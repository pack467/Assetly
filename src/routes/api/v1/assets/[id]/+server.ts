import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAssetDetail, updateAsset } from '$lib/server/services/assetService';
import { updateAssetSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getAssetDetail(event.locals.user, event.params.id);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = updateAssetSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await updateAsset(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
