import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDashboardSummary } from '$lib/server/services/loanService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getDashboardSummary(event.locals.user);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
