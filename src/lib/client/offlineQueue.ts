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
	clearByStates(states: OfflineSyncState[]): Promise<number>;
	clearAll(): Promise<void>;
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
		async clearByStates(states: OfflineSyncState[]): Promise<number> {
			const stateSet = new Set(states);
			let removed = 0;
			for (const [key, item] of map.entries()) {
				if (stateSet.has(item.syncState)) {
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
 * Jika browser tidak mendukung IndexedDB (mis. saat SSR), otomatis fallback ke memory adapter.
 */
export function createIndexedDbOfflineQueueStorage(): OfflineQueueStorage {
	const fallback = createMemoryOfflineQueueStorage();

	function isIndexedDbSupported(): boolean {
		return typeof indexedDB !== 'undefined' && indexedDB !== null;
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
			request.onerror = () => reject(request.error ?? new Error('Gagal membuka IndexedDB'));
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
						reject(tx.error ?? new Error('Gagal menyimpan ke IndexedDB'));
					};
				});
				notifyOfflineQueueChanged();
				return cloned;
			} catch {
				return fallback.put(item);
			}
		},

		async getById(clientOpId: string): Promise<OfflineQueueItem | null> {
			if (!isIndexedDbSupported()) {
				return fallback.getById(clientOpId);
			}
			try {
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
						reject(req.error ?? new Error('Gagal membaca dari IndexedDB'));
					};
				});
			} catch {
				return fallback.getById(clientOpId);
			}
		},

		async listAll(): Promise<OfflineQueueItem[]> {
			if (!isIndexedDbSupported()) {
				return fallback.listAll();
			}
			try {
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
						reject(req.error ?? new Error('Gagal membaca daftar antrean IndexedDB'));
					};
				});
				items.sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
				return items;
			} catch {
				return fallback.listAll();
			}
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
				});
				notifyOfflineQueueChanged();
			} catch {
				await fallback.remove(clientOpId);
			}
		},

		async clearByStates(states: OfflineSyncState[]): Promise<number> {
			if (!isIndexedDbSupported()) {
				return fallback.clearByStates(states);
			}
			const all = await this.listAll();
			const stateSet = new Set(states);
			const targets = all.filter((item) => stateSet.has(item.syncState));
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
				});
				notifyOfflineQueueChanged();
			} catch {
				await fallback.clearAll();
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

export async function computeOfflineQueueSummary(
	storage: OfflineQueueStorage = activeQueueStorage
): Promise<OfflineQueueSummary> {
	const items = await storage.listAll();
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
