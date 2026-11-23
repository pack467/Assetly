import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCurrentShiftState } from '$lib/server/services/shiftService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getCurrentShiftState(event.locals.user);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
