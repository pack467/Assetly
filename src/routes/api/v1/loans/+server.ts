import { json } from '@sveltejs/kit';
import type { LoanStatus } from '@prisma/client';
import type { RequestHandler } from './$types';
import { createLoan, listLoans } from '$lib/server/services/loanService';
import { createLoanSchema } from '$lib/shared/schemas/loan';
import { paginationQuerySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});
		const status = (url.searchParams.get('status') || undefined) as LoanStatus | undefined;
		const overdueOnly = url.searchParams.get('overdueOnly') === 'true';
		const borrowerId = url.searchParams.get('borrowerId') || undefined;

		const result = await listLoans(event.locals.user, {
			page,
			pageSize,
			status,
			overdueOnly,
			borrowerId
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createLoanSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createLoan(event.locals.user, parsed, ip);
		return json(result, { status: result.idempotentReplay ? 200 : 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
