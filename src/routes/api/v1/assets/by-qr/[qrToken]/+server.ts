import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAssetScanInfo } from '$lib/server/services/assetService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getAssetScanInfo(event.locals.user, {
			qrToken: event.params.qrToken
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
