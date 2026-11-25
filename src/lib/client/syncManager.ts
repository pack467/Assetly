/**
 * Pengelola Sinkronisasi Offline & Unggah Foto Latar Belakang (/m/*)
 * ------------------------------------------------------------------
 * Sesuai Bagian 10.1 & 10.2 PROJECT_SPEC.md:
 * 1. Setiap aksi lapangan ditulis ke antrean lokal (`OfflineQueueStorage`) dengan `clientOpId` (UUID v4).
 * 2. Pengunggahan foto bukti (`POST /api/v1/evidence`) dilakukan di latar belakang sebelum mengirim
 *    operasi ke `POST /api/v1/sync`, semua wajib melalui `mobileApi` (0 direct fetch).
 * 3. Jika foto bukti sudah berhasil terunggah (`uploadedEvidenceId` tercatat), percobaan ulang berikutnya
 *    tidak mengunggah ulang foto yang sama (mencegah duplikasi foto & error single-use evidence).
 * 4. Jika koneksi terputus atau server merespons 5xx, operasi dijadwalkan ulang dengan exponential backoff.
 * 5. Jika server merespons `CONFLICT` atau `REJECTED`, operasi ditandai dan diberi penjelasan bahasa
 *    Indonesia yang mudah dipahami pengguna awam untuk diselesaikan di layar `/m/sync`.
 */

import { mobileApi, type MobileApiClient } from '$lib/client/api';
import {
	getOfflineQueueStorage,
	type OfflineOpType,
	type OfflineQueueItem,
	type OfflineQueueStorage,
	type PendingEvidencePayload
} from '$lib/client/offlineQueue';
import { formatFriendlyErrorMessage, type ApiErrorShape } from '$lib/shared/mobile/watermark';

export interface EnqueueOperationInput {
	clientOpId?: string;
	type: OfflineOpType;
	label: string;
	assetCode?: string | null;
	assetName?: string | null;
	clientCreatedAt?: string;
	payload: Record<string, unknown>;
	pendingEvidence?: PendingEvidencePayload | null;
}

export interface SyncRunOutcome {
	processed: number;
	accepted: number;
	conflicts: number;
	rejected: number;
	stillPending: number;
	items: OfflineQueueItem[];
}

export interface SyncPendingOptions {
	/** Abaikan jadwal backoff `nextRetryAt` (digunakan saat pengguna menekan "Sinkronkan Sekarang") */
	force?: boolean;
	/** Injeksi klien API (default `mobileApi`) untuk kemudahan pengujian */
	apiClient?: MobileApiClient;
	/** Injeksi storage antrean (default `getOfflineQueueStorage()`) */
	storage?: OfflineQueueStorage;
	/** Waktu saat ini dalam epoch ms (untuk pengujian backoff deterministik) */
	nowMs?: number;
}

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
export const STUCK_OPERATION_RETRY_THRESHOLD = 5;

export function computeBackoffDelayMs(retryCount: number): number {
	const exponent = Math.max(0, Math.min(retryCount - 1, 6));
	return Math.min(BASE_BACKOFF_MS * Math.pow(2, exponent), MAX_BACKOFF_MS);
}

/**
 * Menentukan apakah sebuah operasi PENDING di antrean sudah mengalami kegagalan berulang
 * melampaui ambang batas wajar sehingga perlu peringatan "Operasi Macet" di /m/sync.
 */
export function isOperationStuck(
	item: OfflineQueueItem,
	threshold = STUCK_OPERATION_RETRY_THRESHOLD
): boolean {
	return item.syncState === 'PENDING' && item.retryCount >= threshold;
}

/**
 * Menerjemahkan alasan konflik/penolakan dari server menjadi panduan bahasa Indonesia
 * yang jelas bagi pengguna awam di lapangan.
 */
export function formatLaymanConflictGuidance(
	type: OfflineOpType,
	errorCode: string | null | undefined,
	serverMessage: string | null | undefined
): string {
	const baseMsg = (serverMessage ?? '').trim();

	if (errorCode === 'ALREADY_BORROWED_CONFLICT' || errorCode === 'ASSET_NOT_AVAILABLE') {
		return `${baseMsg || 'Barang ini sudah dipinjam atau tidak tersedia di gudang.'} Saat HP Anda sedang offline, pengguna lain telah meminjam atau mengubah status barang ini lebih dulu. Silakan batalkan catatan ini lalu scan/pilih barang lain yang tersedia.`;
	}

	if (errorCode === 'INVALID_STATUS_TRANSITION') {
		if (type === 'LOAN_RETURN') {
			return `${baseMsg || 'Barang ini sudah tercatat dikembalikan sebelumnya.'} Anda tidak perlu mengembalikan ulang barang ini.`;
		}
		if (type === 'HANDOVER_CREATE' || type === 'HANDOVER_CONFIRM') {
			return `${baseMsg || 'Status serah terima sudah berubah.'} Barang mungkin sudah diserahterimakan ke pihak lain atau sudah dikembalikan ke gudang.`;
		}
		if (type === 'SHIFT_CLOSE') {
			return `${baseMsg || 'Shift ini sudah ditutup sebelumnya.'} Silakan tekan tombol "Saya Mengerti, Hapus dari Antrean" di bawah untuk membersihkan antrean HP Anda.`;
		}
		return `${baseMsg || 'Status barang atau transaksi sudah berubah di server.'} Silakan periksa kembali kondisi terbaru barang dengan melakukan Scan ulang.`;
	}

	if (errorCode === 'MOCK_LOCATION_BLOCKED') {
		return 'Transaksi ditolak karena terdeteksi aplikasi lokasi palsu (Fake GPS / Mock Location). Matikan aplikasi Fake GPS di HP Anda lalu ulangi pengambilan foto.';
	}

	if (errorCode === 'ASSET_REQUIRES_APPROVAL') {
		return 'Barang ini memerlukan persetujuan Admin/Petugas sebelum dapat dibawa keluar.';
	}

	return baseMsg || 'Operasi ini tidak dapat diproses oleh server karena terjadi bentrokan data.';
}

/**
 * Menyimpan operasi baru ke dalam antrean lokal HP (`PENDING`).
 */
export async function enqueueOfflineOperation(
	input: EnqueueOperationInput,
	storage: OfflineQueueStorage = getOfflineQueueStorage()
): Promise<OfflineQueueItem> {
	const clientOpId = input.clientOpId ?? crypto.randomUUID();
	const clientCreatedAt = input.clientCreatedAt ?? new Date().toISOString();

	const newItem: OfflineQueueItem = {
		clientOpId,
		type: input.type,
		label: input.label,
		assetCode: input.assetCode ?? null,
		assetName: input.assetName ?? null,
		clientCreatedAt,
		payload: { ...input.payload },
		pendingEvidence: input.pendingEvidence ? { ...input.pendingEvidence } : null,
		syncState: 'PENDING',
		retryCount: 0,
		nextRetryAt: null,
		lastError: null,
		conflictReason: null,
		errorCode: null,
		syncedAt: null,
		resultData: null
	};

	return storage.put(newItem);
}

/**
 * Memasukkan `evidenceId` yang baru selesai diunggah di latar belakang
 * ke dalam struktur `payload` operasi sesuai tipe operasinya.
 */
function attachEvidenceIdToPayload(
	type: OfflineOpType,
	payload: Record<string, unknown>,
	evidenceId: string
): Record<string, unknown> {
	const nextPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

	if (type === 'LOAN_CREATE') {
		if (Array.isArray(nextPayload.items) && nextPayload.items.length > 0) {
			nextPayload.items = nextPayload.items.map((rawItem, idx) => {
				const item = { ...(rawItem as Record<string, unknown>) };
				if (idx === 0 || !item.checkoutEvidenceId) {
					item.checkoutEvidenceId = evidenceId;
				}
				return item;
			});
		} else {
			nextPayload.evidenceId = evidenceId;
		}
		return nextPayload;
	}

	// LOAN_RETURN, HANDOVER_CREATE, HANDOVER_CONFIRM memakai field `evidenceId`
	nextPayload.evidenceId = evidenceId;
	return nextPayload;
}

let inFlightSyncPromise: Promise<SyncRunOutcome> | null = null;

/**
 * Menjalankan sinkronisasi antrean operasi offline secara berurutan (kronologis)
 * dengan proteksi single-flight agar dua pemicu bersamaan tidak mengirim operasi ganda.
 */
export async function syncPendingOperations(
	options: SyncPendingOptions = {}
): Promise<SyncRunOutcome> {
	if (inFlightSyncPromise) {
		return inFlightSyncPromise;
	}

	inFlightSyncPromise = executeSyncPendingOperations(options).finally(() => {
		inFlightSyncPromise = null;
	});

	return inFlightSyncPromise;
}

async function executeSyncPendingOperations(
	options: SyncPendingOptions = {}
): Promise<SyncRunOutcome> {
	const api = options.apiClient ?? mobileApi;
	const storage = options.storage ?? getOfflineQueueStorage();
	const nowMs = options.nowMs ?? Date.now();
	const force = options.force ?? false;

	const allItems = await storage.listAll();
	let processed = 0;
	let accepted = 0;
	let conflicts = 0;
	let rejected = 0;

	// Jika browser jelas melapor offline dan bukan mode force pada test, lewati pengiriman jaringan
	if (typeof navigator !== 'undefined' && navigator.onLine === false && !options.apiClient) {
		const pendingItems = allItems.filter((i) => i.syncState === 'PENDING').length;
		return {
			processed: 0,
			accepted: 0,
			conflicts: 0,
			rejected: 0,
			stillPending: pendingItems,
			items: allItems
		};
	}

	for (const rawItem of allItems) {
		if (rawItem.syncState !== 'PENDING' && rawItem.syncState !== 'SYNCING') {
			continue;
		}

		// Aturan FIFO ketat (#2): Jika operasi paling depan yang masih PENDING belum melewati jadwal backoff-nya,
		// hentikan perulangan (break) agar operasi berikutnya tidak menyalip operasi ini.
		if (!force && rawItem.nextRetryAt !== null && rawItem.nextRetryAt > nowMs) {
			break;
		}

		processed++;
		let item: OfflineQueueItem = {
			...rawItem,
			syncState: 'SYNCING'
		};
		await storage.put(item);

		try {
			// LANGKAH 1: Unggah foto bukti di latar belakang jika ada dan belum terunggah
			if (item.pendingEvidence && !item.pendingEvidence.uploadedEvidenceId) {
				const ev = item.pendingEvidence;
				const evRes = await api.post('/api/v1/evidence', {
					purpose: ev.purpose,
					captureSource: ev.captureSource,
					takenAtDevice: ev.takenAtDevice,
					gpsAvailable: ev.gpsAvailable,
					latitude: ev.latitude,
					longitude: ev.longitude,
					accuracyM: ev.accuracyM,
					isMockLocation: ev.isMockLocation,
					locationId: ev.locationId,
					imageBase64: ev.imageBase64,
					mimeType: ev.mimeType
				});

				if (!evRes.ok) {
					let evErrorBody: ApiErrorShape | null = null;
					try {
						evErrorBody = (await evRes.json()) as ApiErrorShape;
					} catch {
						// Abaikan jika bukan JSON
					}

					const errObj = evErrorBody?.error;
					const errCode = errObj?.code ?? null;

					// Jika error 4xx permanen (validasi foto gagal, mock location diblokir, forbidden), tandai REJECTED
					if (
						evRes.status >= 400 &&
						evRes.status < 500 &&
						evRes.status !== 401 &&
						evRes.status !== 429
					) {
						rejected++;
						const friendlyMsg = formatFriendlyErrorMessage(
							evErrorBody,
							'Foto bukti ditolak oleh server.'
						);
						item = {
							...item,
							syncState: 'REJECTED',
							errorCode: errCode ?? 'VALIDATION_ERROR',
							conflictReason: formatLaymanConflictGuidance(item.type, errCode, friendlyMsg),
							lastError: friendlyMsg,
							nextRetryAt: null
						};
						await storage.put(item);
						continue;
					}

					// Jika error 5xx atau 429, jadwalkan retry dengan exponential backoff
					throw new Error(
						formatFriendlyErrorMessage(
							evErrorBody,
							`Gagal mengunggah foto bukti (HTTP ${evRes.status}).`
						)
					);
				}

				const evData = (await evRes.json()) as { evidence: { id: string } };
				const uploadedEvidenceId = evData.evidence.id;

				// Simpan uploadedEvidenceId terlebih dahulu agar jika langkah /api/v1/sync gagal, foto tidak diunggah dua kali!
				item = {
					...item,
					pendingEvidence: {
						...item.pendingEvidence,
						uploadedEvidenceId
					},
					payload: attachEvidenceIdToPayload(item.type, item.payload, uploadedEvidenceId)
				};
				await storage.put(item);
			} else if (item.pendingEvidence?.uploadedEvidenceId) {
				// Pastikan evidenceId sudah terpasang di payload dari percobaan sebelumnya
				item = {
					...item,
					payload: attachEvidenceIdToPayload(
						item.type,
						item.payload,
						item.pendingEvidence.uploadedEvidenceId
					)
				};
			}

			// LANGKAH 2: Kirim operasi ke POST /api/v1/sync lewat mobileApi
			const syncRes = await api.post('/api/v1/sync', {
				operations: [
					{
						clientOpId: item.clientOpId,
						type: item.type,
						clientCreatedAt: item.clientCreatedAt,
						payload: item.payload
					}
				]
			});

			if (!syncRes.ok) {
				let syncErrBody: ApiErrorShape | null = null;
				try {
					syncErrBody = (await syncRes.json()) as ApiErrorShape;
				} catch {
					// Abaikan
				}
				throw new Error(
					formatFriendlyErrorMessage(
						syncErrBody,
						`Gagal menghubungi layanan sinkronisasi (HTTP ${syncRes.status}).`
					)
				);
			}

			const syncData = (await syncRes.json()) as {
				results?: Array<{
					clientOpId: string;
					status: 'ACCEPTED' | 'CONFLICT' | 'REJECTED';
					conflictReason?: string | null;
					code?: string | null;
					errorCode?: string | null;
					details?: Record<string, unknown> | null;
					data?: Record<string, unknown> | null;
				}>;
			};

			const opResult = syncData.results?.[0];
			if (!opResult) {
				throw new Error('Respons sinkronisasi server tidak memuat hasil operasi.');
			}

			const resolvedCode = opResult.code ?? opResult.errorCode ?? null;

			if (opResult.status === 'ACCEPTED') {
				accepted++;
				// Hapus blob base64 foto dari penyimpanan lokal setelah server mengonfirmasi ACCEPTED (Bagian 10.2)
				item = {
					...item,
					syncState: 'ACCEPTED',
					pendingEvidence: item.pendingEvidence
						? {
								...item.pendingEvidence,
								imageBase64: ''
							}
						: null,
					lastError: null,
					conflictReason: null,
					errorCode: null,
					nextRetryAt: null,
					syncedAt: new Date().toISOString(),
					resultData: opResult.data ?? null
				};
				await storage.put(item);
			} else if (opResult.status === 'CONFLICT') {
				conflicts++;
				const guidance = formatLaymanConflictGuidance(
					item.type,
					resolvedCode,
					opResult.conflictReason
				);
				item = {
					...item,
					syncState: 'CONFLICT',
					errorCode: resolvedCode ?? 'ALREADY_BORROWED_CONFLICT',
					conflictReason: guidance,
					lastError: opResult.conflictReason ?? guidance,
					nextRetryAt: null,
					resultData: opResult.details ?? opResult.data ?? null
				};
				await storage.put(item);
			} else {
				rejected++;
				const guidance = formatLaymanConflictGuidance(
					item.type,
					resolvedCode,
					opResult.conflictReason
				);
				item = {
					...item,
					syncState: 'REJECTED',
					errorCode: resolvedCode ?? 'VALIDATION_ERROR',
					conflictReason: guidance,
					lastError: opResult.conflictReason ?? guidance,
					nextRetryAt: null,
					resultData: opResult.details ?? opResult.data ?? null
				};
				await storage.put(item);
			}
		} catch (err) {
			// Gangguan jaringan (offline / timeout) atau HTTP 5xx -> tetap PENDING dengan retry exponential backoff
			const nextRetryCount = item.retryCount + 1;
			const delayMs = computeBackoffDelayMs(nextRetryCount);
			const errMsg =
				err instanceof Error
					? err.message
					: 'Tidak dapat terhubung ke server. Akan dicoba otomatis saat sinyal kembali.';

			item = {
				...item,
				syncState: 'PENDING',
				retryCount: nextRetryCount,
				nextRetryAt: (options.nowMs ?? Date.now()) + delayMs,
				lastError: errMsg
			};
			await storage.put(item);

			// Aturan FIFO ketat (#2): Berhenti di operasi pertama yang gagal sementara (network / 5xx)
			// agar operasi dependen setelahnya (mis. LOAN_RETURN atau SHIFT_CLOSE) tidak menyalip operasi ini.
			break;
		}
	}

	const updatedItems = await storage.listAll();
	const stillPending = updatedItems.filter(
		(i) => i.syncState === 'PENDING' || i.syncState === 'SYNCING'
	).length;

	return {
		processed,
		accepted,
		conflicts,
		rejected,
		stillPending,
		items: updatedItems
	};
}

export interface MissingShiftAssetInfo {
	assetCode: string;
	assetId?: string;
	loanItemId?: string;
	assetName?: string;
}

/**
 * Mengekstrak daftar barang yang belum memiliki alasan dari operasi SHIFT_CLOSE yang REJECTED.
 */
export function extractMissingShiftCloseAssets(item: OfflineQueueItem): MissingShiftAssetInfo[] {
	if (item.type !== 'SHIFT_CLOSE') return [];

	const details = item.resultData;
	if (details && Array.isArray(details.missingAssets) && details.missingAssets.length > 0) {
		return (details.missingAssets as Array<Record<string, unknown>>).map((m) => ({
			assetCode: String(m.assetCode ?? ''),
			...(typeof m.assetId === 'string' ? { assetId: m.assetId } : {}),
			...(typeof m.loanItemId === 'string' ? { loanItemId: m.loanItemId } : {}),
			...(typeof m.assetName === 'string' ? { assetName: m.assetName } : {})
		}));
	}

	if (details && Array.isArray(details.missingAssetCodes) && details.missingAssetCodes.length > 0) {
		return (details.missingAssetCodes as unknown[]).map((code) => ({
			assetCode: String(code)
		}));
	}

	const msg = `${item.conflictReason ?? ''} ${item.lastError ?? ''}`;
	const parenMatch = /\(([A-Z0-9,\s-]+)\)\s*\(BR-12\)/i.exec(msg);
	if (parenMatch) {
		return parenMatch[1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((assetCode) => ({ assetCode }));
	}

	return [];
}

/**
 * Melengkapi alasan barang keluar yang kurang pada operasi SHIFT_CLOSE yang REJECTED,
 * menggantinya dengan clientOpId baru, lalu mengirim ulang ke server.
 */
export async function retryRejectedShiftCloseWithReasons(
	oldClientOpId: string,
	reasonsByAssetCodeOrId: Record<string, string>,
	options: SyncPendingOptions = {}
): Promise<{ newItem: OfflineQueueItem; outcome: SyncRunOutcome }> {
	const storage = options.storage ?? getOfflineQueueStorage();
	const existing = await storage.getById(oldClientOpId);
	if (!existing || existing.type !== 'SHIFT_CLOSE') {
		throw new Error('Operasi tutup shift yang akan dilengkapi tidak ditemukan.');
	}

	const missingList = extractMissingShiftCloseAssets(existing);
	const rawPrevItems = Array.isArray(existing.payload.items)
		? [...(existing.payload.items as Array<Record<string, unknown>>)]
		: [];

	// Upsert helper (#7): ganti entri lama yang cocok berdasarkan loanItemId, assetId, atau assetCode
	const prevItems = [...rawPrevItems];
	function upsertShiftCloseReasonItem(entry: {
		loanItemId?: string;
		assetId?: string;
		assetCode?: string;
		reason: string;
	}) {
		const normCode = entry.assetCode?.trim().toUpperCase();
		const idx = prevItems.findIndex((it) => {
			const itCode = typeof it.assetCode === 'string' ? it.assetCode.trim().toUpperCase() : '';
			return (
				(entry.loanItemId && it.loanItemId === entry.loanItemId) ||
				(entry.assetId && it.assetId === entry.assetId) ||
				(normCode && itCode === normCode)
			);
		});
		const nextObj: Record<string, unknown> = {
			...(idx >= 0 ? prevItems[idx] : {}),
			...(entry.loanItemId ? { loanItemId: entry.loanItemId } : {}),
			...(entry.assetId ? { assetId: entry.assetId } : {}),
			...(entry.assetCode ? { assetCode: entry.assetCode } : {}),
			reason: entry.reason
		};
		if (idx >= 0) {
			prevItems[idx] = nextObj;
		} else {
			prevItems.push(nextObj);
		}
	}

	for (const missing of missingList) {
		const reasonText = (
			reasonsByAssetCodeOrId[missing.assetCode] ??
			(missing.assetId ? reasonsByAssetCodeOrId[missing.assetId] : undefined) ??
			(missing.loanItemId ? reasonsByAssetCodeOrId[missing.loanItemId] : undefined) ??
			''
		).trim();

		if (reasonText.length >= 3) {
			upsertShiftCloseReasonItem({
				...(missing.loanItemId ? { loanItemId: missing.loanItemId } : {}),
				...(missing.assetId ? { assetId: missing.assetId } : {}),
				assetCode: missing.assetCode,
				reason: reasonText
			});
		}
	}

	// Tambahkan atau perbarui juga alasan dari map berdasarkan key
	for (const [key, val] of Object.entries(reasonsByAssetCodeOrId)) {
		const trimmed = val.trim();
		if (trimmed.length < 3) continue;
		const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
		upsertShiftCloseReasonItem({
			...(isUuid ? { assetId: key } : { assetCode: key }),
			reason: trimmed
		});
	}

	await storage.remove(oldClientOpId);

	const newItem = await enqueueOfflineOperation(
		{
			type: 'SHIFT_CLOSE',
			label: existing.label,
			clientCreatedAt: existing.clientCreatedAt,
			payload: {
				...existing.payload,
				items: prevItems
			},
			pendingEvidence: existing.pendingEvidence
		},
		storage
	);

	const outcome = await syncPendingOperations({
		...options,
		storage,
		force: true
	});

	const updatedNewItem = (await storage.getById(newItem.clientOpId)) ?? newItem;
	return {
		newItem: updatedNewItem,
		outcome
	};
}
