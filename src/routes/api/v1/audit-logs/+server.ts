import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAuditLogs } from '$lib/server/services/auditService';
import { paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});

		const result = await listAuditLogs(event.locals.user, {
			page,
			pageSize,
			entityType: url.searchParams.get('entityType') || undefined,
			entityId: url.searchParams.get('entityId') || undefined,
			actorId: url.searchParams.get('actorId') || undefined,
			action: url.searchParams.get('action') || undefined,
			from: url.searchParams.get('from') || undefined,
			to: url.searchParams.get('to') || undefined
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};
