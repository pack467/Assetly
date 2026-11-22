import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createUser, listUsers } from '$lib/server/services/userService';
import {
	createUserSchema,
	paginationQuerySchema,
	roleEnumSchema
} from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const url = event.url;
		const { page, pageSize } = paginationQuerySchema.parse({
			page: url.searchParams.get('page') ?? undefined,
			pageSize: url.searchParams.get('pageSize') ?? undefined
		});
		const roleParam = url.searchParams.get('role');
		const role = roleParam ? roleEnumSchema.parse(roleParam) : undefined;
		const isActiveParam = url.searchParams.get('isActive');
		const isActive =
			isActiveParam === 'true' ? true : isActiveParam === 'false' ? false : undefined;
		const search = url.searchParams.get('search') ?? undefined;

		const result = await listUsers(event.locals.user, {
			page,
			pageSize,
			role,
			isActive,
			search
		});
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createUserSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createUser(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
