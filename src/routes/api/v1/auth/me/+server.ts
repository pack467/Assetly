import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AppError, toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		if (!event.locals.user) {
			throw new AppError('UNAUTHENTICATED', 'Sesi login tidak ditemukan.');
		}
		return json({
			user: event.locals.user,
			sessionId: event.locals.sessionId
		});
	} catch (err) {
		return toErrorResponse(err);
	}
};
