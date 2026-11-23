import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/server/db';
import type { PolicyUser } from '../src/lib/server/policy';
import { uploadEvidence } from '../src/lib/server/services/evidenceService';
import { processSyncBatch, listSyncOperations } from '../src/lib/server/services/syncService';

const VALID_JPEG_BUFFER = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
	0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
]);

describe('M4 Tahap 4A: Backend Sinkronisasi Offline (POST /api/v1/sync) — Idempotensi, Konflik, Urutan, & Isolasi Batch', () => {
	let borrower1: PolicyUser;
	let borrower2: PolicyUser;
	let categoryId: string;
	let locationId: string;

	beforeAll(async () => {
		await prisma.$connect();
		const suffix = randomUUID().slice(0, 8);

		const [u1, u2] = await Promise.all([
			prisma.user.create({
				data: {
					name: 'Borrower 1 Sync',
					email: `m4a-b1-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Borrower 2 Sync',
					email: `m4a-b2-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			})
		]);

		borrower1 = { id: u1.id, role: 'BORROWER', isActive: true };
		borrower2 = { id: u2.id, role: 'BORROWER', isActive: true };

		const [cat, loc] = await Promise.all([
			prisma.category.create({
				data: { name: `Kategori M4A ${suffix}`, requiresApproval: false }
			}),
			prisma.location.create({
				data: {
					name: `Lokasi M4A ${suffix}`,
					latitude: -6.2,
					longitude: 106.8166,
					radiusM: 100,
					isActive: true
				}
			})
		]);

		categoryId = cat.id;
		locationId = loc.id;
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	async function createEvidenceForActor(
		actor: PolicyUser,
		purpose: 'CHECKOUT' | 'RETURN' | 'HANDOVER'
	) {
		const res = await uploadEvidence(actor, {
			meta: {
				purpose,
				captureSource: 'CAMERA',
				takenAtDevice: new Date().toISOString(),
				gpsAvailable: true,
				latitude: -6.2,
				longitude: 106.8166,
				accuracyM: 10,
				isMockLocation: false,
				locationId
			},
			fileBuffer: VALID_JPEG_BUFFER
		});
		return res.evidence;
	}

	it('1. Idempotensi clientOpId: operasi yang dikirim dua kali tidak diproses dua kali (BR-14)', async () => {
		const suffix = randomUUID().slice(0, 8);
		const asset = await prisma.asset.create({
			data: {
				code: `AST-M4ID-${suffix}`,
				qrToken: `qr-m4id-${randomUUID()}`,
				name: 'Laptop Uji Idempotensi Sync',
				categoryId,
				status: 'AVAILABLE'
			}
		});

		const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
		const clientOpId = `sync-op-${randomUUID()}`;
		const clientCreatedAt = new Date().toISOString();
		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

		// Pengiriman pertama -> ACCEPTED, idempotentReplay: false
		const firstRun = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId,
					type: 'LOAN_CREATE',
					clientCreatedAt,
					payload: {
						assetId: asset.id,
						evidenceId: checkoutEv.id,
						purpose: 'Seminar Offline 1',
						expectedReturnAt
					}
				}
			]
		});

		expect(firstRun.results).toHaveLength(1);
		expect(firstRun.results[0].status).toBe('ACCEPTED');
		expect(firstRun.results[0].idempotentReplay).toBe(false);

		// Pengiriman kedua dengan clientOpId yang sama -> ACCEPTED dari tabel SyncOperation, idempotentReplay: true (tidak dieksekusi ulang)
		const secondRun = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId,
					type: 'LOAN_CREATE',
					clientCreatedAt,
					payload: {
						assetId: asset.id,
						evidenceId: checkoutEv.id,
						purpose: 'Seminar Offline 1',
						expectedReturnAt
					}
				}
			]
		});

		expect(secondRun.results).toHaveLength(1);
		expect(secondRun.results[0].status).toBe('ACCEPTED');
		expect(secondRun.results[0].idempotentReplay).toBe(true);
		expect(secondRun.summary.replayCount).toBe(1);

		// Pengguna lain yang mencoba memakai clientOpId milik borrower1 ditolak REJECTED (DUPLICATE_OPERATION)
		const hijackRun = await processSyncBatch(borrower2, {
			operations: [
				{
					clientOpId,
					type: 'LOAN_CREATE',
					clientCreatedAt,
					payload: {
						assetId: asset.id,
						evidenceId: checkoutEv.id,
						purpose: 'Coba Bajak clientOpId',
						expectedReturnAt
					}
				}
			]
		});
		expect(hijackRun.results[0].status).toBe('REJECTED');
		expect(hijackRun.results[0].code).toBe('DUPLICATE_OPERATION');
	});

	it('2. Konflik pinjam ganda saat offline: peminjam pertama ACCEPTED, peminjam kedua CONFLICT dengan alasan jelas (Bagian 10.3 & BR-02)', async () => {
		const suffix = randomUUID().slice(0, 8);
		const sharedAsset = await prisma.asset.create({
			data: {
				code: `AST-M4CF-${suffix}`,
				qrToken: `qr-m4cf-${randomUUID()}`,
				name: 'Proyektor Rebutan Offline',
				categoryId,
				status: 'AVAILABLE'
			}
		});

		const [ev1, ev2] = await Promise.all([
			createEvidenceForActor(borrower1, 'CHECKOUT'),
			createEvidenceForActor(borrower2, 'CHECKOUT')
		]);
		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

		// Borrower 1 sinkron lebih dulu -> ACCEPTED
		const sync1 = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId: `op-b1-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(Date.now() - 60_000).toISOString(),
					payload: {
						assetId: sharedAsset.id,
						evidenceId: ev1.id,
						purpose: 'Seminar B1',
						expectedReturnAt
					}
				}
			]
		});
		expect(sync1.results[0].status).toBe('ACCEPTED');

		// Borrower 2 sinkron belakangan untuk barang yang sama -> CONFLICT (ASSET_NOT_AVAILABLE)
		const opIdB2 = `op-b2-${randomUUID()}`;
		const sync2 = await processSyncBatch(borrower2, {
			operations: [
				{
					clientOpId: opIdB2,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(Date.now() - 30_000).toISOString(),
					payload: {
						assetId: sharedAsset.id,
						evidenceId: ev2.id,
						purpose: 'Seminar B2 Offline',
						expectedReturnAt
					}
				}
			]
		});

		expect(sync2.results[0].status).toBe('CONFLICT');
		expect(sync2.results[0].code).toBe('ASSET_NOT_AVAILABLE');
		expect(sync2.results[0].conflictReason).toContain(sharedAsset.code);

		// Pastikan tercatat sebagai CONFLICT di tabel SyncOperation
		const conflicts = await listSyncOperations(borrower2, { status: 'CONFLICT' });
		expect(conflicts.items.some((c) => c.clientOpId === opIdB2)).toBe(true);
	});

	it('3. Urutan operasi berdasarkan clientCreatedAt: memproses LOAN_CREATE sebelum LOAN_RETURN meskipun urutan di array terbalik (Bagian 10.2)', async () => {
		const suffix = randomUUID().slice(0, 8);
		const asset = await prisma.asset.create({
			data: {
				code: `AST-M4OR-${suffix}`,
				qrToken: `qr-m4or-${randomUUID()}`,
				name: 'Kamera Uji Urutan Waktu Offline',
				categoryId,
				status: 'AVAILABLE'
			}
		});

		const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
		const returnEv = await createEvidenceForActor(borrower1, 'RETURN');

		const tBorrow = new Date(Date.now() - 120_000).toISOString(); // 2 menit lalu
		const tReturn = new Date(Date.now() - 30_000).toISOString(); // 30 detik lalu

		// Kirim LOAN_RETURN di elemen pertama array, tetapi clientCreatedAt-nya lebih baru daripada LOAN_CREATE
		const batchRes = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId: `op-return-${randomUUID()}`,
					type: 'LOAN_RETURN',
					clientCreatedAt: tReturn,
					payload: {
						assetId: asset.id,
						returnCondition: 'NORMAL',
						evidenceId: returnEv.id
					}
				},
				{
					clientOpId: `op-create-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: tBorrow,
					payload: {
						assetId: asset.id,
						evidenceId: checkoutEv.id,
						purpose: 'Pinjam Lalu Kembalikan Offline',
						expectedReturnAt: new Date(Date.now() + 86400_000).toISOString()
					}
				}
			]
		});

		expect(batchRes.summary.acceptedCount).toBe(2);
		expect(batchRes.results[0].type).toBe('LOAN_CREATE');
		expect(batchRes.results[0].status).toBe('ACCEPTED');
		expect(batchRes.results[1].type).toBe('LOAN_RETURN');
		expect(batchRes.results[1].status).toBe('ACCEPTED');

		// Setelah kedua operasi selesai, status barang kembali AVAILABLE
		const finalAsset = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
		expect(finalAsset.status).toBe('AVAILABLE');
	});

	it('4. Sebagian batch gagal & penegakan aturan Evidence (purpose sesuai, milik pelaku, sekali pakai): operasi sah tetap ACCEPTED dan operasi tidak sah REJECTED', async () => {
		const suffix = randomUUID().slice(0, 8);
		const [asset1, asset2, asset3, asset4] = await Promise.all([
			prisma.asset.create({
				data: {
					code: `AST-M4B1-${suffix}`,
					qrToken: `qr-m4b1-${randomUUID()}`,
					name: 'Barang Batch 1 Sah',
					categoryId,
					status: 'AVAILABLE'
				}
			}),
			prisma.asset.create({
				data: {
					code: `AST-M4B2-${suffix}`,
					qrToken: `qr-m4b2-${randomUUID()}`,
					name: 'Barang Batch 2 Salah Purpose',
					categoryId,
					status: 'AVAILABLE'
				}
			}),
			prisma.asset.create({
				data: {
					code: `AST-M4B3-${suffix}`,
					qrToken: `qr-m4b3-${randomUUID()}`,
					name: 'Barang Batch 3 Salah Pemilik Bukti',
					categoryId,
					status: 'AVAILABLE'
				}
			}),
			prisma.asset.create({
				data: {
					code: `AST-M4B4-${suffix}`,
					qrToken: `qr-m4b4-${randomUUID()}`,
					name: 'Barang Batch 4 Bukti Dipakai Ulang',
					categoryId,
					status: 'AVAILABLE'
				}
			})
		]);

		const validCheckoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
		const wrongPurposeEv = await createEvidenceForActor(borrower1, 'RETURN');
		const otherUserEv = await createEvidenceForActor(borrower2, 'CHECKOUT');
		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();
		const baseTime = Date.now();

		const batchRes = await processSyncBatch(borrower1, {
			operations: [
				// Operasi 1: Sah -> ACCEPTED
				{
					clientOpId: `op-part-1-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(baseTime + 1000).toISOString(),
					payload: {
						assetId: asset1.id,
						evidenceId: validCheckoutEv.id,
						purpose: 'Operasi 1 Sah',
						expectedReturnAt
					}
				},
				// Operasi 2: Foto ber-purpose RETURN dipakai untuk LOAN_CREATE -> REJECTED (VALIDATION_ERROR)
				{
					clientOpId: `op-part-2-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(baseTime + 2000).toISOString(),
					payload: {
						assetId: asset2.id,
						evidenceId: wrongPurposeEv.id,
						purpose: 'Operasi 2 Salah Purpose',
						expectedReturnAt
					}
				},
				// Operasi 3: Foto milik borrower2 dipakai oleh borrower1 -> REJECTED (FORBIDDEN)
				{
					clientOpId: `op-part-3-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(baseTime + 3000).toISOString(),
					payload: {
						assetId: asset3.id,
						evidenceId: otherUserEv.id,
						purpose: 'Operasi 3 Foto Orang Lain',
						expectedReturnAt
					}
				},
				// Operasi 4: Foto validCheckoutEv dari Operasi 1 dipakai ulang -> REJECTED (DUPLICATE_OPERATION)
				{
					clientOpId: `op-part-4-${randomUUID()}`,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date(baseTime + 4000).toISOString(),
					payload: {
						assetId: asset4.id,
						evidenceId: validCheckoutEv.id,
						purpose: 'Operasi 4 Pakai Ulang Foto',
						expectedReturnAt
					}
				}
			]
		});

		expect(batchRes.summary.total).toBe(4);
		expect(batchRes.summary.acceptedCount).toBe(1);
		expect(batchRes.summary.rejectedCount).toBe(3);

		expect(batchRes.results[0].status).toBe('ACCEPTED');
		expect(batchRes.results[1].status).toBe('REJECTED');
		expect(batchRes.results[1].code).toBe('VALIDATION_ERROR');
		expect(batchRes.results[2].status).toBe('REJECTED');
		expect(batchRes.results[2].code).toBe('FORBIDDEN');
		expect(batchRes.results[3].status).toBe('REJECTED');
		expect(batchRes.results[3].code).toBe('DUPLICATE_OPERATION');
	});
});
