import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listShifts } from '$lib/server/services/shiftService';
import { listShiftsQuerySchema } from '$lib/shared/schemas/handoverShift';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const parsed = listShiftsQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined,
			status: url.searchParams.get('status') || undefined,
			userId: url.searchParams.get('userId') || undefined
		});

		const result = await listShifts(event.locals.user, parsed);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
