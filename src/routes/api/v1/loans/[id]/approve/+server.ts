import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { approveLoan } from '$lib/server/services/loanService';
import { toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await approveLoan(event.locals.user, event.params.id, ip);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
