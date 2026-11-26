import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/server/db';
import type { PolicyUser } from '../src/lib/server/policy';
import {
	createUser,
	listUsers,
	updateUser,
	listUserSessions
} from '../src/lib/server/services/userService';
import {
	createCategory,
	listCategories,
	updateCategory
} from '../src/lib/server/services/categoryService';
import {
	createLocation,
	listLocations,
	updateLocation
} from '../src/lib/server/services/locationService';
import {
	createAsset,
	listAssets,
	getAssetDetail,
	getAssetScanInfo,
	updateAsset,
	changeAssetSpecialStatus,
	reprintAssetQr,
	importAssetsFromCsv
} from '../src/lib/server/services/assetService';
import { listAuditLogs } from '../src/lib/server/services/auditService';
import { getActiveOutstandingLoanItems } from '../src/lib/server/services/shiftService';
import { GET as getAssetsHandler } from '../src/routes/api/v1/assets/+server';
import { GET as getLoansHandler } from '../src/routes/api/v1/loans/+server';
import { GET as getShiftsHandler } from '../src/routes/api/v1/shifts/+server';
import { GET as getSyncHandler } from '../src/routes/api/v1/sync/+server';
import { GET as getHandoversHandler } from '../src/routes/api/v1/handovers/+server';

describe('M1: Master Data & Admin Web — CRUD, Impor CSV, Cetak QR, BR-16, BR-19, & Otorisasi', () => {
	let adminActor: PolicyUser;
	let officerActor: PolicyUser;
	let borrowerActor: PolicyUser;
	let categoryId: string;
	let categoryName: string;
	let locationId: string;
	let locationName: string;

	beforeAll(async () => {
		await prisma.$connect();
		const suffix = randomUUID().slice(0, 8);

		const seedAdmin = await prisma.user.create({
			data: {
				name: 'Seed Admin M1',
				email: `m1-admin-${suffix}@example.com`,
				passwordHash: 'hash',
				role: 'ADMIN',
				isActive: true
			}
		});
		adminActor = { id: seedAdmin.id, role: 'ADMIN', isActive: true };

		const seedOfficer = await prisma.user.create({
			data: {
				name: 'Seed Officer M1',
				email: `m1-officer-${suffix}@example.com`,
				passwordHash: 'hash',
				role: 'OFFICER',
				isActive: true
			}
		});
		officerActor = { id: seedOfficer.id, role: 'OFFICER', isActive: true };

		const seedBorrower = await prisma.user.create({
			data: {
				name: 'Seed Borrower M1',
				email: `m1-borrower-${suffix}@example.com`,
				passwordHash: 'hash',
				role: 'BORROWER',
				isActive: true
			}
		});
		borrowerActor = { id: seedBorrower.id, role: 'BORROWER', isActive: true };
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	describe('1. Otorisasi Endpoint Admin (Non-Admin Ditolak di Semua Operasi Admin)', () => {
		it('menolak OFFICER dan BORROWER pada pengelolaan user, kategori, lokasi, barang, impor CSV, cetak QR, dan audit log', async () => {
			for (const nonAdmin of [officerActor, borrowerActor]) {
				await expect(listUsers(nonAdmin)).rejects.toMatchObject({
					code: 'FORBIDDEN',
					status: 403
				});

				await expect(
					createUser(nonAdmin, {
						name: 'Illegal User',
						email: 'illegal@example.com',
						password: 'Password123!',
						role: 'BORROWER',
						isActive: true
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					createCategory(nonAdmin, {
						name: 'Illegal Category',
						requiresApproval: false
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					createLocation(nonAdmin, {
						name: 'Illegal Location',
						radiusM: 100,
						isActive: true
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					createAsset(nonAdmin, {
						name: 'Illegal Asset',
						categoryId: randomUUID()
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					importAssetsFromCsv(nonAdmin, {
						csvText: 'name,category\nA,B',
						mode: 'preview'
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					reprintAssetQr(nonAdmin, randomUUID(), { rotateToken: false })
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(
					changeAssetSpecialStatus(nonAdmin, randomUUID(), {
						status: 'LOST',
						note: 'Tidak boleh'
					})
				).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

				await expect(listAuditLogs(nonAdmin)).rejects.toMatchObject({
					code: 'FORBIDDEN',
					status: 403
				});
			}
		});
	});

	describe('2. Master Kategori & Lokasi Resmi', () => {
		it('Admin dapat membuat dan mengubah Kategori serta Lokasi Resmi, dan semua role dapat membacanya', async () => {
			const suffix = randomUUID().slice(0, 8);
			categoryName = `Laptop Seminar ${suffix}`;
			locationName = `Ruang Utama ${suffix}`;

			const createdCat = await createCategory(adminActor, {
				name: categoryName,
				requiresApproval: true,
				maintenanceIntervalDays: 180
			});
			categoryId = createdCat.category.id;
			expect(createdCat.category.requiresApproval).toBe(true);

			const updatedCat = await updateCategory(adminActor, categoryId, {
				maintenanceIntervalDays: 90
			});
			expect(updatedCat.category.maintenanceIntervalDays).toBe(90);

			const createdLoc = await createLocation(adminActor, {
				name: locationName,
				latitude: -6.201,
				longitude: 106.816,
				radiusM: 120,
				isActive: true
			});
			locationId = createdLoc.location.id;
			expect(createdLoc.location.radiusM).toBe(120);

			const updatedLoc = await updateLocation(adminActor, locationId, {
				radiusM: 150
			});
			expect(updatedLoc.location.radiusM).toBe(150);

			// BORROWER dan OFFICER boleh membaca daftar kategori & lokasi
			const catsForBorrower = await listCategories(borrowerActor);
			expect(catsForBorrower.items.some((c) => c.id === categoryId)).toBe(true);

			const locsForOfficer = await listLocations(officerActor);
			expect(locsForOfficer.items.some((l) => l.id === locationId)).toBe(true);
		});
	});

	describe('3. Kelola Pengguna, Setup TOTP Admin (BR-19), & Proteksi Nonaktif Pemegang Barang (BR-16)', () => {
		it('Otomatis menyiapkan mfaSecret TOTP saat Admin baru dibuat (BR-19)', async () => {
			const suffix = randomUUID().slice(0, 8);
			const res = await createUser(adminActor, {
				name: 'Admin Baru TOTP',
				email: `new-admin-${suffix}@example.com`,
				password: 'StrongPassword!123',
				role: 'ADMIN',
				isActive: true
			});

			expect(res.user.hasTotp).toBe(true);
			expect(res.totpSetup?.secret).toBeTruthy();
			expect(res.totpSetup?.uri).toContain('otpauth://totp/');

			const sessions = await listUserSessions(adminActor, res.user.id);
			expect(Array.isArray(sessions.items)).toBe(true);
		});

		it('Menolak penonaktifan pengguna yang masih memegang barang aktif dengan USER_HOLDS_ASSETS (BR-16)', async () => {
			const suffix = randomUUID().slice(0, 8);
			const holder = await createUser(adminActor, {
				name: 'Pemegang Barang Aktif',
				email: `holder-${suffix}@example.com`,
				password: 'StrongPassword!123',
				role: 'BORROWER',
				isActive: true
			});

			const assetRes = await createAsset(adminActor, {
				name: 'Proyektor Pinjaman Aktif',
				categoryId
			});

			const loan = await prisma.loan.create({
				data: {
					borrowerId: holder.user.id,
					createdById: adminActor.id,
					purpose: 'Seminar',
					expectedReturnAt: new Date(Date.now() + 86400_000),
					status: 'ACTIVE'
				}
			});

			const loanItem = await prisma.loanItem.create({
				data: {
					loanId: loan.id,
					assetId: assetRes.asset.id,
					returnedAt: null
				}
			});

			// Percobaan menonaktifkan holder saat barang belum kembali wajib ditolak (BR-16)
			await expect(
				updateUser(adminActor, holder.user.id, { isActive: false })
			).rejects.toMatchObject({
				code: 'USER_HOLDS_ASSETS',
				status: 409
			});

			// Setelah barang dikembalikan, user boleh dinonaktifkan
			await prisma.loanItem.update({
				where: { id: loanItem.id },
				data: { returnedAt: new Date(), returnCondition: 'NORMAL' }
			});

			const deactivated = await updateUser(adminActor, holder.user.id, { isActive: false });
			expect(deactivated.user.isActive).toBe(false);
		});

		it('Mencegah Admin menonaktifkan atau menurunkan perannya sendiri, serta menjamin minimal satu ADMIN aktif selalu tersisa di dalam transaksi (#3)', async () => {
			// 1. Admin tidak boleh menonaktifkan akunnya sendiri
			await expect(
				updateUser(adminActor, adminActor.id, { isActive: false })
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 2. Admin tidak boleh menurunkan peran (role) akunnya sendiri
			await expect(
				updateUser(adminActor, adminActor.id, { role: 'OFFICER' })
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			await expect(
				updateUser(adminActor, adminActor.id, { role: 'BORROWER' })
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 3. Uji penjaga di dalam transaksi saat hanya ada tepat 2 ADMIN aktif yang saling menonaktifkan secara paralel:
			// Matikan sementara admin aktif lain di luar pasangan uji agar tepat 2 ADMIN yang aktif
			const suffix = randomUUID().slice(0, 8);
			const secondAdminRes = await createUser(adminActor, {
				name: 'Second Admin Guard Test',
				email: `second-admin-${suffix}@example.com`,
				password: 'StrongPassword!123',
				role: 'ADMIN',
				isActive: true
			});
			const secondAdminActor: PolicyUser = {
				id: secondAdminRes.user.id,
				role: 'ADMIN',
				isActive: true
			};

			const otherExistingAdmins = await prisma.user.findMany({
				where: {
					role: 'ADMIN',
					isActive: true,
					id: { notIn: [adminActor.id, secondAdminActor.id] }
				},
				select: { id: true }
			});
			if (otherExistingAdmins.length > 0) {
				await prisma.user.updateMany({
					where: { id: { in: otherExistingAdmins.map((a) => a.id) } },
					data: { isActive: false }
				});
			}

			try {
				// Admin 1 menonaktifkan Admin 2 DAN Admin 2 menonaktifkan Admin 1 pada saat bersamaan
				const crossDeactivate = await Promise.allSettled([
					updateUser(adminActor, secondAdminActor.id, { isActive: false }),
					updateUser(secondAdminActor, adminActor.id, { isActive: false })
				]);

				const fulfilled = crossDeactivate.filter((r) => r.status === 'fulfilled');
				const rejected = crossDeactivate.filter((r) => r.status === 'rejected');
				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(1);

				// Pastikan tetap ada minimal 1 ADMIN aktif di database
				const remainingActiveCount = await prisma.user.count({
					where: { role: 'ADMIN', isActive: true }
				});
				expect(remainingActiveCount).toBeGreaterThanOrEqual(1);

				// Pulihkan kedua admin uji agar test berikutnya tetap memiliki adminActor aktif
				await prisma.user.update({
					where: { id: adminActor.id },
					data: { isActive: true, role: 'ADMIN' }
				});
			} finally {
				if (otherExistingAdmins.length > 0) {
					await prisma.user.updateMany({
						where: { id: { in: otherExistingAdmins.map((a) => a.id) } },
						data: { isActive: true }
					});
				}
			}
		});
	});

	describe('4. CRUD Barang, Kode & QR Token Acak (BR-23), Cetak Ulang QR (BR-24), & Status Khusus (BR-11)', () => {
		let createdAssetId: string;
		let createdAssetCode: string;
		let createdQrToken: string;

		it('Membuat barang dengan kode AST-xxxx, qrToken acak, dan kelengkapan AccessoryTemplate', async () => {
			const res = await createAsset(adminActor, {
				name: 'Laptop ThinkPad X1 Carbon',
				categoryId,
				homeLocationId: locationId,
				serialNumber: `TP-X1-${randomUUID().slice(0, 6)}`,
				notes: 'Unit seminar utama',
				accessories: [
					{ name: 'Charger USB-C 65W', quantity: 1 },
					{ name: 'Tas Laptop', quantity: 1 }
				]
			});

			createdAssetId = res.asset.id;
			createdAssetCode = res.asset.code;
			createdQrToken = res.asset.qrToken;

			expect(createdAssetCode).toMatch(/^AST-\d{4,}$/);
			expect(createdQrToken.length).toBeGreaterThanOrEqual(20);
			expect(createdQrToken).not.toBe(createdAssetCode);
			expect(res.asset.accessories).toHaveLength(2);
		});

		it('Mendukung pencarian via QR token, pencarian manual via kode, dan detail barang', async () => {
			const byQr = await getAssetScanInfo(borrowerActor, { qrToken: createdQrToken });
			expect(byQr.asset.id).toBe(createdAssetId);
			expect(byQr.allowedActions).toContain('BORROW');
			expect(byQr.requiresApproval).toBe(true);

			const byCode = await getAssetScanInfo(officerActor, { code: createdAssetCode });
			expect(byCode.asset.id).toBe(createdAssetId);

			const detail = await getAssetDetail(adminActor, createdAssetId);
			expect(detail.asset.qrSvg).toContain('<svg');

			const listed = await listAssets(borrowerActor, { search: createdAssetCode });
			expect(listed.items.some((a) => a.id === createdAssetId)).toBe(true);
		});

		it('Mengubah barang dengan optimistic locking dan mencetak ulang label QR beserta AuditLog (BR-24)', async () => {
			const updated = await updateAsset(adminActor, createdAssetId, {
				name: 'Laptop ThinkPad X1 Carbon Gen 11',
				version: 0
			});
			expect(updated.asset.version).toBe(1);

			// Versi usang harus ditolak (optimistic locking)
			await expect(
				updateAsset(adminActor, createdAssetId, {
					name: 'Stale Update',
					version: 0
				})
			).rejects.toMatchObject({ status: 409 });

			// Cetak ulang QR tanpa rotasi token
			const reprint1 = await reprintAssetQr(adminActor, createdAssetId, {
				rotateToken: false,
				reason: 'Label lecet'
			});
			expect(reprint1.qrSvg).toContain('<svg');
			expect(reprint1.asset.qrToken).toBe(createdQrToken);

			// Cetak ulang QR dengan rotasi token
			const reprint2 = await reprintAssetQr(adminActor, createdAssetId, {
				rotateToken: true,
				reason: 'Label hilang'
			});
			expect(reprint2.asset.qrToken).not.toBe(createdQrToken);

			// Pastikan tercatat di AuditLog
			const logs = await listAuditLogs(adminActor, {
				entityType: 'Asset',
				entityId: createdAssetId,
				action: 'ASSET_QR_REPRINTED'
			});
			expect(logs.items.length).toBeGreaterThanOrEqual(2);
		});

		it('Menegakkan aturan perubahan status khusus LOST / AVAILABLE / RETIRED (BR-11 & Bagian 5.3)', async () => {
			// AVAILABLE -> LOST valid
			const lostRes = await changeAssetSpecialStatus(adminActor, createdAssetId, {
				status: 'LOST',
				note: 'Tidak ditemukan saat pengecekan ruang seminar'
			});
			expect(lostRes.asset.status).toBe('LOST');

			// LOST -> RETIRED tidak ada di tabel Bagian 5.3 -> wajib ditolak INVALID_STATUS_TRANSITION
			await expect(
				changeAssetSpecialStatus(adminActor, createdAssetId, {
					status: 'RETIRED',
					note: 'Langsung afkir dari hilang'
				})
			).rejects.toMatchObject({
				code: 'INVALID_STATUS_TRANSITION',
				status: 422
			});

			// LOST -> AVAILABLE (barang ditemukan) valid
			const foundRes = await changeAssetSpecialStatus(adminActor, createdAssetId, {
				status: 'AVAILABLE',
				note: 'Barang ditemukan kembali di ruang panitia'
			});
			expect(foundRes.asset.status).toBe('AVAILABLE');
		});

		it('Transisi BORROWED -> LOST menutup LoanItem aktif, menyelesaikan Loan induk, membebaskan tutup shift & nonaktif user, dapat dipinjam kembali saat LOST -> AVAILABLE, serta mengklaim status+version secara atomik (#2)', async () => {
			const suffix = randomUUID().slice(0, 8);
			const holder = await createUser(adminActor, {
				name: 'Peminjam Barang Hilang',
				email: `lost-holder-${suffix}@example.com`,
				password: 'StrongPassword!123',
				role: 'BORROWER',
				isActive: true
			});

			const assetRes = await createAsset(adminActor, {
				name: 'Kamera Liputan Lapangan',
				categoryId,
				homeLocationId: locationId
			});
			const lostAssetId = assetRes.asset.id;

			// Simulasikan barang sedang dipinjam aktif (BORROWED)
			await prisma.asset.update({
				where: { id: lostAssetId },
				data: { status: 'BORROWED', version: { increment: 1 } }
			});

			const loan = await prisma.loan.create({
				data: {
					borrowerId: holder.user.id,
					createdById: adminActor.id,
					purpose: 'Liputan Luar Kota',
					expectedReturnAt: new Date(Date.now() + 86400_000),
					status: 'ACTIVE'
				}
			});

			const loanItem = await prisma.loanItem.create({
				data: {
					loanId: loan.id,
					assetId: lostAssetId,
					returnedAt: null
				}
			});

			// Sebelum LOST: muncul di daftar barang keluar tutup shift & menghalangi nonaktif peminjam
			const outstandingBefore = await getActiveOutstandingLoanItems();
			expect(outstandingBefore.some((i) => i.loanItemId === loanItem.id)).toBe(true);
			await expect(
				updateUser(adminActor, holder.user.id, { isActive: false })
			).rejects.toMatchObject({ code: 'USER_HOLDS_ASSETS', status: 409 });

			// 1. Uji klaim atomik status+version: 2 panggilan paralel BORROWED -> LOST hanya 1 yang menang
			const parallelStatusCalls = await Promise.allSettled([
				changeAssetSpecialStatus(adminActor, lostAssetId, {
					status: 'LOST',
					note: 'Hilang di lokasi liputan banjir'
				}),
				changeAssetSpecialStatus(adminActor, lostAssetId, {
					status: 'LOST',
					note: 'Panggilan paralel duplikat'
				})
			]);

			const statusFulfilled = parallelStatusCalls.filter((r) => r.status === 'fulfilled');
			const statusRejected = parallelStatusCalls.filter((r) => r.status === 'rejected');
			expect(statusFulfilled).toHaveLength(1);
			expect(statusRejected).toHaveLength(1);

			// 2. Verifikasi LoanItem ditutup dengan returnedAt terisi, returnCondition null, dan damageNote tercatat
			const closedItem = await prisma.loanItem.findUniqueOrThrow({
				where: { id: loanItem.id }
			});
			expect(closedItem.returnedAt).not.toBeNull();
			expect(closedItem.returnCondition).toBeNull();
			expect(closedItem.damageNote).toContain('[Dinyatakan HILANG oleh Admin]');

			// 3. Verifikasi Loan induk otomatis menjadi COMPLETED karena seluruh itemnya sudah selesai
			const completedLoan = await prisma.loan.findUniqueOrThrow({
				where: { id: loan.id }
			});
			expect(completedLoan.status).toBe('COMPLETED');
			expect(completedLoan.completedAt).not.toBeNull();

			// 4. Verifikasi AuditLog tertulis untuk Asset, LoanItem, dan Loan
			const itemAudit = await listAuditLogs(adminActor, {
				entityType: 'LoanItem',
				entityId: loanItem.id,
				action: 'LOAN_ITEM_CLOSED_AS_LOST'
			});
			expect(itemAudit.items).toHaveLength(1);

			const loanAudit = await listAuditLogs(adminActor, {
				entityType: 'Loan',
				entityId: loan.id,
				action: 'LOAN_COMPLETED'
			});
			expect(loanAudit.items).toHaveLength(1);

			// 5. Barang LOST tidak lagi muncul di daftar barang keluar saat tutup shift
			const outstandingAfter = await getActiveOutstandingLoanItems();
			expect(outstandingAfter.some((i) => i.loanItemId === loanItem.id)).toBe(false);

			// 6. Peminjam tidak lagi terblokir USER_HOLDS_ASSETS saat dinonaktifkan
			const deactivatedHolder = await updateUser(adminActor, holder.user.id, {
				isActive: false
			});
			expect(deactivatedHolder.user.isActive).toBe(false);

			// 7. Bila barang ditemukan kembali (LOST -> AVAILABLE), barang dapat dipinjam kembali tanpa melanggar one_active_loan_per_asset
			const recovered = await changeAssetSpecialStatus(adminActor, lostAssetId, {
				status: 'AVAILABLE',
				note: 'Ditemukan kembali oleh petugas keamanan gedung'
			});
			expect(recovered.asset.status).toBe('AVAILABLE');

			const newLoan = await prisma.loan.create({
				data: {
					borrowerId: borrowerActor.id,
					createdById: adminActor.id,
					purpose: 'Peminjaman Baru Setelah Ditemukan',
					expectedReturnAt: new Date(Date.now() + 86400_000),
					status: 'ACTIVE'
				}
			});
			const newLoanItem = await prisma.loanItem.create({
				data: {
					loanId: newLoan.id,
					assetId: lostAssetId,
					returnedAt: null
				}
			});
			expect(newLoanItem.id).toBeTruthy();

			// Bersihkan pinjaman uji
			await prisma.loanItem.update({
				where: { id: newLoanItem.id },
				data: { returnedAt: new Date(), returnCondition: 'NORMAL' }
			});
		});

		it('Menolak serialNumber ganda dengan 400 VALIDATION_ERROR, menegakkan optimistic locking atomik pada updateAsset paralel (#4), serta menolak lokasi nonaktif pada createAsset, updateAsset, dan importAssetsFromCsv (#6)', async () => {
			const suffix = randomUUID().slice(0, 8);
			const duplicateSn = `SN-UNIK-${suffix}`;

			const assetA = await createAsset(adminActor, {
				name: 'Barang Pertama SN Unik',
				categoryId,
				homeLocationId: locationId,
				serialNumber: duplicateSn
			});

			// 1. createAsset dengan serialNumber yang sudah dipakai barang lain -> 400 VALIDATION_ERROR
			await expect(
				createAsset(adminActor, {
					name: 'Barang Duplikat SN',
					categoryId,
					homeLocationId: locationId,
					serialNumber: duplicateSn.toLowerCase()
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			const assetB = await createAsset(adminActor, {
				name: 'Barang Kedua SN Berbeda',
				categoryId,
				homeLocationId: locationId,
				serialNumber: `SN-B-${suffix}`
			});

			// 2. updateAsset mengubah serialNumber menjadi milik barang lain -> 400 VALIDATION_ERROR
			await expect(
				updateAsset(adminActor, assetB.asset.id, {
					serialNumber: duplicateSn
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 3. Optimistic locking atomik di dalam transaksi updateAsset: 2 update paralel dengan version=0 hanya 1 yang menang, 1 gagal 409
			const parallelUpdates = await Promise.allSettled([
				updateAsset(adminActor, assetA.asset.id, {
					name: 'Update Paralel 1',
					version: 0
				}),
				updateAsset(adminActor, assetA.asset.id, {
					name: 'Update Paralel 2',
					version: 0
				})
			]);
			expect(parallelUpdates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			const rejectedUpdate = parallelUpdates.find(
				(r): r is PromiseRejectedResult => r.status === 'rejected'
			);
			expect(rejectedUpdate?.reason).toMatchObject({ status: 409 });

			// 4. Buat lokasi nonaktif -> ditolak di createAsset, updateAsset, dan importAssetsFromCsv (#6)
			const inactiveLocName = `Gudang Lama Nonaktif ${suffix}`;
			const inactiveLoc = await createLocation(adminActor, {
				name: inactiveLocName,
				radiusM: 100,
				isActive: false
			});

			await expect(
				createAsset(adminActor, {
					name: 'Barang di Lokasi Nonaktif',
					categoryId,
					homeLocationId: inactiveLoc.location.id
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			await expect(
				updateAsset(adminActor, assetB.asset.id, {
					homeLocationId: inactiveLoc.location.id
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			const csvWithInactiveLoc = [
				'name,category,serialNumber,homeLocation',
				`Monitor Lokasi Nonaktif,${categoryName},SN-INACT-${suffix},${inactiveLocName}`
			].join('\n');
			const previewInactive = await importAssetsFromCsv(adminActor, {
				csvText: csvWithInactiveLoc,
				mode: 'preview'
			});
			expect(previewInactive.validCount).toBe(0);
			expect(previewInactive.failedCount).toBe(1);
			expect(previewInactive.errors[0].reason).toContain('dinonaktifkan');
		});
	});

	describe('5. Impor CSV dengan Pratinjau, Laporan Baris Gagal, & Idempotensi Nomor Seri (Bagian 18)', () => {
		it('Menampilkan pratinjau dengan baris valid dan baris gagal, lalu menyimpan secara idempoten saat commit', async () => {
			const sn1 = `CSV-SN-${randomUUID().slice(0, 8)}`;
			const sn2 = `CSV-SN-${randomUUID().slice(0, 8)}`;

			const csvText = [
				'name,category,serialNumber,homeLocation,purchasedAt,notes',
				`Kamera Sony Alpha,${categoryName},${sn1},${locationName},2026-01-15,Unit A`,
				`Microphone Wireless,${categoryName},${sn2},${locationName},2026-02-01,Unit B`,
				`Barang Kategori Salah,KategoriTidakAda,SN-ERR-1,${locationName},2026-02-01,Harus gagal`,
				`A,${categoryName},SN-ERR-2,LokasiTidakAda,tanggal-salah,Banyak error`
			].join('\n');

			// 1. Pratinjau (tidak menulis ke database)
			const preview = await importAssetsFromCsv(adminActor, {
				csvText,
				mode: 'preview'
			});

			expect(preview.mode).toBe('preview');
			expect(preview.totalRows).toBe(4);
			expect(preview.validCount).toBe(2);
			expect(preview.failedCount).toBe(2);
			expect(preview.errors).toHaveLength(2);
			expect(preview.errors[0].rowNumber).toBe(4);
			expect(preview.errors[1].rowNumber).toBe(5);

			// 2. Commit pertama: membuat 2 barang valid
			const commit1 = await importAssetsFromCsv(adminActor, {
				csvText,
				mode: 'commit'
			});
			expect(commit1.mode).toBe('commit');
			expect(commit1.createdCount).toBe(2);

			// 3. Commit kedua dengan CSV yang sama: idempoten berdasarkan serialNumber (0 dibuat, 2 dilewati)
			const commit2 = await importAssetsFromCsv(adminActor, {
				csvText,
				mode: 'commit'
			});
			expect(commit2.createdCount).toBe(0);
			expect(commit2.skippedDuplicateCount).toBe(2);
		});

		it('Membangkitkan kode otomatis AST-XXXX tanpa tabrakan saat 6 createAsset dipanggil secara paralel (pg_advisory_xact_lock)', async () => {
			const createdParallel = await Promise.all(
				Array.from({ length: 6 }, (_, idx) =>
					createAsset(adminActor, {
						name: `Barang Kode Otomatis Paralel #${idx + 1}`,
						categoryId,
						homeLocationId: locationId
					})
				)
			);

			expect(createdParallel).toHaveLength(6);
			const generatedCodes = createdParallel.map((c) => c.asset.code);
			const uniqueCodes = new Set(generatedCodes);
			expect(uniqueCodes.size).toBe(6);
			for (const code of generatedCodes) {
				expect(code).toMatch(/^AST-\d{4,}$/);
			}
		});

		it('Menolak parameter query status/UUID yang tidak sah pada endpoint GET dengan 400 VALIDATION_ERROR alih-alih 500 (#4)', async () => {
			function mockGetEvent(fullUrl: string) {
				return {
					url: new URL(fullUrl),
					locals: {
						requestId: 'req-zod-query-test',
						user: adminActor,
						sessionId: 'sess-zod-query-test'
					}
				} as never;
			}

			const badRequests = [
				getAssetsHandler(mockGetEvent('http://localhost:3000/api/v1/assets?status=SALAH')),
				getAssetsHandler(
					mockGetEvent('http://localhost:3000/api/v1/assets?categoryId=bukan-uuid')
				),
				getLoansHandler(mockGetEvent('http://localhost:3000/api/v1/loans?status=TIDAK_SAH')),
				getLoansHandler(
					mockGetEvent('http://localhost:3000/api/v1/loans?borrowerId=bukan-uuid')
				),
				getShiftsHandler(mockGetEvent('http://localhost:3000/api/v1/shifts?status=INVALID')),
				getSyncHandler(mockGetEvent('http://localhost:3000/api/v1/sync?status=NGACO')),
				getHandoversHandler(
					mockGetEvent('http://localhost:3000/api/v1/handovers?loanId=bukan-uuid')
				)
			];

			const responses = await Promise.all(badRequests);
			for (const res of responses) {
				expect(res.status).toBe(400);
				const body = await res.json();
				expect(body.error.code).toBe('VALIDATION_ERROR');
			}
		});
	});
});
