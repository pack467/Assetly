/**
 * Lapisan Abstraksi Penyimpanan Antrean Operasi Offline (/m/*)
 * -------------------------------------------------------------
 * Sesuai Bagian 10.1 & 10.2 PROJECT_SPEC.md dan keputusan M4 Tahap 4B:
 * - Seluruh operasi lapangan (pinjam, kembali, serah terima, buka/tutup shift)
 *   disimpan terlebih dahulu di penyimpanan lokal HP bersama `clientOpId` (UUID v4)
 *   dan foto bukti (`pendingEvidence`) yang akan diunggah di latar belakang.
 * - Operasi hanya dianggap selesai/dihapus dari antrean tunggu setelah server
 *   mengonfirmasi tersimpan (`ACCEPTED`).
 * - Implementasi default di browser menggunakan IndexedDB (`itam_offline_queue_db`)
 *   agar dapat langsung diuji di browser HP lewat USB port forwarding,
 *   sedangkan antarmuka `OfflineQueueStorage` siap diganti ke adapter
 *   `@capacitor-community/sqlite` saat membungkus APK Capacitor nanti.
 */

import {
	clearMobileSessionStorageCaches,
	resolveCurrentOfflineUserId
} from '$lib/client/tokenStorage';

export type OfflineOpType =
	| 'LOAN_CREATE'
	| 'LOAN_RETURN'
	| 'HANDOVER_CREATE'
	| 'HANDOVER_CONFIRM'
	| 'SHIFT_OPEN'
	| 'SHIFT_CLOSE';

export type OfflineSyncState = 'PENDING' | 'SYNCING' | 'ACCEPTED' | 'CONFLICT' | 'REJECTED';

export interface PendingEvidencePayload {
	purpose: 'CHECKOUT' | 'RETURN' | 'HANDOVER';
	captureSource: 'CAMERA';
	takenAtDevice: string;
	gpsAvailable: boolean;
	latitude: number | null;
	longitude: number | null;
	accuracyM: number | null;
	isMockLocation: boolean;
	locationId: string | null;
	imageBase64: string;
	mimeType: 'image/jpeg';
	/** Diisi setelah foto berhasil diunggah ke POST /api/v1/evidence agar retry tidak mengunggah ulang */
	uploadedEvidenceId?: string | null;
}

export interface OfflineQueueItem {
	clientOpId: string;
	/** ID pengguna pemilik operasi untuk isolasi multi-akun di HP bersama (#1) */
	userId?: string | null;
	type: OfflineOpType;
	/** Label ramah pengguna dalam bahasa Indonesia (mis. "Pinjam AST-0001 - Laptop Dell") */
	label: string;
	assetCode?: string | null;
	assetName?: string | null;
	clientCreatedAt: string;
	payload: Record<string, unknown>;
	pendingEvidence: PendingEvidencePayload | null;
	syncState: OfflineSyncState;
	retryCount: number;
	nextRetryAt: number | null;
	lastError: string | null;
	conflictReason: string | null;
	errorCode: string | null;
	syncedAt: string | null;
	resultData: Record<string, unknown> | null;
}

export interface OfflineQueueSummary {
	pendingCount: number;
	syncingCount: number;
	conflictCount: number;
	rejectedCount: number;
	acceptedCount: number;
	totalCount: number;
}

export interface OfflineQueueStorage {
	put(item: OfflineQueueItem): Promise<OfflineQueueItem>;
	getById(clientOpId: string): Promise<OfflineQueueItem | null>;
	listAll(): Promise<OfflineQueueItem[]>;
	remove(clientOpId: string): Promise<void>;
	clearByStates(states: OfflineSyncState[], userId?: string | null): Promise<number>;
	clearAll(): Promise<void>;
}

/**
 * Memeriksa apakah sebuah item antrean offline milik pengguna yang sedang aktif (#1).
 * - Bila item memiliki `userId`, item tersebut HANYA milik pengguna dengan `activeUserId` yang sama.
 * - Item milik pengguna lain tetap tersimpan utuh di storage dan tidak boleh ditampilkan/disinkronkan/dihapus oleh akun lain.
 */
export function isQueueItemOwnedByUser(
	item: OfflineQueueItem,
	activeUserId?: string | null
): boolean {
	if (item.userId) {
		return Boolean(activeUserId && item.userId === activeUserId);
	}
	return true;
}

const DB_NAME = 'itam_offline_queue_db';
const DB_VERSION = 1;
const STORE_NAME = 'offline_operations';

type QueueChangeListener = () => void;
const listeners = new Set<QueueChangeListener>();

export function subscribeOfflineQueue(listener: QueueChangeListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function notifyOfflineQueueChanged(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// Abaikan error dari listener UI
		}
	}
}

/**
 * Adapter in-memory untuk pengujian unit/integrasi deterministik di Vitest (Node)
 * atau sebagai fallback bila IndexedDB tidak tersedia.
 */
export function createMemoryOfflineQueueStorage(): OfflineQueueStorage {
	const map = new Map<string, OfflineQueueItem>();

	function cloneItem(item: OfflineQueueItem): OfflineQueueItem {
		return JSON.parse(JSON.stringify(item)) as OfflineQueueItem;
	}

	return {
		async put(item: OfflineQueueItem): Promise<OfflineQueueItem> {
			const cloned = cloneItem(item);
			map.set(cloned.clientOpId, cloned);
			notifyOfflineQueueChanged();
			return cloneItem(cloned);
		},
		async getById(clientOpId: string): Promise<OfflineQueueItem | null> {
			const found = map.get(clientOpId);
			return found ? cloneItem(found) : null;
		},
		async listAll(): Promise<OfflineQueueItem[]> {
			const all = Array.from(map.values()).map(cloneItem);
			all.sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
			return all;
		},
		async remove(clientOpId: string): Promise<void> {
			map.delete(clientOpId);
			notifyOfflineQueueChanged();
		},
		async clearByStates(
			states: OfflineSyncState[],
			userId?: string | null
		): Promise<number> {
			const activeUserId =
				userId !== undefined ? userId : await resolveCurrentOfflineUserId();
			const stateSet = new Set(states);
			let removed = 0;
			for (const [key, item] of map.entries()) {
				if (stateSet.has(item.syncState) && isQueueItemOwnedByUser(item, activeUserId)) {
					map.delete(key);
					removed++;
				}
			}
			if (removed > 0) {
				notifyOfflineQueueChanged();
			}
			return removed;
		},
		async clearAll(): Promise<void> {
			map.clear();
			notifyOfflineQueueChanged();
		}
	};
}

/**
 * Adapter IndexedDB untuk browser modern dan Chrome di HP via USB Port Forwarding.
 * Fallback ke memory adapter HANYA bila lingkungan tidak mendukung IndexedDB (mis. saat SSR / Node).
 * Bila IndexedDB didukung tetapi penulisan/pembacaan gagal (mis. penyimpanan penuh), lempar error jujur ke UI (#2).
 */
export function createIndexedDbOfflineQueueStorage(): OfflineQueueStorage {
	const fallback = createMemoryOfflineQueueStorage();

	function isIndexedDbSupported(): boolean {
		return typeof indexedDB !== 'undefined' && indexedDB !== null;
	}

	function toStorageWriteError(err: unknown, defaultMessage: string): Error {
		const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
		return new Error(`${defaultMessage}${detail}`);
	}

	function openDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			if (!isIndexedDbSupported()) {
				reject(new Error('IndexedDB tidak tersedia'));
				return;
			}

			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'clientOpId' });
					store.createIndex('by_created_at', 'clientCreatedAt', { unique: false });
					store.createIndex('by_sync_state', 'syncState', { unique: false });
				}
			};

			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error('Gagal membuka penyimpanan lokal IndexedDB'));
		});
	}

	return {
		async put(item: OfflineQueueItem): Promise<OfflineQueueItem> {
			if (!isIndexedDbSupported()) {
				return fallback.put(item);
			}
			try {
				const db = await openDatabase();
				const cloned = JSON.parse(JSON.stringify(item)) as OfflineQueueItem;
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, 'readwrite');
					const store = tx.objectStore(STORE_NAME);
					store.put(cloned);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => {
						db.close();
						reject(tx.error ?? new Error('Gagal menulis ke IndexedDB'));
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error ?? new Error('Transaksi IndexedDB dibatalkan (ruang penyimpanan penuh)'));
					};
				});
				notifyOfflineQueueChanged();
				return cloned;
			} catch (err) {
				throw toStorageWriteError(
					err,
					'Gagal menyimpan operasi ke penyimpanan lokal HP. Data belum tersimpan — periksa ruang penyimpanan HP Anda lalu coba lagi.'
				);
			}
		},

		async getById(clientOpId: string): Promise<OfflineQueueItem | null> {
			if (!isIndexedDbSupported()) {
				return fallback.getById(clientOpId);
			}
			const db = await openDatabase();
			return await new Promise<OfflineQueueItem | null>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readonly');
				const store = tx.objectStore(STORE_NAME);
				const req = store.get(clientOpId);
				req.onsuccess = () => {
					db.close();
					resolve((req.result as OfflineQueueItem | undefined) ?? null);
				};
				req.onerror = () => {
					db.close();
					reject(req.error ?? new Error('Gagal membaca operasi dari penyimpanan lokal HP.'));
				};
			});
		},

		async listAll(): Promise<OfflineQueueItem[]> {
			if (!isIndexedDbSupported()) {
				return fallback.listAll();
			}
			const db = await openDatabase();
			const items = await new Promise<OfflineQueueItem[]>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readonly');
				const store = tx.objectStore(STORE_NAME);
				const req = store.getAll();
				req.onsuccess = () => {
					db.close();
					resolve((req.result as OfflineQueueItem[]) ?? []);
				};
				req.onerror = () => {
					db.close();
					reject(req.error ?? new Error('Gagal membaca daftar antrean dari penyimpanan lokal HP.'));
				};
			});
			items.sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
			return items;
		},

		async remove(clientOpId: string): Promise<void> {
			if (!isIndexedDbSupported()) {
				return fallback.remove(clientOpId);
			}
			try {
				const db = await openDatabase();
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, 'readwrite');
					const store = tx.objectStore(STORE_NAME);
					store.delete(clientOpId);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => {
						db.close();
						reject(tx.error ?? new Error('Gagal menghapus item dari IndexedDB'));
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error ?? new Error('Penghapusan item IndexedDB dibatalkan'));
					};
				});
				notifyOfflineQueueChanged();
			} catch (err) {
				throw toStorageWriteError(
					err,
					'Gagal menghapus catatan dari penyimpanan lokal HP.'
				);
			}
		},

		async clearByStates(
			states: OfflineSyncState[],
			userId?: string | null
		): Promise<number> {
			if (!isIndexedDbSupported()) {
				return fallback.clearByStates(states, userId);
			}
			const activeUserId =
				userId !== undefined ? userId : await resolveCurrentOfflineUserId();
			const all = await this.listAll();
			const stateSet = new Set(states);
			const targets = all.filter(
				(item) => stateSet.has(item.syncState) && isQueueItemOwnedByUser(item, activeUserId)
			);
			for (const target of targets) {
				await this.remove(target.clientOpId);
			}
			return targets.length;
		},

		async clearAll(): Promise<void> {
			if (!isIndexedDbSupported()) {
				return fallback.clearAll();
			}
			try {
				const db = await openDatabase();
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, 'readwrite');
					const store = tx.objectStore(STORE_NAME);
					store.clear();
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => {
						db.close();
						reject(tx.error ?? new Error('Gagal mengosongkan IndexedDB'));
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error ?? new Error('Pengosongan IndexedDB dibatalkan'));
					};
				});
				notifyOfflineQueueChanged();
			} catch (err) {
				throw toStorageWriteError(
					err,
					'Gagal mengosongkan antrean penyimpanan lokal HP.'
				);
			}
		}
	};
}

let activeQueueStorage: OfflineQueueStorage = createIndexedDbOfflineQueueStorage();

export function getOfflineQueueStorage(): OfflineQueueStorage {
	return activeQueueStorage;
}

/**
 * Mengganti adapter penyimpanan antrean offline (mis. ke Capacitor SQLite di aplikasi native
 * atau ke Memory adapter saat menjalankan unit test).
 */
export function setOfflineQueueStorage(adapter: OfflineQueueStorage): void {
	activeQueueStorage = adapter;
	notifyOfflineQueueChanged();
}

/**
 * Mengambil daftar item antrean offline yang hanya dimiliki oleh pengguna yang sedang login (#1).
 * Item milik pengguna lain di perangkat yang sama tetap tersimpan dan tidak disertakan.
 */
export async function listQueueItemsForUser(
	storage: OfflineQueueStorage = activeQueueStorage,
	userId?: string | null
): Promise<OfflineQueueItem[]> {
	const activeUserId = userId !== undefined ? userId : await resolveCurrentOfflineUserId();
	const all = await storage.listAll();
	return all.filter((item) => isQueueItemOwnedByUser(item, activeUserId));
}

export async function computeOfflineQueueSummary(
	storage: OfflineQueueStorage = activeQueueStorage,
	userId?: string | null
): Promise<OfflineQueueSummary> {
	const items = await listQueueItemsForUser(storage, userId);
	let pendingCount = 0;
	let syncingCount = 0;
	let conflictCount = 0;
	let rejectedCount = 0;
	let acceptedCount = 0;

	for (const item of items) {
		if (item.syncState === 'PENDING') pendingCount++;
		else if (item.syncState === 'SYNCING') syncingCount++;
		else if (item.syncState === 'CONFLICT') conflictCount++;
		else if (item.syncState === 'REJECTED') rejectedCount++;
		else if (item.syncState === 'ACCEPTED') acceptedCount++;
	}

	return {
		pendingCount,
		syncingCount,
		conflictCount,
		rejectedCount,
		acceptedCount,
		totalCount: items.length
	};
}

/**
 * Cache Barang Offline (Bagian 10.2 PROJECT_SPEC.md — #3)
 * -------------------------------------------------------
 * Menyimpan salinan daftar barang dan detail scan terakhir hanya untuk pencarian
 * dan tampilan saat HP sedang offline (disertai label "mungkin tidak terkini").
 * Seluruh aksi tetap divalidasi oleh server saat sinkronisasi.
 */
export interface CachedAssetSummary {
	id: string;
	code: string;
	qrToken?: string | null;
	name: string;
	status: string;
	serialNumber: string | null;
	notes?: string | null;
	currentHolder?: string | null;
	category?: {
		id: string;
		name: string;
		requiresApproval: boolean;
	} | null;
	homeLocation?: {
		id: string;
		name: string;
	} | null;
	accessories?: Array<{ id: string; name: string; quantity: number }>;
}

export interface CachedAssetScanPayload {
	asset: {
		id: string;
		code: string;
		qrToken?: string | null;
		name: string;
		status: string;
		serialNumber: string | null;
		notes: string | null;
		category: {
			id: string;
			name: string;
			requiresApproval: boolean;
		};
		homeLocation: {
			id: string;
			name: string;
		} | null;
		accessories: Array<{ id: string; name: string; quantity: number }>;
	};
	allowedActions: string[];
	currentHolder: string | null;
	requiresApproval: boolean;
	activeLoanItem: {
		id: string;
		loanId: string;
		borrowerId: string;
		purpose: string;
		expectedReturnAt: string;
		accessoryChecks: Array<{
			id: string;
			name: string;
			quantity: number;
			outOk: boolean;
			returnOk: boolean | null;
		}>;
	} | null;
	cachedAt?: string;
}

const ASSET_LIST_CACHE_KEY = 'itam_offline_asset_list_v1';
const ASSET_SCAN_MAP_CACHE_KEY = 'itam_offline_asset_scan_map_v1';

let memoryAssetListCache: CachedAssetSummary[] = [];
let memoryAssetScanMapCache: Record<string, CachedAssetScanPayload> = {};

function readSessionJson<T>(key: string): T | null {
	if (typeof window === 'undefined' || !window.sessionStorage) return null;
	try {
		const raw = window.sessionStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function writeSessionJson(key: string, value: unknown): void {
	if (typeof window === 'undefined' || !window.sessionStorage) return;
	try {
		window.sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Abaikan jika storage penuh
	}
}

export function saveCachedAssetsList(assets: CachedAssetSummary[]): void {
	const cloned = JSON.parse(JSON.stringify(assets)) as CachedAssetSummary[];
	memoryAssetListCache = cloned;
	writeSessionJson(ASSET_LIST_CACHE_KEY, cloned);
}

export function getCachedAssetsList(): CachedAssetSummary[] {
	const fromSession = readSessionJson<CachedAssetSummary[]>(ASSET_LIST_CACHE_KEY);
	if (fromSession && Array.isArray(fromSession)) {
		memoryAssetListCache = fromSession;
		return JSON.parse(JSON.stringify(fromSession)) as CachedAssetSummary[];
	}
	return JSON.parse(JSON.stringify(memoryAssetListCache)) as CachedAssetSummary[];
}

export function saveCachedAssetScanPayload(payload: CachedAssetScanPayload): void {
	if (!payload?.asset?.code) return;
	const codeKey = payload.asset.code.trim().toUpperCase();
	const withTimestamp: CachedAssetScanPayload = {
		...JSON.parse(JSON.stringify(payload)),
		cachedAt: payload.cachedAt ?? new Date().toISOString()
	};
	const currentMap =
		readSessionJson<Record<string, CachedAssetScanPayload>>(ASSET_SCAN_MAP_CACHE_KEY) ??
		memoryAssetScanMapCache;
	currentMap[codeKey] = withTimestamp;
	memoryAssetScanMapCache = currentMap;
	writeSessionJson(ASSET_SCAN_MAP_CACHE_KEY, currentMap);
	writeSessionJson(`itam_asset_cache_${codeKey}`, withTimestamp);
}

function buildDisplayScanPayloadFromSummary(item: CachedAssetSummary): CachedAssetScanPayload {
	const allowedActions: string[] = [];
	if (item.status === 'AVAILABLE') {
		allowedActions.push('BORROW');
	} else if (item.status === 'BORROWED') {
		allowedActions.push('RETURN');
	}

	return {
		asset: {
			id: item.id,
			code: item.code,
			qrToken: item.qrToken ?? null,
			name: item.name,
			status: item.status,
			serialNumber: item.serialNumber ?? null,
			notes: item.notes ?? null,
			category: item.category ?? {
				id: '',
				name: 'Umum',
				requiresApproval: false
			},
			homeLocation: item.homeLocation ?? null,
			accessories: item.accessories ?? []
		},
		allowedActions,
		currentHolder: item.currentHolder ?? null,
		requiresApproval: Boolean(item.category?.requiresApproval),
		activeLoanItem: null,
		cachedAt: new Date().toISOString()
	};
}

/**
 * Mencari barang di cache lokal berdasarkan kode barang (AST-XXXX), qrToken, atau nomor seri.
 */
export function findCachedAssetByCodeOrQr(rawQuery: string): CachedAssetScanPayload | null {
	const q = (rawQuery ?? '').trim();
	if (!q) return null;
	const upper = q.toUpperCase();

	const scanMap =
		readSessionJson<Record<string, CachedAssetScanPayload>>(ASSET_SCAN_MAP_CACHE_KEY) ??
		memoryAssetScanMapCache;

	if (scanMap[upper]) {
		return JSON.parse(JSON.stringify(scanMap[upper])) as CachedAssetScanPayload;
	}

	const legacyPerCode = readSessionJson<CachedAssetScanPayload>(`itam_asset_cache_${upper}`);
	if (legacyPerCode?.asset?.code) {
		return legacyPerCode;
	}

	// Cari di scanMap berdasarkan qrToken atau serialNumber
	for (const entry of Object.values(scanMap)) {
		if (
			entry.asset.code.toUpperCase() === upper ||
			(entry.asset.qrToken && entry.asset.qrToken === q) ||
			(entry.asset.serialNumber && entry.asset.serialNumber.toUpperCase() === upper)
		) {
			return JSON.parse(JSON.stringify(entry)) as CachedAssetScanPayload;
		}
	}

	// Cari di daftar ringkas barang (hasil cache /api/v1/assets)
	const list = getCachedAssetsList();
	const foundInList = list.find(
		(item) =>
			item.code.toUpperCase() === upper ||
			(item.qrToken && item.qrToken === q) ||
			(item.serialNumber && item.serialNumber.toUpperCase() === upper)
	);

	if (foundInList) {
		return buildDisplayScanPayloadFromSummary(foundInList);
	}

	return null;
}

export function clearCachedAssets(): void {
	memoryAssetListCache = [];
	memoryAssetScanMapCache = {};
	if (typeof window !== 'undefined' && window.sessionStorage) {
		try {
			window.sessionStorage.removeItem(ASSET_LIST_CACHE_KEY);
			window.sessionStorage.removeItem(ASSET_SCAN_MAP_CACHE_KEY);
		} catch {
			// ignore
		}
	}
}

/**
 * Membersihkan seluruh cache sessionStorage milik sesi (/m/*) serta cache aset di memori (#1).
 */
export function clearAllMobileSessionCaches(): void {
	clearCachedAssets();
	clearMobileSessionStorageCaches();
}
