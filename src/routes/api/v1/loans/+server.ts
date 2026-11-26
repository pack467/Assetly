import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createLoan, listLoans } from '$lib/server/services/loanService';
import { createLoanSchema, listLoansQuerySchema } from '$lib/shared/schemas/loan';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const parsed = listLoansQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined,
			status: url.searchParams.get('status') || undefined,
			overdueOnly: url.searchParams.get('overdueOnly') || undefined,
			borrowerId: url.searchParams.get('borrowerId') || undefined
		});

		const result = await listLoans(event.locals.user, {
			page: parsed.page,
			pageSize: parsed.pageSize,
			status: parsed.status,
			overdueOnly: parsed.overdueOnly === 'true',
			borrowerId: parsed.borrowerId
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
