export interface TokenPair {
	accessToken: string;
	refreshToken: string;
}

export interface TokenStorageAdapter {
	getTokens(): Promise<TokenPair | null>;
	setTokens(tokens: TokenPair): Promise<void>;
	clearTokens(): Promise<void>;
}

const STORAGE_KEY = 'itam_mobile_tokens_v1';

interface CapacitorPreferencesLike {
	get(options: { key: string }): Promise<{ value: string | null }>;
	set(options: { key: string; value: string }): Promise<void>;
	remove(options: { key: string }): Promise<void>;
}

function getCapacitorPreferences(): CapacitorPreferencesLike | null {
	if (typeof window === 'undefined') return null;
	const w = window as unknown as {
		Capacitor?: {
			isNativePlatform?: () => boolean;
			Plugins?: {
				Preferences?: CapacitorPreferencesLike;
			};
		};
	};
	if (w.Capacitor?.isNativePlatform?.() && w.Capacitor?.Plugins?.Preferences) {
		return w.Capacitor.Plugins.Preferences;
	}
	return null;
}

function parseTokenPair(raw: string | null): TokenPair | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<TokenPair>;
		if (
			typeof parsed.accessToken === 'string' &&
			parsed.accessToken.length > 0 &&
			typeof parsed.refreshToken === 'string' &&
			parsed.refreshToken.length > 0
		) {
			// Hanya simpan accessToken dan refreshToken, tidak boleh ada rahasia lain
			return {
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken
			};
		}
		return null;
	} catch {
		return null;
	}
}

export function createMemoryTokenStorage(initial: TokenPair | null = null): TokenStorageAdapter {
	let current: TokenPair | null = initial
		? { accessToken: initial.accessToken, refreshToken: initial.refreshToken }
		: null;

	return {
		async getTokens() {
			return current ? { ...current } : null;
		},
		async setTokens(tokens: TokenPair) {
			current = {
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken
			};
		},
		async clearTokens() {
			current = null;
		}
	};
}

class DefaultTokenStorage implements TokenStorageAdapter {
	private memoryCache: TokenPair | null = null;

	async getTokens(): Promise<TokenPair | null> {
		if (this.memoryCache) {
			return { ...this.memoryCache };
		}

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				const { value } = await capPrefs.get({ key: STORAGE_KEY });
				const parsed = parseTokenPair(value);
				this.memoryCache = parsed;
				return parsed ? { ...parsed } : null;
			} catch {
				return null;
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				const raw = window.sessionStorage.getItem(STORAGE_KEY);
				const parsed = parseTokenPair(raw);
				this.memoryCache = parsed;
				return parsed ? { ...parsed } : null;
			} catch {
				return null;
			}
		}

		return null;
	}

	async setTokens(tokens: TokenPair): Promise<void> {
		const sanitized: TokenPair = {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken
		};
		this.memoryCache = sanitized;
		const serialized = JSON.stringify(sanitized);

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				await capPrefs.set({ key: STORAGE_KEY, value: serialized });
				return;
			} catch {
				// fallback ke sessionStorage bila plugin gagal
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				window.sessionStorage.setItem(STORAGE_KEY, serialized);
			} catch {
				// abaikan bila storage penuh / private mode
			}
		}
	}

	async clearTokens(): Promise<void> {
		this.memoryCache = null;

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				await capPrefs.remove({ key: STORAGE_KEY });
			} catch {
				// ignore
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				window.sessionStorage.removeItem(STORAGE_KEY);
			} catch {
				// ignore
			}
		}
	}
}

let activeStorageAdapter: TokenStorageAdapter = new DefaultTokenStorage();

export function getTokenStorage(): TokenStorageAdapter {
	return activeStorageAdapter;
}

export function setTokenStorage(adapter: TokenStorageAdapter): void {
	activeStorageAdapter = adapter;
}
