import { json } from '@sveltejs/kit';
import type { AssetStatus } from '@prisma/client';
import type { RequestHandler } from './$types';
import { createAsset, listAssets } from '$lib/server/services/assetService';
import { createAssetSchema, paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});

		const status = (url.searchParams.get('status') || undefined) as AssetStatus | undefined;
		const categoryId = url.searchParams.get('categoryId') || undefined;
		const homeLocationId = url.searchParams.get('homeLocationId') || undefined;
		const search = url.searchParams.get('search') || undefined;

		const result = await listAssets(event.locals.user, {
			page,
			pageSize,
			status,
			categoryId,
			homeLocationId,
			search
		});
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
