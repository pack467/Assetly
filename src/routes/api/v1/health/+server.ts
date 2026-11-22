import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	try {
		await prisma.$queryRaw`SELECT 1`;
		return json({
			status: 'ok',
			database: 'connected',
			timestamp: new Date().toISOString()
		});
	} catch {
		return json(
			{
				status: 'degraded',
				database: 'disconnected',
				timestamp: new Date().toISOString()
			},
			{ status: 503 }
		);
	}
};
