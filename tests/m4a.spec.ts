import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/lib/server/db';
import type { PolicyUser } from '../src/lib/server/policy';
import { uploadEvidence } from '../src/lib/server/services/evidenceService';
import { createLoan, returnLoanItem } from '../src/lib/server/services/loanService';
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

	it('5. Konkurensi paralel dengan clientOpId yang sama pada LOAN_CREATE dan LOAN_RETURN: terkunci per clientOpId, diproses tepat sekali, hasil konsisten tanpa 500/CONFLICT palsu', async () => {
		const suffix = randomUUID().slice(0, 8);
		const asset = await prisma.asset.create({
			data: {
				code: `AST-M4PR-${suffix}`,
				qrToken: `qr-m4pr-${randomUUID()}`,
				name: 'Laptop Uji Paralel clientOpId Sama',
				categoryId,
				status: 'AVAILABLE'
			}
		});

		const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
		const returnEv = await createEvidenceForActor(borrower1, 'RETURN');
		const createOpId = `par-create-${randomUUID()}`;
		const returnOpId = `par-return-${randomUUID()}`;
		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

		const createOpPayload = {
			clientOpId: createOpId,
			type: 'LOAN_CREATE' as const,
			clientCreatedAt: new Date().toISOString(),
			payload: {
				assetId: asset.id,
				evidenceId: checkoutEv.id,
				purpose: 'Paralel Create Idempoten',
				expectedReturnAt
			}
		};

		// 1. Dua request paralel dengan clientOpId yang sama untuk LOAN_CREATE
		const [createResA, createResB] = await Promise.all([
			processSyncBatch(borrower1, { operations: [createOpPayload] }),
			processSyncBatch(borrower1, { operations: [createOpPayload] })
		]);

		expect(createResA.results[0].status).toBe('ACCEPTED');
		expect(createResB.results[0].status).toBe('ACCEPTED');
		expect(createResA.results[0].syncOperationId).toBe(createResB.results[0].syncOperationId);

		// Tepat satu yang mengeksekusi pertama (idempotentReplay: false) dan satu lagi membaca hasil tersimpan (idempotentReplay: true)
		const createReplays = [
			createResA.results[0].idempotentReplay,
			createResB.results[0].idempotentReplay
		];
		expect(createReplays.sort()).toEqual([false, true]);

		// Hanya ada 1 baris SyncOperation dan 1 Loan di database
		const syncCreateCount = await prisma.syncOperation.count({
			where: { clientOpId: createOpId }
		});
		expect(syncCreateCount).toBe(1);

		// 2. Dua request paralel dengan clientOpId yang sama untuk LOAN_RETURN
		const returnOpPayload = {
			clientOpId: returnOpId,
			type: 'LOAN_RETURN' as const,
			clientCreatedAt: new Date().toISOString(),
			payload: {
				assetId: asset.id,
				returnCondition: 'NORMAL',
				evidenceId: returnEv.id
			}
		};

		const [returnResA, returnResB] = await Promise.all([
			processSyncBatch(borrower1, { operations: [returnOpPayload] }),
			processSyncBatch(borrower1, { operations: [returnOpPayload] })
		]);

		expect(returnResA.results[0].status).toBe('ACCEPTED');
		expect(returnResB.results[0].status).toBe('ACCEPTED');
		expect(returnResA.results[0].syncOperationId).toBe(returnResB.results[0].syncOperationId);

		const returnReplays = [
			returnResA.results[0].idempotentReplay,
			returnResB.results[0].idempotentReplay
		];
		expect(returnReplays.sort()).toEqual([false, true]);
	});

	it('6. Pemulihan pengiriman ulang jika server berhenti setelah operasi domain sukses tetapi sebelum SyncOperation dicatat (tidak menghasilkan CONFLICT palsu)', async () => {
		const suffix = randomUUID().slice(0, 8);
		const asset = await prisma.asset.create({
			data: {
				code: `AST-M4RC-${suffix}`,
				qrToken: `qr-m4rc-${randomUUID()}`,
				name: 'Proyektor Uji Recovery Crash Sebelum SyncOperation',
				categoryId,
				status: 'AVAILABLE'
			}
		});

		const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
		const returnEv = await createEvidenceForActor(borrower1, 'RETURN');
		const createOpId = `rec-create-${randomUUID()}`;
		const returnOpId = `rec-return-${randomUUID()}`;
		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

		// Simulasikan operasi domain LOAN_CREATE sudah berhasil tersimpan di DB, tetapi SyncOperation belum ada
		const directLoan = await createLoan(borrower1, {
			assetId: asset.id,
			evidenceId: checkoutEv.id,
			purpose: 'Simulasi Crash Setelah CreateLoan',
			expectedReturnAt,
			clientOpId: createOpId
		});

		// Kirim ulang LOAN_CREATE lewat /sync -> harus ACCEPTED (bukan CONFLICT / DUPLICATE_OPERATION palsu!)
		const syncCreateRecovery = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId: createOpId,
					type: 'LOAN_CREATE',
					clientCreatedAt: new Date().toISOString(),
					payload: {
						assetId: asset.id,
						evidenceId: checkoutEv.id,
						purpose: 'Simulasi Crash Setelah CreateLoan',
						expectedReturnAt
					}
				}
			]
		});
		expect(syncCreateRecovery.results[0].status).toBe('ACCEPTED');

		// Simulasikan operasi domain LOAN_RETURN sudah berhasil tersimpan di DB, tetapi SyncOperation belum ada
		await returnLoanItem(borrower1, directLoan.loan.items[0].id, {
			returnCondition: 'NORMAL',
			evidenceId: returnEv.id,
			clientOpId: returnOpId
		});

		// Kirim ulang LOAN_RETURN lewat /sync -> harus ACCEPTED (bukan CONFLICT palsu!)
		const syncReturnRecovery = await processSyncBatch(borrower1, {
			operations: [
				{
					clientOpId: returnOpId,
					type: 'LOAN_RETURN',
					clientCreatedAt: new Date().toISOString(),
					payload: {
						assetId: asset.id,
						returnCondition: 'NORMAL',
						evidenceId: returnEv.id
					}
				}
			]
		});
		expect(syncReturnRecovery.results[0].status).toBe('ACCEPTED');
	});

	it('7. menahan beban 20 request sync paralel pada pool koneksi kecil (connection_limit=2) tanpa deadlock (1 transaksi / 1 koneksi per operasi)', async () => {
		const baseUrl = process.env.DATABASE_URL ?? '';
		const sep = baseUrl.includes('?') ? '&' : '?';
		const smallPoolUrl = `${baseUrl}${sep}connection_limit=2&pool_timeout=15`;
		const smallPoolPrisma = new PrismaClient({
			datasources: {
				db: {
					url: smallPoolUrl
				}
			}
		});
		await smallPoolPrisma.$connect();

		try {
			const totalParallel = 20;
			const suffix = randomUUID().slice(0, 6);

			// Siapkan 15 barang dan 15 foto bukti (5 request sisanya akan menguji konflik & replay paralel pada pool kecil yang sama)
			const assets = await Promise.all(
				Array.from({ length: 15 }, (_, idx) =>
					prisma.asset.create({
						data: {
							code: `AST-POOL-${suffix}-${idx}`,
							qrToken: `qr-pool-${suffix}-${idx}-${randomUUID()}`,
							name: `Barang Uji Pool Kecil #${idx}`,
							categoryId,
							status: 'AVAILABLE'
						}
					})
				)
			);

			const evidences = await Promise.all(
				Array.from({ length: totalParallel }, () => createEvidenceForActor(borrower1, 'CHECKOUT'))
			);

			const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

			// 20 request sync paralel memakai smallPoolPrisma (connection_limit=2):
			// - 15 request meminjam barang berbeda (idx 0..14) -> harus ACCEPTED
			// - 5 request meminjam ulang barang idx 0..4 dengan clientOpId baru -> harus CONFLICT (dan rollback transaksi utama lalu catat CONFLICT di transaksi terpisah tanpa deadlock!)
			const parallelTasks = Array.from({ length: totalParallel }, (_, idx) => {
				const targetAsset = assets[idx % 15];
				const ev = evidences[idx];
				return processSyncBatch(
					borrower1,
					{
						operations: [
							{
								clientOpId: `pool-op-${suffix}-${idx}`,
								type: 'LOAN_CREATE',
								clientCreatedAt: new Date(Date.now() + idx).toISOString(),
								payload: {
									assetId: targetAsset.id,
									evidenceId: ev.id,
									purpose: `Uji Beban Pool Kecil #${idx}`,
									expectedReturnAt
								}
							}
						]
					},
					'127.0.0.1',
					smallPoolPrisma
				);
			});

			const outcomes = await Promise.all(parallelTasks);
			expect(outcomes).toHaveLength(20);

			const allResults = outcomes.map((o) => o.results[0]);
			const acceptedCount = allResults.filter((r) => r.status === 'ACCEPTED').length;
			const conflictCount = allResults.filter((r) => r.status === 'CONFLICT').length;

			expect(acceptedCount).toBe(15);
			expect(conflictCount).toBe(5);
		} finally {
			await smallPoolPrisma.$disconnect();
		}
	});

	it('8. mendukung Lapis 1 SHIFT_CLOSE via /sync: LOAN_CREATE offline + SHIFT_CLOSE (via assetId) dalam satu batch (ACCEPTED), menolak barang keluar tanpa alasan (REJECTED dengan kode barang), dan mengabaikan alasan untuk barang yang sudah kembali', async () => {
		// Bersihkan semua LoanItem aktif sebelumnya agar daftar barang keluar terkontrol
		await prisma.loanItem.updateMany({
			where: { returnedAt: null },
			data: { returnedAt: new Date(), returnCondition: 'NORMAL' }
		});

		const suffix = randomUUID().slice(0, 8);
		const officerUser = await prisma.user.create({
			data: {
				name: 'Officer Lapis 1 Sync',
				email: `m4a-off-l1-${suffix}@example.com`,
				passwordHash: 'hash',
				role: 'OFFICER',
				isActive: true
			}
		});
		const officerActor: PolicyUser = { id: officerUser.id, role: 'OFFICER', isActive: true };

		const [assetOfflineBorrow, assetAlreadyReturned] = await Promise.all([
			prisma.asset.create({
				data: {
					code: `AST-L1-OUT-${suffix}`,
					qrToken: `qr-l1-out-${randomUUID()}`,
					name: 'Laptop Pinjam Offline Lapis 1',
					categoryId,
					status: 'AVAILABLE'
				}
			}),
			prisma.asset.create({
				data: {
					code: `AST-L1-RET-${suffix}`,
					qrToken: `qr-l1-ret-${randomUUID()}`,
					name: 'Kamera Sudah Kembali Sebelum Tutup Shift',
					categoryId,
					status: 'AVAILABLE'
				}
			})
		]);

		// Pinjam dan kembalikan assetAlreadyReturned sebelum shift ditutup
		const [evOutRet, evInRet, evOutOffline] = await Promise.all([
			createEvidenceForActor(officerActor, 'CHECKOUT'),
			createEvidenceForActor(officerActor, 'RETURN'),
			createEvidenceForActor(officerActor, 'CHECKOUT')
		]);

		const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();
		const loanReturnedBeforeClose = await createLoan(officerActor, {
			borrowerId: borrower1.id,
			assetId: assetAlreadyReturned.id,
			evidenceId: evOutRet.id,
			purpose: 'Sudah selesai sebelum tutup shift',
			expectedReturnAt
		});
		await returnLoanItem(officerActor, loanReturnedBeforeClose.loan.items[0].id, {
			returnCondition: 'NORMAL',
			evidenceId: evInRet.id
		});

		// A. Uji penolakan SHIFT_CLOSE bila ada barang keluar yang belum diberi alasan -> REJECTED dengan menyebut kode barang
		const openOpId1 = `l1-open-1-${randomUUID()}`;
		const loanOpId1 = `l1-loan-1-${randomUUID()}`;
		const closeMissingReasonOpId = `l1-close-miss-${randomUUID()}`;

		const batchMissingReason = await processSyncBatch(officerActor, {
			operations: [
				{
					clientOpId: openOpId1,
					type: 'SHIFT_OPEN',
					clientCreatedAt: '2026-11-25T08:00:00.000Z',
					payload: { note: 'Shift Uji Lapis 1' }
				},
				{
					clientOpId: loanOpId1,
					type: 'LOAN_CREATE',
					clientCreatedAt: '2026-11-25T08:05:00.000Z',
					payload: {
						borrowerId: borrower1.id,
						assetId: assetOfflineBorrow.id,
						evidenceId: evOutOffline.id,
						purpose: 'Pinjam Offline Tanpa ID Server',
						expectedReturnAt
					}
				},
				{
					clientOpId: closeMissingReasonOpId,
					type: 'SHIFT_CLOSE',
					clientCreatedAt: '2026-11-25T08:10:00.000Z',
					payload: {
						note: 'Coba tutup tanpa alasan untuk barang yang baru dipinjam offline',
						items: []
					}
				}
			]
		});

		expect(batchMissingReason.results[0].status).toBe('ACCEPTED');
		expect(batchMissingReason.results[1].status).toBe('ACCEPTED');
		expect(batchMissingReason.results[2].status).toBe('REJECTED');
		expect(batchMissingReason.results[2].code).toBe('VALIDATION_ERROR');
		expect(batchMissingReason.results[2].conflictReason).toContain(assetOfflineBorrow.code);

		// B. Uji pengiriman SHIFT_CLOSE dengan identifikasi via assetId + alasan untuk barang yang sudah kembali (diabaikan, bukan error) -> ACCEPTED
		const closeValidOpId = `l1-close-ok-${randomUUID()}`;
		const batchValidClose = await processSyncBatch(officerActor, {
			operations: [
				{
					clientOpId: closeValidOpId,
					type: 'SHIFT_CLOSE',
					clientCreatedAt: '2026-11-25T08:15:00.000Z',
					payload: {
						note: 'Tutup shift setelah melengkapi alasan via assetId',
						items: [
							{
								assetId: assetOfflineBorrow.id,
								reason: 'Masih dipakai seminar oleh peminjam 1'
							},
							{
								// Barang ini sudah dikembalikan sebelum tutup shift -> harus diabaikan tanpa error
								assetId: assetAlreadyReturned.id,
								reason: 'Alasan untuk barang yang ternyata sudah kembali'
							}
						]
					}
				}
			]
		});

		expect(batchValidClose.results[0].status).toBe('ACCEPTED');

		// Pastikan ShiftItem hanya mencatat 1 barang yang benar-benar masih keluar (assetOfflineBorrow)
		const closedShiftId = (batchValidClose.results[0].data as { shiftId: string }).shiftId;
		const recordedShiftItems = await prisma.shiftItem.findMany({
			where: { shiftId: closedShiftId },
			include: { loanItem: true }
		});
		expect(recordedShiftItems).toHaveLength(1);
		expect(recordedShiftItems[0].loanItem.assetId).toBe(assetOfflineBorrow.id);
		expect(recordedShiftItems[0].reason).toBe('Masih dipakai seminar oleh peminjam 1');
	});
});
