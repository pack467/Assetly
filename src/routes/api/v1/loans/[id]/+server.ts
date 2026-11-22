import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLoanDetail } from '$lib/server/services/loanService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getLoanDetail(event.locals.user, event.params.id);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
