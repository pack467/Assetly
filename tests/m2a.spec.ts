import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/server/db';
import type { PolicyUser } from '../src/lib/server/policy';
import { evaluateEvidenceRisk } from '../src/lib/server/risk';
import { verifyEvidenceSignedUrl, getEvidenceSigningSecret } from '../src/lib/server/storage';
import { uploadEvidence, getEvidenceDetail } from '../src/lib/server/services/evidenceService';
import {
	createLoan,
	returnLoanItem,
	approveLoan,
	getDashboardSummary
} from '../src/lib/server/services/loanService';
import { GET as evidenceFileHandler } from '../src/routes/api/v1/evidence/[id]/file/+server';

// Minimal valid JPEG buffer (starts with FF D8 FF E0 ... ends with FF D9)
const VALID_JPEG_BUFFER = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
	0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
]);

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('M2 Tahap 2A: Bukti Foto, Penilaian Risiko, Peminjaman, Konkurensi Paralel, Pengembalian, & Dashboard', () => {
	let adminActor: PolicyUser;
	let borrower1: PolicyUser;
	let borrower2: PolicyUser;
	let standardCategoryId: string;
	let approvalCategoryId: string;
	let location1Id: string;

	beforeAll(async () => {
		await prisma.$connect();
		const suffix = randomUUID().slice(0, 8);

		const [uAdmin, uB1, uB2] = await Promise.all([
			prisma.user.create({
				data: {
					name: 'Admin M2A',
					email: `m2a-admin-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'ADMIN',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Borrower 1 M2A',
					email: `m2a-b1-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Borrower 2 M2A',
					email: `m2a-b2-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			})
		]);

		adminActor = { id: uAdmin.id, role: 'ADMIN', isActive: true };
		borrower1 = { id: uB1.id, role: 'BORROWER', isActive: true };
		borrower2 = { id: uB2.id, role: 'BORROWER', isActive: true };

		const [catStd, catApp, loc1] = await Promise.all([
			prisma.category.create({
				data: { name: `StdCat-${suffix}`, requiresApproval: false }
			}),
			prisma.category.create({
				data: { name: `AppCat-${suffix}`, requiresApproval: true }
			}),
			prisma.location.create({
				data: {
					name: `Ruang Seminar 1 ${suffix}`,
					latitude: -6.2,
					longitude: 106.8166,
					radiusM: 100,
					isActive: true
				}
			})
		]);

		standardCategoryId = catStd.id;
		approvalCategoryId = catApp.id;
		location1Id = loc1.id;
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	async function createTestEvidence(
		actor: PolicyUser,
		purpose: 'CHECKOUT' | 'RETURN' = 'CHECKOUT'
	) {
		const res = await uploadEvidence(actor, {
			meta: {
				purpose,
				captureSource: 'CAMERA',
				takenAtDevice: new Date().toISOString(),
				gpsAvailable: true,
				latitude: -6.2,
				longitude: 106.8166,
				accuracyM: 12,
				isMockLocation: false,
				locationId: location1Id,
				locationNote: 'Ruang Seminar'
			},
			fileBuffer: VALID_JPEG_BUFFER
		});
		return res.evidence;
	}

	describe('1. Penilaian Risiko Server (Bagian 9.2 — Fungsi Murni)', () => {
		const now = new Date('2026-11-23T03:00:00Z');
		const baseLoc = {
			id: 'loc-1',
			latitude: -6.2,
			longitude: 106.8166,
			radiusM: 100
		};

		it('menghasilkan NORMAL saat GPS akurat, di dalam radius lokasi, dan jam sinkron', () => {
			const res = evaluateEvidenceRisk({
				takenAtDevice: new Date('2026-11-23T02:59:50Z'),
				receivedAtServer: now,
				gpsAvailable: true,
				latitude: -6.2001,
				longitude: 106.8167,
				accuracyM: 15,
				isMockLocation: false,
				location: baseLoc
			});
			expect(res.riskLevel).toBe('NORMAL');
			expect(res.riskReasons).toEqual([]);
			expect(res.shouldBlock).toBe(false);
		});

		it('mencatat NO_GPS tanpa menaikkan riskLevel sendiri saat GPS tidak tersedia', () => {
			const res = evaluateEvidenceRisk({
				takenAtDevice: now,
				receivedAtServer: now,
				gpsAvailable: false,
				location: baseLoc
			});
			expect(res.riskReasons).toContain('NO_GPS');
			expect(res.riskLevel).toBe('NORMAL');
		});

		it('mendeteksi CLOCK_SKEW (>300s -> NEEDS_REVIEW) dan CLOCK_SKEW_LARGE (>3600s -> SUSPICIOUS)', () => {
			const warnRes = evaluateEvidenceRisk({
				takenAtDevice: new Date(now.getTime() - 450 * 1000),
				receivedAtServer: now,
				gpsAvailable: false
			});
			expect(warnRes.riskReasons).toContain('CLOCK_SKEW');
			expect(warnRes.riskLevel).toBe('NEEDS_REVIEW');

			const largeRes = evaluateEvidenceRisk({
				takenAtDevice: new Date(now.getTime() - 4000 * 1000),
				receivedAtServer: now,
				gpsAvailable: false
			});
			expect(largeRes.riskReasons).toContain('CLOCK_SKEW_LARGE');
			expect(largeRes.riskLevel).toBe('SUSPICIOUS');
		});

		it('mendeteksi ZERO_ACCURACY, FAR_FROM_LOCATION, dan FAR_FROM_LOCATION_LARGE', () => {
			const zeroAcc = evaluateEvidenceRisk({
				takenAtDevice: now,
				receivedAtServer: now,
				gpsAvailable: true,
				latitude: -6.2,
				longitude: 106.8166,
				accuracyM: 0,
				location: baseLoc
			});
			expect(zeroAcc.riskReasons).toContain('ZERO_ACCURACY');
			expect(zeroAcc.riskLevel).toBe('NEEDS_REVIEW');

			// Jarak ~250m (> radius 100m + acc 10m, tapi < 500m)
			const farWarn = evaluateEvidenceRisk({
				takenAtDevice: now,
				receivedAtServer: now,
				gpsAvailable: true,
				latitude: -6.2022,
				longitude: 106.8166,
				accuracyM: 10,
				location: baseLoc
			});
			expect(farWarn.riskReasons).toContain('FAR_FROM_LOCATION');
			expect(farWarn.riskLevel).toBe('NEEDS_REVIEW');

			// Jarak > 5 * 100m (mis. ~2.2 km)
			const farLarge = evaluateEvidenceRisk({
				takenAtDevice: now,
				receivedAtServer: now,
				gpsAvailable: true,
				latitude: -6.22,
				longitude: 106.8166,
				accuracyM: 10,
				location: baseLoc
			});
			expect(farLarge.riskReasons).toContain('FAR_FROM_LOCATION_LARGE');
			expect(farLarge.riskLevel).toBe('SUSPICIOUS');
		});

		it('mendeteksi IMPOSSIBLE_JUMP (>150 km/jam) dan REPEATED_COORDS (>=3 kali identik 6 desimal di lokasi berbeda)', () => {
			// Lompatan Jakarta (-6.2, 106.8166) ke Bandung (-6.9175, 107.6191) dalam 60 detik
			const jumpRes = evaluateEvidenceRisk(
				{
					takenAtDevice: now,
					receivedAtServer: now,
					gpsAvailable: true,
					latitude: -6.9175,
					longitude: 107.6191,
					accuracyM: 10
				},
				{
					recentUserEvidences: [
						{
							latitude: -6.2,
							longitude: 106.8166,
							locationId: 'loc-1',
							receivedAtServer: new Date(now.getTime() - 60_000),
							takenAtDevice: new Date(now.getTime() - 60_000)
						}
					]
				}
			);
			expect(jumpRes.riskReasons).toContain('IMPOSSIBLE_JUMP');
			expect(jumpRes.riskLevel).toBe('SUSPICIOUS');

			// Koordinat identik 6 desimal 3 kali berturut-turut di lokasi berbeda
			const repeatedRes = evaluateEvidenceRisk(
				{
					takenAtDevice: now,
					receivedAtServer: now,
					gpsAvailable: true,
					latitude: -6.200123,
					longitude: 106.816789,
					accuracyM: 12,
					location: { id: 'loc-2', latitude: null, longitude: null, radiusM: 100 }
				},
				{
					recentUserEvidences: [
						{
							latitude: -6.200123,
							longitude: 106.816789,
							locationId: 'loc-1',
							receivedAtServer: new Date(now.getTime() - 600_000),
							takenAtDevice: new Date(now.getTime() - 600_000)
						},
						{
							latitude: -6.200123,
							longitude: 106.816789,
							locationId: 'loc-1',
							receivedAtServer: new Date(now.getTime() - 1200_000),
							takenAtDevice: new Date(now.getTime() - 1200_000)
						}
					]
				}
			);
			expect(repeatedRes.riskReasons).toContain('REPEATED_COORDS');
			expect(repeatedRes.riskLevel).toBe('NEEDS_REVIEW');
		});

		it('menandai MOCK_LOCATION sebagai SUSPICIOUS dan mengikuti konfigurasi blockOnMock (BR-07)', () => {
			const blocked = evaluateEvidenceRisk(
				{
					takenAtDevice: now,
					receivedAtServer: now,
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8166,
					isMockLocation: true
				},
				{},
				{ blockOnMock: true }
			);
			expect(blocked.riskLevel).toBe('SUSPICIOUS');
			expect(blocked.riskReasons).toContain('MOCK_LOCATION');
			expect(blocked.shouldBlock).toBe(true);

			const flaggedOnly = evaluateEvidenceRisk(
				{
					takenAtDevice: now,
					receivedAtServer: now,
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8166,
					isMockLocation: true
				},
				{},
				{ blockOnMock: false }
			);
			expect(flaggedOnly.riskLevel).toBe('SUSPICIOUS');
			expect(flaggedOnly.shouldBlock).toBe(false);
		});
	});

	describe('2. Unggah Bukti Foto, Tolak Galeri/Non-JPEG, Mock Location, & Signed URL (BR-04, BR-06, BR-07)', () => {
		it('menolak unggahan dari galeri (BR-04) dan berkas non-JPEG (Bagian 9.1)', async () => {
			await expect(
				uploadEvidence(borrower1, {
					meta: {
						purpose: 'CHECKOUT',
						captureSource: 'GALLERY',
						takenAtDevice: new Date().toISOString(),
						gpsAvailable: true,
						latitude: -6.2,
						longitude: 106.8166,
						isMockLocation: false
					},
					fileBuffer: VALID_JPEG_BUFFER
				})
			).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

			await expect(
				uploadEvidence(borrower1, {
					meta: {
						purpose: 'CHECKOUT',
						captureSource: 'CAMERA',
						takenAtDevice: new Date().toISOString(),
						gpsAvailable: true,
						latitude: -6.2,
						longitude: 106.8166,
						isMockLocation: false
					},
					fileBuffer: PNG_BUFFER
				})
			).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
		});

		it('mewajibkan locationId manual saat GPS tidak tersedia (BR-06)', async () => {
			await expect(
				uploadEvidence(borrower1, {
					meta: {
						purpose: 'CHECKOUT',
						captureSource: 'CAMERA',
						takenAtDevice: new Date().toISOString(),
						gpsAvailable: false,
						isMockLocation: false,
						locationId: null
					},
					fileBuffer: VALID_JPEG_BUFFER
				})
			).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

			// Dengan locationId manual, berhasil meski GPS mati
			const okNoGps = await uploadEvidence(borrower1, {
				meta: {
					purpose: 'CHECKOUT',
					captureSource: 'CAMERA',
					takenAtDevice: new Date().toISOString(),
					gpsAvailable: false,
					isMockLocation: false,
					locationId: location1Id
				},
				fileBuffer: VALID_JPEG_BUFFER
			});
			expect(okNoGps.evidence.riskLevel).toBe('NORMAL');
			expect(okNoGps.evidence.riskReasons).toContain('NO_GPS');
		});

		it('memblokir mock location saat RISK_BLOCK_ON_MOCK=true dan menyimpan sebagai SUSPICIOUS saat false', async () => {
			const prev = process.env.RISK_BLOCK_ON_MOCK;
			try {
				process.env.RISK_BLOCK_ON_MOCK = 'true';
				await expect(
					uploadEvidence(borrower1, {
						meta: {
							purpose: 'CHECKOUT',
							captureSource: 'CAMERA',
							takenAtDevice: new Date().toISOString(),
							gpsAvailable: true,
							latitude: -6.2,
							longitude: 106.8166,
							isMockLocation: true,
							locationId: location1Id
						},
						fileBuffer: VALID_JPEG_BUFFER
					})
				).rejects.toMatchObject({
					code: 'MOCK_LOCATION_BLOCKED',
					status: 422,
					details: { riskLevel: 'SUSPICIOUS' }
				});

				process.env.RISK_BLOCK_ON_MOCK = 'false';
				const allowedMock = await uploadEvidence(borrower1, {
					meta: {
						purpose: 'CHECKOUT',
						captureSource: 'CAMERA',
						takenAtDevice: new Date().toISOString(),
						gpsAvailable: true,
						latitude: -6.2,
						longitude: 106.8166,
						isMockLocation: true,
						locationId: location1Id
					},
					fileBuffer: VALID_JPEG_BUFFER
				});
				expect(allowedMock.evidence.riskLevel).toBe('SUSPICIOUS');
				expect(allowedMock.evidence.riskReasons).toContain('MOCK_LOCATION');
			} finally {
				process.env.RISK_BLOCK_ON_MOCK = prev ?? 'true';
			}
		});

		it('menyajikan foto hanya melalui signed URL yang sah dan menolak akses tanpa signature / kedaluwarsa (Bagian 12)', async () => {
			const uploaded = await uploadEvidence(borrower1, {
				meta: {
					purpose: 'CHECKOUT',
					captureSource: 'CAMERA',
					takenAtDevice: new Date().toISOString(),
					gpsAvailable: true,
					latitude: -6.2,
					longitude: 106.8166,
					accuracyM: 10,
					isMockLocation: false,
					locationId: location1Id
				},
				fileBuffer: VALID_JPEG_BUFFER
			});

			const detail = await getEvidenceDetail(borrower1, uploaded.evidence.id);
			expect(detail.signedUrl).toContain('/api/v1/evidence/');

			const parsedUrl = new URL(`http://localhost${detail.signedUrl}`);

			// 1. Akses dengan signed URL sah -> 200 image/jpeg
			const okRes = await evidenceFileHandler({
				params: { id: uploaded.evidence.id },
				url: parsedUrl
			} as never);
			expect(okRes.status).toBe(200);
			expect(okRes.headers.get('content-type')).toBe('image/jpeg');

			// 2. Akses tanpa parameter signature -> 403 FORBIDDEN
			const noSigUrl = new URL(`http://localhost/api/v1/evidence/${uploaded.evidence.id}/file`);
			const forbiddenRes = await evidenceFileHandler({
				params: { id: uploaded.evidence.id },
				url: noSigUrl
			} as never);
			expect(forbiddenRes.status).toBe(403);

			// 3. Verifikasi kedaluwarsa waktu
			expect(
				verifyEvidenceSignedUrl({
					evidenceId: uploaded.evidence.id,
					imageKey: uploaded.evidence.imageKey,
					expiresParam: parsedUrl.searchParams.get('expires'),
					sigParam: parsedUrl.searchParams.get('sig'),
					nowEpochSec: Math.floor(Date.now() / 1000) + 600 // +10 menit (lewat TTL 5 menit)
				})
			).toBe(false);
		});
	});

	describe('3. Konkurensi Pinjam Ganda Paralel, Idempotensi clientOpId, Pengembalian, & Dashboard', () => {
		it('Mencegah pinjam ganda pada permintaan paralel: tepat satu berhasil dan satu gagal (BR-02 & M2 Penerimaan)', async () => {
			const suffix = randomUUID().slice(0, 8);
			const contestedAsset = await prisma.asset.create({
				data: {
					code: `AST-PAR-${suffix}`,
					qrToken: `qr-par-${randomUUID()}`,
					name: 'Laptop Uji Konkurensi Paralel',
					categoryId: standardCategoryId,
					status: 'AVAILABLE'
				}
			});

			const [ev1, ev2] = await Promise.all([
				createTestEvidence(borrower1, 'CHECKOUT'),
				createTestEvidence(borrower2, 'CHECKOUT')
			]);

			const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

			// Eksekusi paralel dua pengguna meminjam barang yang sama pada saat bersamaan
			const results = await Promise.allSettled([
				createLoan(borrower1, {
					assetId: contestedAsset.id,
					evidenceId: ev1.id,
					purpose: 'Seminar Paralel User 1',
					expectedReturnAt
				}),
				createLoan(borrower2, {
					assetId: contestedAsset.id,
					evidenceId: ev2.id,
					purpose: 'Seminar Paralel User 2',
					expectedReturnAt
				})
			]);

			const fulfilled = results.filter((r) => r.status === 'fulfilled');
			const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(['ALREADY_BORROWED_CONFLICT', 'ASSET_NOT_AVAILABLE']).toContain(
				(rejected[0].reason as { code?: string })?.code
			);

			// Barang kini berstatus BORROWED dan tidak bisa dipinjam lagi sebelum dikembalikan (pakai Evidence baru)
			const ev3 = await createTestEvidence(borrower2, 'CHECKOUT');
			await expect(
				createLoan(borrower2, {
					assetId: contestedAsset.id,
					evidenceId: ev3.id,
					purpose: 'Coba lagi saat masih dipinjam',
					expectedReturnAt
				})
			).rejects.toMatchObject({
				code: 'ASSET_NOT_AVAILABLE',
				status: 409
			});
		});

		it('Mendukung idempotensi clientOpId (BR-14), pengembalian NORMAL & DAMAGED (BR-09), persetujuan Admin (BR-08), dan Dashboard Summary', async () => {
			const suffix = randomUUID().slice(0, 8);
			const [normalAsset, approvalAsset] = await Promise.all([
				prisma.asset.create({
					data: {
						code: `AST-NRM-${suffix}`,
						qrToken: `qr-nrm-${randomUUID()}`,
						name: 'Proyektor Uji Siklus',
						categoryId: standardCategoryId,
						status: 'AVAILABLE',
						accessories: {
							create: [{ name: 'Kabel HDMI', quantity: 1 }]
						}
					}
				}),
				prisma.asset.create({
					data: {
						code: `AST-APP-${suffix}`,
						qrToken: `qr-app-${randomUUID()}`,
						name: 'Kamera Mahal Butuh Approval',
						categoryId: approvalCategoryId,
						status: 'AVAILABLE'
					}
				})
			]);

			const checkoutEv = await createTestEvidence(borrower1, 'CHECKOUT');
			const clientOpId = `op-${randomUUID()}`;
			const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

			// 1. Buat peminjaman dengan clientOpId
			const loanRes1 = await createLoan(borrower1, {
				assetId: normalAsset.id,
				evidenceId: checkoutEv.id,
				purpose: 'Seminar Nasional',
				expectedReturnAt,
				clientOpId
			});
			expect(loanRes1.idempotentReplay).toBe(false);
			expect(loanRes1.loan.status).toBe('ACTIVE');

			// 2. Kirim ulang dengan clientOpId yang sama -> idempoten, tidak buat data ganda
			const loanRes2 = await createLoan(borrower1, {
				assetId: normalAsset.id,
				evidenceId: checkoutEv.id,
				purpose: 'Seminar Nasional',
				expectedReturnAt,
				clientOpId
			});
			expect(loanRes2.idempotentReplay).toBe(true);
			expect(loanRes2.loan.id).toBe(loanRes1.loan.id);

			const loanItemId = loanRes1.loan.items[0].id;
			const returnEv = await createTestEvidence(borrower1, 'RETURN');

			// 3. Pengembalian dengan kondisi DAMAGED tanpa catatan kerusakan wajib ditolak (BR-09)
			await expect(
				returnLoanItem(borrower1, loanItemId, {
					returnCondition: 'DAMAGED',
					evidenceId: returnEv.id,
					damageNote: ''
				})
			).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

			// 4. Pengembalian DAMAGED dengan catatan kerusakan -> Asset menjadi DAMAGED & Loan COMPLETED
			const returned = await returnLoanItem(borrower1, loanItemId, {
				returnCondition: 'DAMAGED',
				evidenceId: returnEv.id,
				damageNote: 'Lensa proyektor retak di bagian tepi'
			});
			expect(returned.asset.status).toBe('DAMAGED');
			expect(returned.loan.status).toBe('COMPLETED');

			// 5. Peminjaman untuk kategori requiresApproval = true -> masuk PENDING_APPROVAL
			const appEv = await createTestEvidence(borrower2, 'CHECKOUT');
			const pendingLoanRes = await createLoan(borrower2, {
				assetId: approvalAsset.id,
				evidenceId: appEv.id,
				purpose: 'Dokumentasi Acara',
				expectedReturnAt
			});
			expect(pendingLoanRes.loan.status).toBe('PENDING_APPROVAL');

			// 6. Ringkasan Dashboard Admin memuat data peminjaman & status barang
			const summaryBeforeApprove = await getDashboardSummary(adminActor);
			expect(summaryBeforeApprove.loans.pendingApprovalsCount).toBeGreaterThanOrEqual(1);
			expect(summaryBeforeApprove.assetsByStatus.DAMAGED).toBeGreaterThanOrEqual(1);

			// 7. Admin menyetujui peminjaman -> Loan ACTIVE & Asset BORROWED
			const approved = await approveLoan(adminActor, pendingLoanRes.loan.id);
			expect(approved.loan.status).toBe('ACTIVE');
			expect(approved.loan.items[0].asset.status).toBe('BORROWED');
		});

		it('Menegakkan 5 aturan ketat Evidence: purpose CHECKOUT vs RETURN, pemilik Evidence, pemakaian sekali (DUPLICATE_OPERATION), MOCK_LOCATION pada return, dan validasi EVIDENCE_SIGNING_SECRET', async () => {
			const suffix = randomUUID().slice(0, 8);
			const [assetA, assetB] = await Promise.all([
				prisma.asset.create({
					data: {
						code: `AST-EV1-${suffix}`,
						qrToken: `qr-ev1-${randomUUID()}`,
						name: 'Barang Uji Aturan Evidence A',
						categoryId: standardCategoryId,
						status: 'AVAILABLE'
					}
				}),
				prisma.asset.create({
					data: {
						code: `AST-EV2-${suffix}`,
						qrToken: `qr-ev2-${randomUUID()}`,
						name: 'Barang Uji Aturan Evidence B',
						categoryId: standardCategoryId,
						status: 'AVAILABLE'
					}
				})
			]);

			const expectedReturnAt = new Date(Date.now() + 86400_000).toISOString();

			// 1. Foto ber-purpose RETURN ditolak saat dipakai untuk meminjam (createLoan)
			const returnEvForCheckout = await createTestEvidence(borrower1, 'RETURN');
			await expect(
				createLoan(borrower1, {
					assetId: assetA.id,
					evidenceId: returnEvForCheckout.id,
					purpose: 'Coba pakai foto RETURN untuk pinjam',
					expectedReturnAt
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 2. Foto milik borrower2 ditolak jika dipakai oleh borrower1 saat meminjam
			const b2CheckoutEv = await createTestEvidence(borrower2, 'CHECKOUT');
			await expect(
				createLoan(borrower1, {
					assetId: assetA.id,
					evidenceId: b2CheckoutEv.id,
					purpose: 'Coba pakai foto orang lain',
					expectedReturnAt
				})
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			// Pinjam assetA dengan foto CHECKOUT milik borrower1 yang sah
			const validCheckoutEv = await createTestEvidence(borrower1, 'CHECKOUT');
			const createdLoanRes = await createLoan(borrower1, {
				assetId: assetA.id,
				evidenceId: validCheckoutEv.id,
				purpose: 'Peminjaman Sah',
				expectedReturnAt
			});
			const loanItemId = createdLoanRes.loan.items[0].id;

			// 3a. Satu Evidence hanya boleh dipakai sekali: memakai ulang validCheckoutEv untuk meminjam assetB wajib ditolak DUPLICATE_OPERATION
			await expect(
				createLoan(borrower1, {
					assetId: assetB.id,
					evidenceId: validCheckoutEv.id,
					purpose: 'Coba pakai ulang foto CHECKOUT yang sama',
					expectedReturnAt
				})
			).rejects.toMatchObject({
				code: 'DUPLICATE_OPERATION',
				status: 409
			});

			// 1b. Foto CHECKOUT ditolak bila dipakai untuk RETURN
			const anotherCheckoutEv = await createTestEvidence(borrower1, 'CHECKOUT');
			await expect(
				returnLoanItem(borrower1, loanItemId, {
					returnCondition: 'NORMAL',
					evidenceId: anotherCheckoutEv.id
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 2b. Foto RETURN yang diunggah oleh borrower2 ditolak bila dipakai borrower1 untuk mengembalikan
			const b2ReturnEv = await createTestEvidence(borrower2, 'RETURN');
			await expect(
				returnLoanItem(borrower1, loanItemId, {
					returnCondition: 'NORMAL',
					evidenceId: b2ReturnEv.id
				})
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			// 4. Aturan MOCK_LOCATION (BR-07) juga menolak pengembalian bila bukti RETURN berstatus isMockLocation = true dan RISK_BLOCK_ON_MOCK=true
			const prevMockSetting = process.env.RISK_BLOCK_ON_MOCK;
			let mockReturnEvId: string;
			try {
				process.env.RISK_BLOCK_ON_MOCK = 'false';
				const mockReturnUploaded = await uploadEvidence(borrower1, {
					meta: {
						purpose: 'RETURN',
						captureSource: 'CAMERA',
						takenAtDevice: new Date().toISOString(),
						gpsAvailable: true,
						latitude: -6.2,
						longitude: 106.8166,
						isMockLocation: true,
						locationId: location1Id
					},
					fileBuffer: VALID_JPEG_BUFFER
				});
				mockReturnEvId = mockReturnUploaded.evidence.id;

				process.env.RISK_BLOCK_ON_MOCK = 'true';
				await expect(
					returnLoanItem(borrower1, loanItemId, {
						returnCondition: 'NORMAL',
						evidenceId: mockReturnEvId
					})
				).rejects.toMatchObject({
					code: 'MOCK_LOCATION_BLOCKED',
					status: 422
				});
			} finally {
				process.env.RISK_BLOCK_ON_MOCK = prevMockSetting ?? 'true';
			}

			// Kembalikan assetA dengan foto RETURN yang sah
			const validReturnEv = await createTestEvidence(borrower1, 'RETURN');
			const returnedOk = await returnLoanItem(borrower1, loanItemId, {
				returnCondition: 'NORMAL',
				evidenceId: validReturnEv.id
			});
			expect(returnedOk.loan.status).toBe('COMPLETED');

			// 3b. Foto RETURN yang sudah dipakai sekali tidak boleh dipakai ulang untuk pengembalian lain
			const loanBRes = await createLoan(borrower1, {
				assetId: assetB.id,
				evidenceId: anotherCheckoutEv.id,
				purpose: 'Pinjam Barang B',
				expectedReturnAt
			});
			await expect(
				returnLoanItem(borrower1, loanBRes.loan.items[0].id, {
					returnCondition: 'NORMAL',
					evidenceId: validReturnEv.id
				})
			).rejects.toMatchObject({
				code: 'DUPLICATE_OPERATION',
				status: 409
			});

			// 5. Validasi EVIDENCE_SIGNING_SECRET terpisah dari JWT_ACCESS_SECRET (wajib & minimal 32 karakter)
			const origSigningSecret = process.env.EVIDENCE_SIGNING_SECRET;
			try {
				process.env.EVIDENCE_SIGNING_SECRET = '';
				expect(() => getEvidenceSigningSecret()).toThrowError(
					/EVIDENCE_SIGNING_SECRET wajib diatur.*tidak boleh kosong/i
				);

				process.env.EVIDENCE_SIGNING_SECRET = 'pendek-12345';
				expect(() => getEvidenceSigningSecret()).toThrowError(
					/EVIDENCE_SIGNING_SECRET terlalu pendek.*minimal 32 karakter/i
				);
			} finally {
				process.env.EVIDENCE_SIGNING_SECRET = origSigningSecret;
			}
		});
	});
});
