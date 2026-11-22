import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { reprintAssetQr } from '$lib/server/services/assetService';
import { reprintQrSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		let body: Record<string, unknown> = {};
		try {
			body = await event.request.json();
		} catch {
			// body opsional
		}
		const parsed = reprintQrSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await reprintAssetQr(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
