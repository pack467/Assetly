import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { returnLoanItem } from '$lib/server/services/loanService';
import { returnLoanItemSchema } from '$lib/shared/schemas/loan';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = returnLoanItemSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await returnLoanItem(event.locals.user, event.params.id, parsed, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
