import { env } from '$env/dynamic/private';

export const DEFAULT_CAPACITOR_ORIGINS = ['https://localhost', 'capacitor://localhost'] as const;

/**
 * Mem-parsing daftar origin CORS yang diizinkan dari variabel lingkungan CORS_ALLOWED_ORIGINS.
 * Menolak penggunaan wildcard (*) sesuai Bagian 12 PROJECT_SPEC.md.
 */
export function parseAllowedCorsOrigins(rawEnvValue?: string): Set<string> {
	const raw = (
		rawEnvValue ??
		process.env.CORS_ALLOWED_ORIGINS ??
		env.CORS_ALLOWED_ORIGINS ??
		DEFAULT_CAPACITOR_ORIGINS.join(',')
	).trim();

	const entries = raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	for (const entry of entries) {
		if (entry === '*' || entry.includes('*')) {
			throw new Error(
				'CORS_ALLOWED_ORIGINS tidak boleh menggunakan wildcard (*). Cantumkan daftar origin eksplisit seperti https://localhost,capacitor://localhost.'
			);
		}
	}

	return new Set(entries);
}

export function getCorsHeadersForOrigin(
	requestOrigin: string | null | undefined,
	customAllowedOrigins?: Set<string>
): Record<string, string> | null {
	if (!requestOrigin) return null;
	const normalizedOrigin = requestOrigin.trim();
	if (!normalizedOrigin) return null;

	const allowed = customAllowedOrigins ?? parseAllowedCorsOrigins();
	if (!allowed.has(normalizedOrigin)) {
		return null;
	}

	return {
		'access-control-allow-origin': normalizedOrigin,
		'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
		'access-control-allow-headers': 'Content-Type, Authorization, X-App-Version, X-Requested-With',
		'access-control-expose-headers': 'X-Request-Id',
		'access-control-max-age': '86400',
		vary: 'Origin'
	};
}
