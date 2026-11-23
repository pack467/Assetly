import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { closeShift } from '$lib/server/services/shiftService';
import { closeShiftSchema } from '$lib/shared/schemas/handoverShift';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		let body: Record<string, unknown> = {};
		try {
			body = await event.request.json();
		} catch {
			// body opsional jika tidak ada barang tertinggal
		}
		const parsed = closeShiftSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await closeShift(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
