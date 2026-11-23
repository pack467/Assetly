import { json } from '@sveltejs/kit';
import type { ShiftStatus } from '@prisma/client';
import type { RequestHandler } from './$types';
import { listShifts } from '$lib/server/services/shiftService';
import { paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});
		const status = (url.searchParams.get('status') || undefined) as ShiftStatus | undefined;
		const userId = url.searchParams.get('userId') || undefined;

		const result = await listShifts(event.locals.user, {
			page,
			pageSize,
			status,
			userId
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
