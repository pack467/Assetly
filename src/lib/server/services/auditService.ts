import { prisma } from '$lib/server/db';
import { assertCan, type PolicyUser } from '$lib/server/policy';

export async function listAuditLogs(
	actor: PolicyUser | null | undefined,
	params: {
		page?: number;
		pageSize?: number;
		entityType?: string;
		entityId?: string;
		actorId?: string;
		action?: string;
		from?: string;
		to?: string;
	} = {}
) {
	assertCan(actor, 'audit:read');

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;

	const createdAtFilter: { gte?: Date; lte?: Date } = {};
	if (params.from) {
		const d = new Date(params.from);
		if (!isNaN(d.getTime())) createdAtFilter.gte = d;
	}
	if (params.to) {
		const d = new Date(params.to);
		if (!isNaN(d.getTime())) createdAtFilter.lte = d;
	}

	const where = {
		...(params.entityType ? { entityType: params.entityType } : {}),
		...(params.entityId ? { entityId: params.entityId } : {}),
		...(params.actorId ? { actorId: params.actorId } : {}),
		...(params.action
			? { action: { contains: params.action.trim(), mode: 'insensitive' as const } }
			: {}),
		...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {})
	};

	const [total, items] = await Promise.all([
		prisma.auditLog.count({ where }),
		prisma.auditLog.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			skip,
			take: pageSize,
			include: {
				actor: {
					select: {
						id: true,
						name: true,
						email: true,
						role: true
					}
				}
			}
		})
	]);

	return {
		items,
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}
