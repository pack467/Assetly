import type { Role } from '@prisma/client';

declare global {
	namespace App {
		interface AuthenticatedUser {
			id: string;
			name: string;
			email: string;
			role: Role;
			isActive: boolean;
		}

		interface Locals {
			user: AuthenticatedUser | null;
			sessionId: string | null;
			requestId: string;
		}
	}
}

export {};
