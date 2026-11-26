import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSyncOperations, processSyncBatch } from '$lib/server/services/syncService';
import { listSyncQuerySchema, syncBatchRequestSchema } from '$lib/shared/schemas/sync';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const parsed = listSyncQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined,
			status: url.searchParams.get('status') || undefined
		});

		const result = await listSyncOperations(event.locals.user, parsed);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = syncBatchRequestSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await processSyncBatch(
			event.locals.user,
			parsed,
			ip,
			undefined,
			event.locals.sessionId
		);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
