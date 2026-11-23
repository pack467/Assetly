import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openShift } from '$lib/server/services/shiftService';
import { openShiftSchema } from '$lib/shared/schemas/handoverShift';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		let body: Record<string, unknown> = {};
		try {
			body = await event.request.json();
		} catch {
			// body opsional
		}
		const parsed = openShiftSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await openShift(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
