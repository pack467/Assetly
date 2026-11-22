import { env } from '$env/dynamic/public';
import { getTokenStorage, type TokenPair, type TokenStorageAdapter } from './tokenStorage';

export interface MobileApiClientOptions {
	baseUrl?: string;
	fetchFn?: typeof fetch;
	storage?: TokenStorageAdapter;
	onUnauthorized?: () => void;
}

export interface MobileApiClient {
	request(path: string, init?: RequestInit): Promise<Response>;
	get(path: string, init?: RequestInit): Promise<Response>;
	post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
	patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
	login(input: {
		email: string;
		password: string;
		totpCode?: string;
		deviceInfo?: string;
	}): Promise<Response>;
	logout(): Promise<void>;
	refreshSession(): Promise<TokenPair | null>;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onMobileUnauthorized(listener: UnauthorizedListener): () => void {
	unauthorizedListeners.add(listener);
	return () => {
		unauthorizedListeners.delete(listener);
	};
}

function notifyUnauthorized(customHandler?: () => void): void {
	if (customHandler) {
		customHandler();
	}
	for (const listener of unauthorizedListeners) {
		try {
			listener();
		} catch {
			// ignore listener error
		}
	}
}

export function resolveApiBaseUrl(configuredBaseUrl?: string): string {
	const raw = (configuredBaseUrl ?? env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
	if (!raw) return '';

	// Bila berjalan di browser lokal (mis. localhost via USB port forwarding) pada port berbeda,
	// tetap gunakan origin browser jika raw menunjuk ke localhost dengan port lain agar tidak kena CORS lokal
	if (typeof window !== 'undefined' && window.location) {
		const isCapacitorNative = Boolean(
			(
				window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
			).Capacitor?.isNativePlatform?.()
		);
		if (!isCapacitorNative) {
			try {
				const parsedRaw = new URL(raw);
				if (
					(parsedRaw.hostname === 'localhost' || parsedRaw.hostname === '127.0.0.1') &&
					(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
					parsedRaw.origin !== window.location.origin
				) {
					return window.location.origin;
				}
			} catch {
				// gunakan raw
			}
		}
	}

	return raw;
}

export function buildFullApiUrl(path: string, baseUrl: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

const NO_REFRESH_PATHS = ['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout'];

function isNoRefreshPath(path: string): boolean {
	return NO_REFRESH_PATHS.some((p) => path.includes(p));
}

export function createMobileApiClient(options: MobileApiClientOptions = {}): MobileApiClient {
	let inFlightRefresh: Promise<TokenPair | null> | null = null;

	function getStorage(): TokenStorageAdapter {
		return options.storage ?? getTokenStorage();
	}

	function getFetch(): typeof fetch {
		return options.fetchFn ?? fetch;
	}

	function getBaseUrl(): string {
		if (options.baseUrl !== undefined) {
			return options.baseUrl.trim().replace(/\/+$/, '');
		}
		return resolveApiBaseUrl();
	}

	async function executeSingleFlightRefresh(): Promise<TokenPair | null> {
		if (inFlightRefresh) {
			return inFlightRefresh;
		}

		inFlightRefresh = (async () => {
			const storage = getStorage();
			const currentTokens = await storage.getTokens();

			if (!currentTokens?.refreshToken) {
				await storage.clearTokens();
				notifyUnauthorized(options.onUnauthorized);
				return null;
			}

			try {
				const fetchFn = getFetch();
				const refreshUrl = buildFullApiUrl('/api/v1/auth/refresh', getBaseUrl());
				const res = await fetchFn(refreshUrl, {
					method: 'POST',
					headers: {
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						refreshToken: currentTokens.refreshToken
					})
				});

				if (!res.ok) {
					await storage.clearTokens();
					notifyUnauthorized(options.onUnauthorized);
					return null;
				}

				const data = (await res.json()) as Partial<TokenPair>;
				if (
					typeof data.accessToken !== 'string' ||
					!data.accessToken ||
					typeof data.refreshToken !== 'string' ||
					!data.refreshToken
				) {
					await storage.clearTokens();
					notifyUnauthorized(options.onUnauthorized);
					return null;
				}

				const nextPair: TokenPair = {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken
				};
				await storage.setTokens(nextPair);
				return nextPair;
			} catch {
				// Bila gagal karena jaringan atau error tak terduga saat refresh
				return null;
			} finally {
				inFlightRefresh = null;
			}
		})();

		return inFlightRefresh;
	}

	async function performRequest(
		path: string,
		init: RequestInit = {},
		isRetry = false
	): Promise<Response> {
		const storage = getStorage();
		const fetchFn = getFetch();
		const fullUrl = buildFullApiUrl(path, getBaseUrl());

		const headers = new Headers(init.headers ?? {});
		const tokens = await storage.getTokens();
		if (tokens?.accessToken && !headers.has('authorization')) {
			headers.set('authorization', `Bearer ${tokens.accessToken}`);
		}

		const response = await fetchFn(fullUrl, {
			...init,
			headers
		});

		if (response.status === 401 && !isRetry && !isNoRefreshPath(path)) {
			const refreshed = await executeSingleFlightRefresh();
			if (refreshed?.accessToken) {
				const retryHeaders = new Headers(init.headers ?? {});
				retryHeaders.set('authorization', `Bearer ${refreshed.accessToken}`);
				return performRequest(
					path,
					{
						...init,
						headers: retryHeaders
					},
					true
				);
			}
		}

		return response;
	}

	return {
		request(path: string, init?: RequestInit) {
			return performRequest(path, init, false);
		},

		get(path: string, init?: RequestInit) {
			return performRequest(path, { ...init, method: 'GET' }, false);
		},

		post(path: string, body?: unknown, init?: RequestInit) {
			const headers = new Headers(init?.headers ?? {});
			let serializedBody: BodyInit | undefined;
			if (body !== undefined) {
				if (body instanceof FormData || typeof body === 'string') {
					serializedBody = body;
				} else {
					if (!headers.has('content-type')) {
						headers.set('content-type', 'application/json');
					}
					serializedBody = JSON.stringify(body);
				}
			}
			return performRequest(
				path,
				{
					...init,
					method: 'POST',
					headers,
					body: serializedBody
				},
				false
			);
		},

		patch(path: string, body?: unknown, init?: RequestInit) {
			const headers = new Headers(init?.headers ?? {});
			if (body !== undefined && !headers.has('content-type')) {
				headers.set('content-type', 'application/json');
			}
			return performRequest(
				path,
				{
					...init,
					method: 'PATCH',
					headers,
					body: body !== undefined ? JSON.stringify(body) : undefined
				},
				false
			);
		},

		async login(input) {
			const fetchFn = getFetch();
			const storage = getStorage();
			const fullUrl = buildFullApiUrl('/api/v1/auth/login', getBaseUrl());

			const res = await fetchFn(fullUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			});

			if (res.ok) {
				const cloned = res.clone();
				const data = (await cloned.json()) as Partial<TokenPair>;
				if (data.accessToken && data.refreshToken) {
					await storage.setTokens({
						accessToken: data.accessToken,
						refreshToken: data.refreshToken
					});
				}
			}

			return res;
		},

		async logout() {
			const storage = getStorage();
			try {
				await performRequest('/api/v1/auth/logout', { method: 'POST' }, true);
			} finally {
				await storage.clearTokens();
			}
		},

		refreshSession() {
			return executeSingleFlightRefresh();
		}
	};
}

export const mobileApi = createMobileApiClient();
