import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rejectLoan } from '$lib/server/services/loanService';
import { rejectLoanSchema } from '$lib/shared/schemas/loan';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = rejectLoanSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await rejectLoan(event.locals.user, event.params.id, parsed.reason, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
