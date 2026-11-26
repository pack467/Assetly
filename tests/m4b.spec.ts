import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMobileApiClient } from '../src/lib/client/api';
import { createMemoryTokenStorage, setTokenStorage } from '../src/lib/client/tokenStorage';
import {
	clearCachedAssets,
	computeOfflineQueueSummary,
	createIndexedDbOfflineQueueStorage,
	createMemoryOfflineQueueStorage,
	findCachedAssetByCodeOrQr,
	getCachedAssetsList,
	listQueueItemsForUser,
	saveCachedAssetScanPayload,
	saveCachedAssetsList,
	setOfflineQueueStorage,
	subscribeOfflineQueue,
	type OfflineQueueStorage
} from '../src/lib/client/offlineQueue';
import {
	attemptMobileLogout,
	computeBackoffDelayMs,
	enqueueOfflineOperation,
	extractMissingShiftCloseAssets,
	isOperationStuck,
	retryRejectedShiftCloseWithReasons,
	STUCK_OPERATION_RETRY_THRESHOLD,
	syncPendingOperations
} from '../src/lib/client/syncManager';

function collectFilesRecursively(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			results.push(...collectFilesRecursively(full));
		} else {
			results.push(full);
		}
	}
	return results;
}

describe('M4 Tahap 4B: Antrean Operasi Offline (/m/*), Unggah Foto Latar Belakang dengan Retry, & Resolusi Konflik (/m/sync)', () => {
	let queueStorage: OfflineQueueStorage;

	beforeEach(() => {
		queueStorage = createMemoryOfflineQueueStorage();
		setOfflineQueueStorage(queueStorage);
		clearCachedAssets();
	});

	it('1. menyimpan operasi ke antrean lokal, menghitung ringkasan status, dan memicu notifikasi reaktif UI', async () => {
		let changeEvents = 0;
		const unsubscribe = subscribeOfflineQueue(() => {
			changeEvents++;
		});

		const item = await enqueueOfflineOperation(
			{
				type: 'LOAN_CREATE',
				label: 'Pinjam AST-0001 (Laptop Dell Latitude)',
				assetCode: 'AST-0001',
				assetName: 'Laptop Dell Latitude',
				payload: {
					purpose: 'Seminar',
					expectedReturnAt: new Date(Date.now() + 86400_000).toISOString(),
					items: [{ assetId: '00000000-0000-4000-8000-000000000001' }]
				},
				pendingEvidence: {
					purpose: 'CHECKOUT',
					captureSource: 'CAMERA',
					takenAtDevice: new Date().toISOString(),
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8,
					accuracyM: 12,
					isMockLocation: false,
					locationId: null,
					imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
					mimeType: 'image/jpeg'
				}
			},
			queueStorage
		);

		expect(item.syncState).toBe('PENDING');
		expect(item.retryCount).toBe(0);
		expect(changeEvents).toBeGreaterThanOrEqual(1);

		const summary = await computeOfflineQueueSummary(queueStorage);
		expect(summary.pendingCount).toBe(1);
		expect(summary.totalCount).toBe(1);

		unsubscribe();
	});

	it('2. menahan operasi tetap PENDING dengan exponential backoff saat offline, lalu mengunggah foto dan menyinkronkan otomatis saat kembali online', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		let isNetworkOnline = false;
		const calls: Array<{ url: string; body: unknown }> = [];

		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (!isNetworkOnline) {
				throw new TypeError('Failed to fetch (Offline simulation)');
			}
			const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
			calls.push({ url, body: parsedBody });

			if (url.endsWith('/api/v1/evidence')) {
				return new Response(
					JSON.stringify({
						evidence: {
							id: '11111111-2222-4333-8444-555555555555'
						}
					}),
					{ status: 201, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.endsWith('/api/v1/sync')) {
				const op = parsedBody.operations[0];
				return new Response(
					JSON.stringify({
						results: [
							{
								clientOpId: op.clientOpId,
								status: 'ACCEPTED',
								idempotentReplay: false,
								conflictReason: null,
								data: { loan: { id: 'loan-123', status: 'ACTIVE' } }
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const queued = await enqueueOfflineOperation(
			{
				type: 'LOAN_CREATE',
				label: 'Pinjam AST-0002 (Proyektor Epson)',
				assetCode: 'AST-0002',
				assetName: 'Proyektor Epson',
				payload: {
					purpose: 'Kuliah',
					expectedReturnAt: new Date(Date.now() + 86400_000).toISOString(),
					items: [{ assetId: '00000000-0000-4000-8000-000000000002' }]
				},
				pendingEvidence: {
					purpose: 'CHECKOUT',
					captureSource: 'CAMERA',
					takenAtDevice: new Date().toISOString(),
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8,
					accuracyM: 10,
					isMockLocation: false,
					locationId: null,
					imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
					mimeType: 'image/jpeg'
				}
			},
			queueStorage
		);

		// A. Percobaan pertama saat masih offline -> tetap PENDING, retryCount naik jadi 1, nextRetryAt terjadwal
		const t0 = 1_700_000_000_000;
		const offlineOutcome = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			nowMs: t0
		});
		expect(offlineOutcome.accepted).toBe(0);
		expect(offlineOutcome.stillPending).toBe(1);

		const afterOffline = await queueStorage.getById(queued.clientOpId);
		expect(afterOffline?.syncState).toBe('PENDING');
		expect(afterOffline?.retryCount).toBe(1);
		expect(afterOffline?.nextRetryAt).toBe(t0 + computeBackoffDelayMs(1));

		// B. Sinyal kembali online -> unggah foto di latar belakang diikuti POST /api/v1/sync
		isNetworkOnline = true;
		const onlineOutcome = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(onlineOutcome.accepted).toBe(1);
		expect(onlineOutcome.stillPending).toBe(0);

		// Pastikan urutan panggilan: 1) POST /api/v1/evidence, 2) POST /api/v1/sync dengan checkoutEvidenceId terpasang
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toContain('/api/v1/evidence');
		expect(calls[1].url).toContain('/api/v1/sync');

		const syncReqBody = calls[1].body as {
			operations: Array<{ payload: { items: Array<{ checkoutEvidenceId: string }> } }>;
		};
		expect(syncReqBody.operations[0].payload.items[0].checkoutEvidenceId).toBe(
			'11111111-2222-4333-8444-555555555555'
		);

		// Pastikan status item di antrean menjadi ACCEPTED dan blob imageBase64 sudah dibersihkan untuk menghemat memori HP (Bagian 10.2)
		const afterOnline = await queueStorage.getById(queued.clientOpId);
		expect(afterOnline?.syncState).toBe('ACCEPTED');
		expect(afterOnline?.pendingEvidence?.uploadedEvidenceId).toBe(
			'11111111-2222-4333-8444-555555555555'
		);
		expect(afterOnline?.pendingEvidence?.imageBase64).toBe('');
	});

	it('3. tidak mengunggah ulang foto bukti bila unggah foto sudah berhasil tetapi panggilan /api/v1/sync terputus di tengah jalan', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		let evidenceUploadCalls = 0;
		let syncCalls = 0;
		let shouldFailSyncCall = true;

		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith('/api/v1/evidence')) {
				evidenceUploadCalls++;
				return new Response(
					JSON.stringify({
						evidence: {
							id: '99999999-8888-4777-8666-555555555555'
						}
					}),
					{ status: 201, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.endsWith('/api/v1/sync')) {
				syncCalls++;
				if (shouldFailSyncCall) {
					throw new TypeError('Network dropped right after photo upload');
				}
				const parsedBody = JSON.parse(String(init?.body));
				const op = parsedBody.operations[0];
				return new Response(
					JSON.stringify({
						results: [
							{
								clientOpId: op.clientOpId,
								status: 'ACCEPTED',
								idempotentReplay: false,
								conflictReason: null
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const queued = await enqueueOfflineOperation(
			{
				type: 'LOAN_RETURN',
				label: 'Kembalikan AST-0003 (Kamera Sony)',
				assetCode: 'AST-0003',
				assetName: 'Kamera Sony',
				payload: {
					loanItemId: '22222222-3333-4444-8555-666666666666',
					returnCondition: 'NORMAL'
				},
				pendingEvidence: {
					purpose: 'RETURN',
					captureSource: 'CAMERA',
					takenAtDevice: new Date().toISOString(),
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8,
					accuracyM: 8,
					isMockLocation: false,
					locationId: null,
					imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
					mimeType: 'image/jpeg'
				}
			},
			queueStorage
		);

		// Percobaan 1: Unggah foto berhasil, namun /api/v1/sync gagal karena sinyal putus
		const run1 = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(run1.accepted).toBe(0);
		expect(run1.stillPending).toBe(1);
		expect(evidenceUploadCalls).toBe(1);
		expect(syncCalls).toBe(1);

		const midItem = await queueStorage.getById(queued.clientOpId);
		expect(midItem?.pendingEvidence?.uploadedEvidenceId).toBe(
			'99999999-8888-4777-8666-555555555555'
		);

		// Percobaan 2: Sinyal pulih -> TIDAK boleh memanggil /api/v1/evidence lagi, langsung memanggil /api/v1/sync
		shouldFailSyncCall = false;
		const run2 = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(run2.accepted).toBe(1);
		expect(evidenceUploadCalls).toBe(1); // Tetap 1 kali!
		expect(syncCalls).toBe(2);

		const finalItem = await queueStorage.getById(queued.clientOpId);
		expect(finalItem?.syncState).toBe('ACCEPTED');
		expect(finalItem?.payload.evidenceId).toBe('99999999-8888-4777-8666-555555555555');
	});

	it('4. menandai operasi CONFLICT dan memberikan panduan bahasa Indonesia yang jelas saat barang sudah dipinjam orang lain ketika offline', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith('/api/v1/sync')) {
				const parsedBody = JSON.parse(String(init?.body));
				const op = parsedBody.operations[0];
				return new Response(
					JSON.stringify({
						results: [
							{
								clientOpId: op.clientOpId,
								status: 'CONFLICT',
								idempotentReplay: false,
								errorCode: 'ALREADY_BORROWED_CONFLICT',
								conflictReason:
									'Konflik peminjaman: barang "AST-0009 - Laptop MacBook" sudah dipinjam pengguna lain.'
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const queued = await enqueueOfflineOperation(
			{
				type: 'LOAN_CREATE',
				label: 'Pinjam AST-0009 (Laptop MacBook)',
				assetCode: 'AST-0009',
				assetName: 'Laptop MacBook',
				payload: {
					purpose: 'Liputan',
					expectedReturnAt: new Date(Date.now() + 86400_000).toISOString(),
					items: [
						{
							assetId: '00000000-0000-4000-8000-000000000009',
							checkoutEvidenceId: '11111111-1111-4111-8111-111111111111'
						}
					]
				}
			},
			queueStorage
		);

		const outcome = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(outcome.conflicts).toBe(1);
		expect(outcome.stillPending).toBe(0);

		const conflicted = await queueStorage.getById(queued.clientOpId);
		expect(conflicted?.syncState).toBe('CONFLICT');
		expect(conflicted?.errorCode).toBe('ALREADY_BORROWED_CONFLICT');
		expect(conflicted?.nextRetryAt).toBeNull();
		expect(conflicted?.conflictReason).toContain('pilih barang lain');
	});

	it('5. memastikan seluruh kode /m/* (termasuk /m/sync) bebas dari fetch() langsung dan tanpa +page.server.ts', () => {
		const mobileRoutesDir = join(process.cwd(), 'src', 'routes', 'm');
		const files = collectFilesRecursively(mobileRoutesDir);

		expect(
			files.some((f) => f.endsWith('sync\\+page.svelte') || f.endsWith('sync/+page.svelte'))
		).toBe(true);

		for (const file of files) {
			expect(file.endsWith('+page.server.ts')).toBe(false);
			expect(file.endsWith('+layout.server.ts')).toBe(false);
			const content = readFileSync(file, 'utf8');
			expect(content).not.toMatch(/\bfetch\s*\(/);
		}
	});

	it('6. menyinkronkan HANDOVER_CREATE (dengan foto bukti ber-GPS) serta SHIFT_OPEN dan SHIFT_CLOSE lewat antrean offline', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			const parsedBody = init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
			calls.push({ url, body: parsedBody });

			if (url.endsWith('/api/v1/evidence')) {
				return new Response(
					JSON.stringify({
						evidence: {
							id: '77777777-6666-4555-8444-333333333333'
						}
					}),
					{ status: 201, headers: { 'Content-Type': 'application/json' } }
				);
			}

			if (url.endsWith('/api/v1/sync')) {
				const ops = parsedBody.operations as Array<{ clientOpId: string; type: string }>;
				return new Response(
					JSON.stringify({
						results: ops.map((op) => ({
							clientOpId: op.clientOpId,
							status: 'ACCEPTED',
							idempotentReplay: false,
							conflictReason: null
						}))
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}

			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const handoverOp = await enqueueOfflineOperation(
			{
				type: 'HANDOVER_CREATE',
				label: 'Serah Terima AST-0001 ke Peminjam 2',
				assetCode: 'AST-0001',
				assetName: 'Laptop Dell',
				clientCreatedAt: '2026-11-25T10:00:00.000Z',
				payload: {
					loanId: '11111111-1111-4111-8111-111111111111',
					receiverId: '22222222-2222-4222-8222-222222222222',
					autoConfirmGiver: true
				},
				pendingEvidence: {
					purpose: 'HANDOVER',
					captureSource: 'CAMERA',
					takenAtDevice: '2026-11-25T10:00:00.000Z',
					gpsAvailable: true,
					latitude: -6.2001,
					longitude: 106.8167,
					accuracyM: 9,
					isMockLocation: false,
					locationId: '33333333-3333-4333-8333-333333333333',
					imageBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
					mimeType: 'image/jpeg'
				}
			},
			queueStorage
		);

		const shiftOpenOp = await enqueueOfflineOperation(
			{
				type: 'SHIFT_OPEN',
				label: 'Buka Shift Kerja Petugas',
				clientCreatedAt: '2026-11-25T10:01:00.000Z',
				payload: {
					note: 'Shift Pagi'
				}
			},
			queueStorage
		);

		const shiftCloseOp = await enqueueOfflineOperation(
			{
				type: 'SHIFT_CLOSE',
				label: 'Tutup Shift Kerja (1 barang keluar)',
				clientCreatedAt: '2026-11-25T10:02:00.000Z',
				payload: {
					shiftId: '44444444-4444-4444-8444-444444444444',
					note: 'Tutup shift sore',
					items: [
						{
							loanItemId: '55555555-5555-4555-8555-555555555555',
							reason: 'Masih dipakai seminar malam',
							responsibleUserId: '22222222-2222-4222-8222-222222222222'
						}
					]
				}
			},
			queueStorage
		);

		const outcome = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(outcome.accepted).toBe(3);

		// Pastikan unggah foto bukti HANDOVER menyertakan koordinat GPS asli (gpsAvailable: true)
		const evCall = calls.find((c) => c.url.endsWith('/api/v1/evidence'));
		expect(evCall).toBeDefined();
		expect(evCall?.body.purpose).toBe('HANDOVER');
		expect(evCall?.body.gpsAvailable).toBe(true);
		expect(evCall?.body.latitude).toBe(-6.2001);
		expect(evCall?.body.longitude).toBe(106.8167);

		// Pastikan HANDOVER_CREATE menerima evidenceId dari hasil unggah foto latar belakang
		const syncedHo = await queueStorage.getById(handoverOp.clientOpId);
		expect(syncedHo?.syncState).toBe('ACCEPTED');
		expect(syncedHo?.payload.evidenceId).toBe('77777777-6666-4555-8444-333333333333');

		const syncedOpen = await queueStorage.getById(shiftOpenOp.clientOpId);
		expect(syncedOpen?.syncState).toBe('ACCEPTED');

		const syncedClose = await queueStorage.getById(shiftCloseOp.clientOpId);
		expect(syncedClose?.syncState).toBe('ACCEPTED');
	});

	it('7. menampilkan kode barang yang belum punya alasan saat SHIFT_CLOSE ditolak (REJECTED) dan berhasil mengirim ulang setelah alasan dilengkapi di /m/sync (Lapis 1)', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		let attempt = 0;
		const sentPayloads: Array<Record<string, unknown>> = [];

		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith('/api/v1/sync')) {
				attempt++;
				const parsedBody = JSON.parse(String(init?.body)) as {
					operations: Array<{ clientOpId: string; payload: Record<string, unknown> }>;
				};
				const op = parsedBody.operations[0];
				sentPayloads.push(op.payload);

				if (attempt === 1) {
					return new Response(
						JSON.stringify({
							results: [
								{
									clientOpId: op.clientOpId,
									status: 'REJECTED',
									code: 'VALIDATION_ERROR',
									conflictReason:
										'Terdapat 1 barang yang masih keluar dan wajib diberi alasan sebelum menutup shift (AST-0099) (BR-12).',
									details: {
										missingAssetCodes: ['AST-0099'],
										missingAssets: [
											{
												assetCode: 'AST-0099',
												assetId: '99999999-9999-4999-8999-999999999999',
												assetName: 'Proyektor Aula Utama'
											}
										]
									}
								}
							]
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } }
					);
				}

				return new Response(
					JSON.stringify({
						results: [
							{
								clientOpId: op.clientOpId,
								status: 'ACCEPTED',
								idempotentReplay: false,
								conflictReason: null
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const initialClose = await enqueueOfflineOperation(
			{
				type: 'SHIFT_CLOSE',
				label: 'Tutup Shift Sore',
				clientCreatedAt: '2026-11-25T16:30:00.000Z',
				payload: {
					shiftId: '44444444-4444-4444-8444-444444444444',
					items: [
						{
							assetCode: 'AST-0099',
							reason: 'x'
						}
					]
				}
			},
			queueStorage
		);

		// 1. Percobaan pertama ditolak karena AST-0099 belum punya alasan
		const run1 = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(run1.rejected).toBe(1);

		const rejectedItem = await queueStorage.getById(initialClose.clientOpId);
		expect(rejectedItem?.syncState).toBe('REJECTED');
		expect(rejectedItem?.conflictReason).toContain('AST-0099');

		const missingAssets = extractMissingShiftCloseAssets(rejectedItem!);
		expect(missingAssets).toHaveLength(1);
		expect(missingAssets[0].assetCode).toBe('AST-0099');

		// 2. Petugas melengkapi alasan untuk AST-0099 di layar /m/sync lalu mengirim ulang
		const { newItem, outcome } = await retryRejectedShiftCloseWithReasons(
			initialClose.clientOpId,
			{
				'AST-0099': 'Masih dipakai acara wisuda di Aula Utama'
			},
			{
				apiClient,
				storage: queueStorage
			}
		);

		expect(outcome.accepted).toBe(1);
		expect(newItem.syncState).toBe('ACCEPTED');
		expect(newItem.clientOpId).not.toBe(initialClose.clientOpId);
		// #7: clientCreatedAt asli wajib dipertahankan dan item lama AST-0099 diganti (upsert, bukan duplikat)
		expect(newItem.clientCreatedAt).toBe('2026-11-25T16:30:00.000Z');

		const secondItems = sentPayloads[1].items as Array<{
			assetCode: string;
			assetId: string;
			reason: string;
		}>;
		expect(secondItems).toHaveLength(1);
		expect(secondItems[0]).toMatchObject({
			assetCode: 'AST-0099',
			assetId: '99999999-9999-4999-8999-999999999999',
			reason: 'Masih dipakai acara wisuda di Aula Utama'
		});
	});

	it('8. menjaga urutan FIFO ketat (berhenti di operasi pertama yang gagal sementara/backoff) serta mendeteksi operasi macet (#2 + #10)', async () => {
		const tokenStorage = createMemoryTokenStorage({
			accessToken: 'valid-access-token',
			refreshToken: 'valid-refresh-token'
		});

		let failFirstOperation = true;
		const sentOpIds: string[] = [];

		const mockFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith('/api/v1/sync')) {
				const parsedBody = JSON.parse(String(init?.body)) as {
					operations: Array<{ clientOpId: string; type: string }>;
				};
				const op = parsedBody.operations[0];
				sentOpIds.push(op.clientOpId);

				if (op.type === 'LOAN_CREATE' && failFirstOperation) {
					return new Response(
						JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Gateway timeout 503' } }),
						{ status: 503, headers: { 'Content-Type': 'application/json' } }
					);
				}

				return new Response(
					JSON.stringify({
						results: [
							{
								clientOpId: op.clientOpId,
								status: 'ACCEPTED',
								idempotentReplay: false,
								conflictReason: null
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('{}', { status: 404 });
		};

		const apiClient = createMobileApiClient({
			baseUrl: 'http://localhost:5173',
			storage: tokenStorage,
			fetchFn: mockFetch
		});

		const opBorrow = await enqueueOfflineOperation(
			{
				type: 'LOAN_CREATE',
				label: 'Pinjam AST-0010 (Laptop Lenovo)',
				clientCreatedAt: '2026-11-26T01:00:00.000Z',
				payload: {
					purpose: 'Rapat',
					expectedReturnAt: '2026-11-27T01:00:00.000Z',
					items: [
						{
							assetId: '10101010-1010-4010-8010-101010101010',
							checkoutEvidenceId: '20202020-2020-4020-8020-202020202020'
						}
					]
				}
			},
			queueStorage
		);

		const opReturn = await enqueueOfflineOperation(
			{
				type: 'LOAN_RETURN',
				label: 'Kembalikan AST-0010 (Laptop Lenovo)',
				clientCreatedAt: '2026-11-26T01:05:00.000Z',
				payload: {
					assetId: '10101010-1010-4010-8010-101010101010',
					returnCondition: 'NORMAL',
					evidenceId: '30303030-3030-4030-8030-303030303030'
				}
			},
			queueStorage
		);

		const baseNow = 1_700_000_000_000;

		// 1. Saat operasi pertama (LOAN_CREATE) gagal sementara (HTTP 503), operasi kedua (LOAN_RETURN) TIDAK boleh dikirim
		const run1 = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			nowMs: baseNow
		});
		expect(run1.processed).toBe(1);
		expect(run1.accepted).toBe(0);
		expect(run1.stillPending).toBe(2);
		expect(sentOpIds).toEqual([opBorrow.clientOpId]);

		// 2. Saat tick berikutnya berjalan sebelum jadwal backoff operasi pertama habis (tanpa force), operasi kedua tetap TIDAK boleh menyalip
		const runDuringBackoff = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			nowMs: baseNow + 500
		});
		expect(runDuringBackoff.processed).toBe(0);
		expect(sentOpIds).toEqual([opBorrow.clientOpId]);

		// 3. Simulasikan kegagalan berulang hingga mencapai STUCK_OPERATION_RETRY_THRESHOLD (5x)
		for (let i = 2; i <= STUCK_OPERATION_RETRY_THRESHOLD; i++) {
			await syncPendingOperations({
				apiClient,
				storage: queueStorage,
				force: true,
				nowMs: baseNow + i * 60_000
			});
		}

		const stuckBorrow = await queueStorage.getById(opBorrow.clientOpId);
		expect(stuckBorrow?.retryCount).toBe(STUCK_OPERATION_RETRY_THRESHOLD);
		expect(isOperationStuck(stuckBorrow!)).toBe(true);

		const waitingReturn = await queueStorage.getById(opReturn.clientOpId);
		expect(waitingReturn?.retryCount).toBe(0);
		expect(isOperationStuck(waitingReturn!)).toBe(false);

		// 4. Begitu masalah jaringan/server teratasi (atau operasi macet berhasil/dibatalkan), antrean berlanjut berurutan
		failFirstOperation = false;
		const runRecovered = await syncPendingOperations({
			apiClient,
			storage: queueStorage,
			force: true
		});
		expect(runRecovered.accepted).toBe(2);
		expect(runRecovered.stillPending).toBe(0);
	});

	it('9. menyediakan cache daftar barang dan detail scan untuk pencarian offline berdasarkan kode, qrToken, atau nomor seri (#3)', () => {
		saveCachedAssetsList([
			{
				id: 'a-100',
				code: 'AST-0100',
				qrToken: 'qr-secret-token-100',
				name: 'Laptop ThinkPad X1',
				status: 'AVAILABLE',
				serialNumber: 'SN-X1-9988',
				category: {
					id: 'cat-1',
					name: 'Laptop',
					requiresApproval: false
				},
				homeLocation: {
					id: 'loc-1',
					name: 'Gudang IT'
				},
				accessories: [{ id: 'acc-1', name: 'Charger 65W', quantity: 1 }]
			}
		]);

		expect(getCachedAssetsList()).toHaveLength(1);

		// 1. Pencarian offline lewat kode barang (case-insensitive)
		const byCode = findCachedAssetByCodeOrQr('ast-0100');
		expect(byCode).not.toBeNull();
		expect(byCode?.asset.code).toBe('AST-0100');
		expect(byCode?.allowedActions).toContain('BORROW');

		// 2. Pencarian offline lewat qrToken
		const byQr = findCachedAssetByCodeOrQr('qr-secret-token-100');
		expect(byQr).not.toBeNull();
		expect(byQr?.asset.name).toBe('Laptop ThinkPad X1');

		// 3. Pencarian offline lewat nomor seri
		const bySerial = findCachedAssetByCodeOrQr('sn-x1-9988');
		expect(bySerial).not.toBeNull();
		expect(bySerial?.asset.id).toBe('a-100');

		// 4. Menyimpan detail scan penuh mengutamakan data scan terbaru
		saveCachedAssetScanPayload({
			asset: {
				id: 'a-100',
				code: 'AST-0100',
				qrToken: 'qr-secret-token-100',
				name: 'Laptop ThinkPad X1',
				status: 'BORROWED',
				serialNumber: 'SN-X1-9988',
				notes: null,
				category: { id: 'cat-1', name: 'Laptop', requiresApproval: false },
				homeLocation: { id: 'loc-1', name: 'Gudang IT' },
				accessories: []
			},
			allowedActions: ['RETURN'],
			currentHolder: 'Budi',
			requiresApproval: false,
			activeLoanItem: {
				id: 'li-100',
				loanId: 'loan-100',
				borrowerId: 'u-budi',
				purpose: 'Seminar',
				expectedReturnAt: '2026-11-27T10:00:00.000Z',
				accessoryChecks: []
			}
		});

		const updatedFromScanCache = findCachedAssetByCodeOrQr('AST-0100');
		expect(updatedFromScanCache?.asset.status).toBe('BORROWED');
		expect(updatedFromScanCache?.activeLoanItem?.id).toBe('li-100');
	});

	it('10. mengisolasi antrean offline per userId di perangkat bersama, melindungi operasi pengguna lain, mewajibkan konfirmasi tegas saat logout dengan operasi PENDING, dan membersihkan semua cache sessionStorage saat logout atau sesi ditolak server (#1)', async () => {
		// Siapkan mock window.sessionStorage untuk memverifikasi pembersihan seluruh cache sesi
		const mockSessionMap = new Map<string, string>();
		const mockSessionStorage = {
			get length() {
				return mockSessionMap.size;
			},
			key(index: number) {
				return Array.from(mockSessionMap.keys())[index] ?? null;
			},
			getItem(k: string) {
				return mockSessionMap.get(k) ?? null;
			},
			setItem(k: string, v: string) {
				mockSessionMap.set(k, String(v));
			},
			removeItem(k: string) {
				mockSessionMap.delete(k);
			},
			clear() {
				mockSessionMap.clear();
			}
		};
		const prevWindow = (globalThis as unknown as { window?: unknown }).window;
		(globalThis as unknown as { window: unknown }).window = {
			sessionStorage: mockSessionStorage
		};

		try {
			// 1. Pengguna A login dan membuat operasi offline + mengisi berbagai cache sessionStorage
			const tokenStorageUserA = createMemoryTokenStorage(
				{ accessToken: 'token-user-a', refreshToken: 'refresh-user-a' },
				{
					id: 'user-a-id',
					name: 'Petugas A',
					email: 'a@itam.local',
					role: 'OFFICER',
					isActive: true
				}
			);
			setTokenStorage(tokenStorageUserA);

			mockSessionStorage.setItem('itam_my_loans_cache', '[{"id":"loan-a"}]');
			mockSessionStorage.setItem('itam_handovers_cache', '{"currentUserId":"user-a-id"}');
			mockSessionStorage.setItem('itam_shift_state_cache', '{"currentShift":{"id":"shift-a"}}');
			mockSessionStorage.setItem('itam_user_name_cache', 'Petugas A');
			mockSessionStorage.setItem('itam_locations_cache', '[{"id":"loc-1"}]');
			mockSessionStorage.setItem('itam_asset_cache_AST-0001', '{"asset":{"code":"AST-0001"}}');
			saveCachedAssetsList([
				{
					id: 'a-1',
					code: 'AST-0001',
					name: 'Laptop A',
					status: 'AVAILABLE',
					serialNumber: null
				}
			]);

			const opUserA = await enqueueOfflineOperation(
				{
					type: 'LOAN_CREATE',
					label: 'Pinjam AST-0001 oleh Petugas A',
					assetCode: 'AST-0001',
					clientCreatedAt: '2026-11-26T05:00:00.000Z',
					payload: {
						purpose: 'Tugas A',
						expectedReturnAt: '2026-11-27T05:00:00.000Z',
						items: [
							{
								assetId: '00000000-0000-4000-8000-000000000001',
								checkoutEvidenceId: '11111111-1111-4111-8111-111111111111'
							}
						]
					}
				},
				queueStorage
			);
			expect(opUserA.userId).toBe('user-a-id');

			const syncedOpIds: Array<{ clientOpId: string; authHeader: string | null }> = [];
			const mockFetch: typeof fetch = async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers ?? {});
				const authHeader = headers.get('authorization');

				if (url.endsWith('/api/v1/auth/logout')) {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}

				if (url.endsWith('/api/v1/sync')) {
					const parsed = JSON.parse(String(init?.body)) as {
						operations: Array<{ clientOpId: string }>;
					};
					const op = parsed.operations[0];
					syncedOpIds.push({ clientOpId: op.clientOpId, authHeader });
					return new Response(
						JSON.stringify({
							results: [
								{
									clientOpId: op.clientOpId,
									status: 'ACCEPTED',
									idempotentReplay: false,
									conflictReason: null
								}
							]
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } }
					);
				}

				return new Response('{}', { status: 404 });
			};

			const apiUserA = createMobileApiClient({
				baseUrl: 'http://localhost:5173',
				storage: tokenStorageUserA,
				fetchFn: mockFetch
			});

			// 2. Percobaan logout Pengguna A tanpa konfirmasi tegas saat masih ada operasi PENDING wajib ditahan
			const firstLogoutAttempt = await attemptMobileLogout({
				confirmWithPending: false,
				apiClient: apiUserA,
				storage: queueStorage
			});
			expect(firstLogoutAttempt.loggedOut).toBe(false);
			expect(firstLogoutAttempt.requiresConfirmation).toBe(true);
			expect(firstLogoutAttempt.pendingCount).toBe(1);
			// Token Pengguna A belum dihapus karena logout ditahan
			expect(await tokenStorageUserA.getTokens()).not.toBeNull();

			// 3. Pengguna A memberikan konfirmasi tegas untuk tetap keluar
			const confirmedLogout = await attemptMobileLogout({
				confirmWithPending: true,
				apiClient: apiUserA,
				storage: queueStorage
			});
			expect(confirmedLogout.loggedOut).toBe(true);
			expect(await tokenStorageUserA.getTokens()).toBeNull();

			// Seluruh cache sessionStorage sesi Pengguna A wajib sudah bersih
			expect(mockSessionStorage.getItem('itam_my_loans_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_handovers_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_shift_state_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_user_name_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_locations_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_asset_cache_AST-0001')).toBeNull();
			expect(getCachedAssetsList()).toHaveLength(0);

			// Namun operasi PENDING milik Pengguna A tetap tersimpan utuh di storage antrean!
			expect(await queueStorage.getById(opUserA.clientOpId)).not.toBeNull();

			// 4. Pengguna B login di HP yang sama
			const tokenStorageUserB = createMemoryTokenStorage(
				{ accessToken: 'token-user-b', refreshToken: 'refresh-user-b' },
				{
					id: 'user-b-id',
					name: 'Peminjam B',
					email: 'b@itam.local',
					role: 'BORROWER',
					isActive: true
				}
			);
			setTokenStorage(tokenStorageUserB);
			const apiUserB = createMobileApiClient({
				baseUrl: 'http://localhost:5173',
				storage: tokenStorageUserB,
				fetchFn: mockFetch
			});

			// Pengguna B TIDAK boleh melihat operasi milik Pengguna A
			const listForBBefore = await listQueueItemsForUser(queueStorage);
			expect(listForBBefore).toHaveLength(0);
			const summaryForBBefore = await computeOfflineQueueSummary(queueStorage);
			expect(summaryForBBefore.totalCount).toBe(0);
			expect(summaryForBBefore.pendingCount).toBe(0);

			// Pengguna B membuat operasinya sendiri lalu menjalankan sinkronisasi
			const opUserB = await enqueueOfflineOperation(
				{
					type: 'LOAN_CREATE',
					label: 'Pinjam AST-0002 oleh Peminjam B',
					assetCode: 'AST-0002',
					clientCreatedAt: '2026-11-26T05:10:00.000Z',
					payload: {
						purpose: 'Tugas B',
						expectedReturnAt: '2026-11-27T05:10:00.000Z',
						items: [
							{
								assetId: '00000000-0000-4000-8000-000000000002',
								checkoutEvidenceId: '22222222-2222-4222-8222-222222222222'
							}
						]
					}
				},
				queueStorage
			);
			expect(opUserB.userId).toBe('user-b-id');

			const outcomeB = await syncPendingOperations({
				apiClient: apiUserB,
				storage: queueStorage,
				force: true
			});
			// Hanya operasi Pengguna B yang dikirim dengan token Pengguna B!
			expect(outcomeB.processed).toBe(1);
			expect(outcomeB.accepted).toBe(1);
			expect(syncedOpIds).toEqual([
				{ clientOpId: opUserB.clientOpId, authHeader: 'Bearer token-user-b' }
			]);

			// Pengguna B membersihkan riwayat ACCEPTED miliknya -> operasi Pengguna A tetap utuh
			await queueStorage.clearByStates(['ACCEPTED']);
			expect(await queueStorage.getById(opUserB.clientOpId)).toBeNull();
			const untouchedOpA = await queueStorage.getById(opUserA.clientOpId);
			expect(untouchedOpA?.syncState).toBe('PENDING');

			// 5. Pengguna A login kembali di HP tersebut -> operasinya kembali tampil dan berhasil disinkronkan
			await tokenStorageUserA.setTokens({
				accessToken: 'token-user-a-relogin',
				refreshToken: 'refresh-user-a-relogin'
			});
			await tokenStorageUserA.setCachedProfile?.({
				id: 'user-a-id',
				name: 'Petugas A',
				email: 'a@itam.local',
				role: 'OFFICER',
				isActive: true
			});
			setTokenStorage(tokenStorageUserA);

			const listForARelogin = await listQueueItemsForUser(queueStorage);
			expect(listForARelogin).toHaveLength(1);
			expect(listForARelogin[0].clientOpId).toBe(opUserA.clientOpId);

			const outcomeA = await syncPendingOperations({
				apiClient: apiUserA,
				storage: queueStorage,
				force: true
			});
			expect(outcomeA.accepted).toBe(1);
			expect(syncedOpIds[1]).toEqual({
				clientOpId: opUserA.clientOpId,
				authHeader: 'Bearer token-user-a-relogin'
			});

			// 6. Verifikasi penolakan sesi oleh server (401 pada refresh) juga membersihkan seluruh cache sessionStorage
			mockSessionStorage.setItem('itam_my_loans_cache', '[{"id":"loan-stale"}]');
			mockSessionStorage.setItem('itam_shift_state_cache', '{"currentShift":{"id":"shift-stale"}}');

			const rejectedFetch: typeof fetch = async () =>
				new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Revoked' } }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			const apiRejected = createMobileApiClient({
				baseUrl: 'http://localhost:5173',
				storage: tokenStorageUserA,
				fetchFn: rejectedFetch
			});

			const resolvedAfterRevoke = await apiRejected.resolveSessionUser();
			expect(resolvedAfterRevoke.user).toBeNull();
			expect(mockSessionStorage.getItem('itam_my_loans_cache')).toBeNull();
			expect(mockSessionStorage.getItem('itam_shift_state_cache')).toBeNull();
		} finally {
			(globalThis as unknown as { window?: unknown }).window = prevWindow;
		}
	});

	it('11. melempar error jujur saat IndexedDB tersedia tetapi gagal menulis (mis. QuotaExceededError), dan hanya memakai fallback memori ketika IndexedDB tidak didukung (#2)', async () => {
		const prevIndexedDb = (globalThis as unknown as { indexedDB?: unknown }).indexedDB;

		try {
			// A. Saat IndexedDB tidak didukung sama sekali (undefined), fallback memori bekerja normal
			delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
			const noIdbStorage = createIndexedDbOfflineQueueStorage();
			const fallbackSaved = await enqueueOfflineOperation(
				{
					type: 'SHIFT_OPEN',
					label: 'Buka Shift di Lingkungan Tanpa IndexedDB',
					payload: { note: 'SSR / Node Fallback' }
				},
				noIdbStorage
			);
			expect((await noIdbStorage.listAll()).some((i) => i.clientOpId === fallbackSaved.clientOpId)).toBe(
				true
			);

			// B. Saat IndexedDB didukung di browser tetapi transaksi tulis gagal (mis. penyimpanan penuh / QuotaExceededError),
			// adapter WAJIB melempar error yang jujur dan TIDAK boleh diam-diam menyimpan ke fallback memori
			(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
				open() {
					const req: Record<string, unknown> = {
						result: {
							objectStoreNames: { contains: () => true },
							transaction() {
								const txObj: Record<string, unknown> = {
									error: new Error('QuotaExceededError: Penyimpanan perangkat penuh'),
									oncomplete: null as (() => void) | null,
									onerror: null as (() => void) | null,
									onabort: null as (() => void) | null,
									objectStore() {
										return {
											put() {
												queueMicrotask(() => {
													if (typeof txObj.onabort === 'function') {
														(txObj.onabort as () => void)();
													}
												});
											},
											getAll() {
												const getAllReq: Record<string, unknown> = {
													result: [],
													onsuccess: null,
													onerror: null
												};
												queueMicrotask(() => {
													if (typeof getAllReq.onsuccess === 'function') {
														(getAllReq.onsuccess as () => void)();
													}
												});
												return getAllReq;
											}
										};
									}
								};
								return txObj;
							},
							close() {}
						},
						onsuccess: null as (() => void) | null,
						onerror: null as (() => void) | null,
						onupgradeneeded: null as (() => void) | null
					};
					queueMicrotask(() => {
						if (typeof req.onsuccess === 'function') {
							(req.onsuccess as () => void)();
						}
					});
					return req;
				}
			};

			const idbFailingStorage = createIndexedDbOfflineQueueStorage();
			await expect(
				enqueueOfflineOperation(
					{
						type: 'LOAN_CREATE',
						label: 'Pinjam Saat Penyimpanan HP Penuh',
						payload: { purpose: 'Uji Gagal Tulis' }
					},
					idbFailingStorage
				)
			).rejects.toThrowError(/Gagal menyimpan operasi ke penyimpanan lokal HP.*Data belum tersimpan/);

			// Pastikan item yang gagal ditulis TIDAK terselip palsu di memori maupun di listAll()
			const itemsAfterFailedWrite = await idbFailingStorage.listAll();
			expect(itemsAfterFailedWrite).toHaveLength(0);
		} finally {
			if (prevIndexedDb === undefined) {
				delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
			} else {
				(globalThis as unknown as { indexedDB: unknown }).indexedDB = prevIndexedDb;
			}
		}
	});
});
