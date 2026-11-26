import { env } from '$env/dynamic/public';
import {
	clearMobileSessionStorageCaches,
	decodeJwtDisplayProfile,
	getTokenStorage,
	resolveCurrentOfflineUserId,
	type MobileDisplayProfile,
	type TokenPair,
	type TokenStorageAdapter
} from './tokenStorage';

export interface MobileApiClientOptions {
	baseUrl?: string;
	fetchFn?: typeof fetch;
	storage?: TokenStorageAdapter;
	onUnauthorized?: () => void;
}

export interface ResolvedMobileSession {
	user: MobileDisplayProfile | null;
	fromOfflineCache: boolean;
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
	resolveSessionUser(): Promise<ResolvedMobileSession>;
	getResolvedUserId?(): Promise<string | null>;
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
				const data = (await cloned.json()) as Partial<TokenPair> & {
					user?: MobileDisplayProfile;
				};
				if (data.accessToken && data.refreshToken) {
					await storage.setTokens({
						accessToken: data.accessToken,
						refreshToken: data.refreshToken
					});
				}
				if (data.user && storage.setCachedProfile) {
					await storage.setCachedProfile(data.user);
				}
			}

			return res;
		},

		async logout() {
			const storage = getStorage();
			try {
				await performRequest('/api/v1/auth/logout', { method: 'POST' }, true);
			} catch {
				// Tetap bersihkan token lokal meskipun sedang offline saat menekan logout
			} finally {
				await storage.clearTokens();
				if (storage.clearCachedProfile) {
					await storage.clearCachedProfile();
				}
				clearMobileSessionStorageCaches();
			}
		},

		refreshSession() {
			return executeSingleFlightRefresh();
		},

		getResolvedUserId() {
			return resolveCurrentOfflineUserId(getStorage());
		},

		async resolveSessionUser(): Promise<ResolvedMobileSession> {
			const storage = getStorage();
			const stored = await storage.getTokens();
			if (!stored?.accessToken && !stored?.refreshToken) {
				if (storage.clearCachedProfile) {
					await storage.clearCachedProfile();
				}
				return { user: null, fromOfflineCache: false };
			}

			const getOfflineDisplayFallback = async (): Promise<ResolvedMobileSession> => {
				const tokensStillPresent = await storage.getTokens();
				if (!tokensStillPresent?.accessToken && !tokensStillPresent?.refreshToken) {
					if (storage.clearCachedProfile) {
						await storage.clearCachedProfile();
					}
					return { user: null, fromOfflineCache: false };
				}
				const cached =
					(await storage.getCachedProfile?.()) ??
					decodeJwtDisplayProfile(tokensStillPresent?.accessToken);
				return {
					user: cached ?? null,
					fromOfflineCache: Boolean(cached)
				};
			};

			try {
				const res = await performRequest('/api/v1/auth/me', { method: 'GET' }, false);
				if (res.ok) {
					const data = (await res.json()) as { user?: MobileDisplayProfile };
					if (data.user) {
						if (storage.setCachedProfile) {
							await storage.setCachedProfile(data.user);
						}
						return { user: data.user, fromOfflineCache: false };
					}
				}

				if (res.status === 401 || res.status === 403) {
					// Bila refresh juga sudah ditolak oleh server, performRequest -> executeSingleFlightRefresh telah menghapus token.
					// Bila token masih ada di storage, berarti refresh gagal karena HP sedang offline (network error).
					const tokensAfter401 = await storage.getTokens();
					if (!tokensAfter401?.accessToken && !tokensAfter401?.refreshToken) {
						if (storage.clearCachedProfile) {
							await storage.clearCachedProfile();
						}
						return { user: null, fromOfflineCache: false };
					}
				}

				return await getOfflineDisplayFallback();
			} catch {
				// Gangguan jaringan (offline) saat memanggil /api/v1/auth/me -> gunakan cache profil tampilan
				return await getOfflineDisplayFallback();
			}
		}
	};
}

export const mobileApi = createMobileApiClient();
