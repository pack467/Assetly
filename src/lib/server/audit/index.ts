import type { Prisma, PrismaClient } from '@prisma/client';

export type DbTx = Prisma.TransactionClient | PrismaClient;

export interface AuditLogEntryInput {
	actorId?: string | null;
	action: string;
	entityType: string;
	entityId: string;
	before?: Prisma.InputJsonValue | null;
	after?: Prisma.InputJsonValue | null;
	ip?: string | null;
}

export async function writeAuditLog(tx: DbTx, input: AuditLogEntryInput) {
	return tx.auditLog.create({
		data: {
			actorId: input.actorId ?? null,
			action: input.action,
			entityType: input.entityType,
			entityId: input.entityId,
			...(input.before !== undefined && input.before !== null ? { before: input.before } : {}),
			...(input.after !== undefined && input.after !== null ? { after: input.after } : {}),
			ip: input.ip ?? null
		}
	});
}
