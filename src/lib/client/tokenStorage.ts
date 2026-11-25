export interface TokenPair {
	accessToken: string;
	refreshToken: string;
}

/**
 * Profil ringkas pengguna HANYA untuk tampilan antarmuka (/m/*) saat HP sedang offline.
 * Seluruh keputusan hak akses dan otorisasi tetap diverifikasi di server melalui can() (BR-03).
 */
export interface MobileDisplayProfile {
	id: string;
	name: string;
	email: string;
	role: 'ADMIN' | 'OFFICER' | 'BORROWER';
	isActive: boolean;
}

export interface TokenStorageAdapter {
	getTokens(): Promise<TokenPair | null>;
	setTokens(tokens: TokenPair): Promise<void>;
	clearTokens(): Promise<void>;
	getCachedProfile?(): Promise<MobileDisplayProfile | null>;
	setCachedProfile?(profile: MobileDisplayProfile): Promise<void>;
	clearCachedProfile?(): Promise<void>;
}

const STORAGE_KEY = 'itam_mobile_tokens_v1';
const PROFILE_STORAGE_KEY = 'itam_mobile_display_profile_v1';

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

function parseDisplayProfile(raw: string | null): MobileDisplayProfile | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<MobileDisplayProfile>;
		if (
			typeof parsed.id === 'string' &&
			parsed.id.length > 0 &&
			typeof parsed.name === 'string' &&
			typeof parsed.email === 'string' &&
			(parsed.role === 'ADMIN' || parsed.role === 'OFFICER' || parsed.role === 'BORROWER')
		) {
			return {
				id: parsed.id,
				name: parsed.name,
				email: parsed.email,
				role: parsed.role,
				isActive: parsed.isActive !== false
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Membaca klaim tampilan non-rahasia dari payload JWT accessToken sebagai cadangan tampilan saat offline.
 * Tidak memverifikasi signature dan tidak pernah dipakai untuk otorisasi.
 */
export function decodeJwtDisplayProfile(
	accessToken: string | null | undefined
): MobileDisplayProfile | null {
	if (!accessToken || typeof accessToken !== 'string') return null;
	const parts = accessToken.split('.');
	if (parts.length !== 3) return null;
	try {
		const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
		const jsonStr =
			typeof atob === 'function'
				? atob(padded)
				: Buffer.from(padded, 'base64').toString('utf8');
		const payload = JSON.parse(jsonStr) as Record<string, unknown>;
		const id = typeof payload.sub === 'string' ? payload.sub : '';
		const name = typeof payload.name === 'string' ? payload.name : '';
		const email = typeof payload.email === 'string' ? payload.email : '';
		const role = payload.role;
		if (
			id &&
			name &&
			email &&
			(role === 'ADMIN' || role === 'OFFICER' || role === 'BORROWER')
		) {
			return {
				id,
				name,
				email,
				role,
				isActive: true
			};
		}
		return null;
	} catch {
		return null;
	}
}

export function createMemoryTokenStorage(
	initial: TokenPair | null = null,
	initialProfile: MobileDisplayProfile | null = null
): TokenStorageAdapter {
	let current: TokenPair | null = initial
		? { accessToken: initial.accessToken, refreshToken: initial.refreshToken }
		: null;
	let currentProfile: MobileDisplayProfile | null = initialProfile ? { ...initialProfile } : null;

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
			currentProfile = null;
		},
		async getCachedProfile() {
			return currentProfile ? { ...currentProfile } : null;
		},
		async setCachedProfile(profile: MobileDisplayProfile) {
			currentProfile = { ...profile };
		},
		async clearCachedProfile() {
			currentProfile = null;
		}
	};
}

class DefaultTokenStorage implements TokenStorageAdapter {
	private memoryCache: TokenPair | null = null;
	private profileCache: MobileDisplayProfile | null = null;

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
		await this.clearCachedProfile();

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

	async getCachedProfile(): Promise<MobileDisplayProfile | null> {
		if (this.profileCache) {
			return { ...this.profileCache };
		}

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				const { value } = await capPrefs.get({ key: PROFILE_STORAGE_KEY });
				const parsed = parseDisplayProfile(value);
				this.profileCache = parsed;
				return parsed ? { ...parsed } : null;
			} catch {
				return null;
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				const raw = window.sessionStorage.getItem(PROFILE_STORAGE_KEY);
				const parsed = parseDisplayProfile(raw);
				this.profileCache = parsed;
				return parsed ? { ...parsed } : null;
			} catch {
				return null;
			}
		}

		return null;
	}

	async setCachedProfile(profile: MobileDisplayProfile): Promise<void> {
		const sanitized: MobileDisplayProfile = {
			id: profile.id,
			name: profile.name,
			email: profile.email,
			role: profile.role,
			isActive: profile.isActive !== false
		};
		this.profileCache = sanitized;
		const serialized = JSON.stringify(sanitized);

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				await capPrefs.set({ key: PROFILE_STORAGE_KEY, value: serialized });
				return;
			} catch {
				// fallback ke sessionStorage
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				window.sessionStorage.setItem(PROFILE_STORAGE_KEY, serialized);
			} catch {
				// ignore
			}
		}
	}

	async clearCachedProfile(): Promise<void> {
		this.profileCache = null;

		const capPrefs = getCapacitorPreferences();
		if (capPrefs) {
			try {
				await capPrefs.remove({ key: PROFILE_STORAGE_KEY });
			} catch {
				// ignore
			}
		}

		if (typeof window !== 'undefined' && window.sessionStorage) {
			try {
				window.sessionStorage.removeItem(PROFILE_STORAGE_KEY);
				window.sessionStorage.removeItem('itam_user_name_cache');
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
