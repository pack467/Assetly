import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { confirmHandover } from '$lib/server/services/handoverService';
import { confirmHandoverSchema } from '$lib/shared/schemas/handoverShift';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		let body: Record<string, unknown> = {};
		try {
			body = await event.request.json();
		} catch {
			// body opsional
		}
		const parsed = confirmHandoverSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await confirmHandover(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
