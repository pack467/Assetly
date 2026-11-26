import { json } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { logger } from '$lib/server/logger';

export type ErrorCode =
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'VALIDATION_ERROR'
	| 'NOT_FOUND'
	| 'ASSET_NOT_AVAILABLE'
	| 'ASSET_REQUIRES_APPROVAL'
	| 'ALREADY_BORROWED_CONFLICT'
	| 'INVALID_STATUS_TRANSITION'
	| 'DUPLICATE_OPERATION'
	| 'MOCK_LOCATION_BLOCKED'
	| 'EVIDENCE_REQUIRED'
	| 'USER_HOLDS_ASSETS'
	| 'RATE_LIMITED'
	| 'APP_UPDATE_REQUIRED'
	| 'INTERNAL_ERROR';

const DEFAULT_STATUS_BY_CODE: Record<ErrorCode, number> = {
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	VALIDATION_ERROR: 400,
	NOT_FOUND: 404,
	ASSET_NOT_AVAILABLE: 409,
	ASSET_REQUIRES_APPROVAL: 403,
	ALREADY_BORROWED_CONFLICT: 409,
	INVALID_STATUS_TRANSITION: 422,
	DUPLICATE_OPERATION: 409,
	MOCK_LOCATION_BLOCKED: 422,
	EVIDENCE_REQUIRED: 400,
	USER_HOLDS_ASSETS: 409,
	RATE_LIMITED: 429,
	APP_UPDATE_REQUIRED: 426,
	INTERNAL_ERROR: 500
};

export class AppError extends Error {
	public readonly code: ErrorCode;
	public readonly status: number;
	public readonly details?: Record<string, unknown>;

	constructor(
		code: ErrorCode,
		message: string,
		details?: Record<string, unknown>,
		status?: number
	) {
		super(message);
		this.name = 'AppError';
		this.code = code;
		this.status = status ?? DEFAULT_STATUS_BY_CODE[code] ?? 500;
		this.details = details;
	}
}

export function toErrorResponse(err: unknown): Response {
	if (err instanceof AppError) {
		return json(
			{
				error: {
					code: err.code,
					message: err.message,
					...(err.details ? { details: err.details } : {})
				}
			},
			{ status: err.status }
		);
	}

	if (err instanceof ZodError) {
		return json(
			{
				error: {
					code: 'VALIDATION_ERROR' satisfies ErrorCode,
					message: 'Input tidak valid.',
					details: {
						issues: err.issues.map((issue) => ({
							path: issue.path.join('.'),
							message: issue.message
						}))
					}
				}
			},
			{ status: 400 }
		);
	}

	logger.error({ err }, 'Unhandled internal error in API handler');

	return json(
		{
			error: {
				code: 'INTERNAL_ERROR' satisfies ErrorCode,
				message: 'Terjadi kesalahan pada server.'
			}
		},
		{ status: 500 }
	);
}
