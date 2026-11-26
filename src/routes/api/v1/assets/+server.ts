import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAsset, listAssets } from '$lib/server/services/assetService';
import { createAssetSchema, listAssetsQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const parsed = listAssetsQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined,
			status: url.searchParams.get('status') || undefined,
			categoryId: url.searchParams.get('categoryId') || undefined,
			homeLocationId: url.searchParams.get('homeLocationId') || undefined,
			search: url.searchParams.get('search') || undefined
		});

		const result = await listAssets(event.locals.user, parsed);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createAssetSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createAsset(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
