import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHandover, listHandovers } from '$lib/server/services/handoverService';
import { createHandoverSchema } from '$lib/shared/schemas/handoverShift';
import { paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});
		const loanId = url.searchParams.get('loanId') || undefined;
		const unconfirmedOnly = url.searchParams.get('unconfirmedOnly') === 'true';

		const result = await listHandovers(event.locals.user, {
			page,
			pageSize,
			loanId,
			unconfirmedOnly
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createHandoverSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createHandover(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
