import { json } from '@sveltejs/kit';
import type { SyncStatus } from '@prisma/client';
import type { RequestHandler } from './$types';
import { listSyncOperations, processSyncBatch } from '$lib/server/services/syncService';
import { syncBatchRequestSchema } from '$lib/shared/schemas/sync';
import { paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});
		const status = (url.searchParams.get('status') || undefined) as SyncStatus | undefined;

		const result = await listSyncOperations(event.locals.user, {
			page,
			pageSize,
			status
		});
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
