import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMobileApiClient } from '../src/lib/client/api';
import { createMemoryTokenStorage } from '../src/lib/client/tokenStorage';
import {
	computeOfflineQueueSummary,
	createMemoryOfflineQueueStorage,
	setOfflineQueueStorage,
	subscribeOfflineQueue,
	type OfflineQueueStorage
} from '../src/lib/client/offlineQueue';
import {
	computeBackoffDelayMs,
	enqueueOfflineOperation,
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
});
