import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMobileApiClient } from '../src/lib/client/api';
import { createMemoryTokenStorage } from '../src/lib/client/tokenStorage';
import {
	clearCachedAssets,
	computeOfflineQueueSummary,
	createMemoryOfflineQueueStorage,
	findCachedAssetByCodeOrQr,
	getCachedAssetsList,
	saveCachedAssetScanPayload,
	saveCachedAssetsList,
	setOfflineQueueStorage,
	subscribeOfflineQueue,
	type OfflineQueueStorage
} from '../src/lib/client/offlineQueue';
import {
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
				payload: {
					shiftId: '44444444-4444-4444-8444-444444444444',
					items: []
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
});
