import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEvidenceDetail } from '$lib/server/services/evidenceService';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await getEvidenceDetail(event.locals.user, event.params.id);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
