import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createCategory, listCategories } from '$lib/server/services/categoryService';
import { createCategorySchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const result = await listCategories(event.locals.user);
		return json(result);
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = createCategorySchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await createCategory(event.locals.user, parsed, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
