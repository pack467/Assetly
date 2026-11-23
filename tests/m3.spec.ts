import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/server/db';
import type { PolicyUser } from '../src/lib/server/policy';
import { uploadEvidence } from '../src/lib/server/services/evidenceService';
import {
	createLoan,
	returnLoanItem,
	listLoans,
	getDashboardSummary
} from '../src/lib/server/services/loanService';
import { getAssetScanInfo } from '../src/lib/server/services/assetService';
import { updateUser } from '../src/lib/server/services/userService';
import {
	createHandover,
	confirmHandover,
	listHandovers
} from '../src/lib/server/services/handoverService';
import {
	openShift,
	getCurrentShiftState,
	closeShift,
	listShifts
} from '../src/lib/server/services/shiftService';
import { parseAllowedCorsOrigins, getCorsHeadersForOrigin } from '../src/lib/server/cors';
import { handle } from '../src/hooks.server';

const VALID_JPEG_BUFFER = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
	0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
]);

describe('M3: Serah Terima Dua Pihak (Handover), Buka/Tutup Shift (BR-12), Aturan Evidence, & Hak Akses', () => {
	let adminActor: PolicyUser;
	let officer1: PolicyUser;
	let officer2: PolicyUser;
	let borrower1: PolicyUser;
	let borrower2: PolicyUser;
	let categoryId: string;
	let locationId: string;

	beforeAll(async () => {
		await prisma.$connect();
		const suffix = randomUUID().slice(0, 8);

		const [uAdmin, uOff1, uOff2, uBor1, uBor2] = await Promise.all([
			prisma.user.create({
				data: {
					name: 'Admin M3',
					email: `m3-admin-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'ADMIN',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Petugas Shift Pagi',
					email: `m3-off1-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'OFFICER',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Petugas Shift Sore',
					email: `m3-off2-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'OFFICER',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Peminjam 1 M3',
					email: `m3-b1-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			}),
			prisma.user.create({
				data: {
					name: 'Peminjam 2 M3',
					email: `m3-b2-${suffix}@example.com`,
					passwordHash: 'hash',
					role: 'BORROWER',
					isActive: true
				}
			})
		]);

		adminActor = { id: uAdmin.id, role: 'ADMIN', isActive: true };
		officer1 = { id: uOff1.id, role: 'OFFICER', isActive: true };
		officer2 = { id: uOff2.id, role: 'OFFICER', isActive: true };
		borrower1 = { id: uBor1.id, role: 'BORROWER', isActive: true };
		borrower2 = { id: uBor2.id, role: 'BORROWER', isActive: true };

		const [cat, loc] = await Promise.all([
			prisma.category.create({
				data: { name: `Kategori M3 ${suffix}`, requiresApproval: false }
			}),
			prisma.location.create({
				data: {
					name: `Lokasi M3 ${suffix}`,
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

	describe('1. Alur Serah Terima Dua Pihak (Handover — Bagian 7.2, BR-20, BR-21)', () => {
		let activeLoanId: string;
		let activeLoanItemId: string;

		beforeAll(async () => {
			const suffix = randomUUID().slice(0, 8);
			const asset = await prisma.asset.create({
				data: {
					code: `AST-M3H-${suffix}`,
					qrToken: `qr-m3h-${randomUUID()}`,
					name: 'Laptop Seminar Handover',
					categoryId,
					status: 'AVAILABLE'
				}
			});

			const checkoutEv = await createEvidenceForActor(officer1, 'CHECKOUT');
			const loanRes = await createLoan(officer1, {
				borrowerId: borrower1.id,
				assetId: asset.id,
				evidenceId: checkoutEv.id,
				purpose: 'Seminar M3',
				expectedReturnAt: new Date(Date.now() + 86400_000).toISOString()
			});
			activeLoanId = loanRes.loan.id;
			activeLoanItemId = loanRes.loan.items[0].id;
		});

		afterAll(async () => {
			// Kembalikan barang agar database bersih untuk test tutup shift tanpa barang tertinggal
			const retEv = await createEvidenceForActor(officer1, 'RETURN');
			await returnLoanItem(officer1, activeLoanItemId, {
				returnCondition: 'NORMAL',
				evidenceId: retEv.id
			});
		});

		it('menolak serah terima satu pihak (giverId === receiverId, BR-20)', async () => {
			await expect(
				createHandover(borrower1, {
					loanId: activeLoanId,
					giverId: borrower1.id,
					receiverId: borrower1.id,
					autoConfirmGiver: true
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});
		});

		it('menegakkan aturan Evidence pada serah terima: purpose wajib HANDOVER, milik pelaku, dan sekali pakai', async () => {
			// 1. Foto CHECKOUT ditolak dipakai untuk Handover
			const wrongPurposeEv = await createEvidenceForActor(officer1, 'CHECKOUT');
			await expect(
				createHandover(officer1, {
					loanId: activeLoanId,
					giverId: officer1.id,
					receiverId: borrower1.id,
					evidenceId: wrongPurposeEv.id,
					autoConfirmGiver: true
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 2. Foto HANDOVER milik borrower2 ditolak bila dipakai oleh officer1
			const otherUserEv = await createEvidenceForActor(borrower2, 'HANDOVER');
			await expect(
				createHandover(officer1, {
					loanId: activeLoanId,
					giverId: officer1.id,
					receiverId: borrower1.id,
					evidenceId: otherUserEv.id,
					autoConfirmGiver: true
				})
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});
		});

		it('menjalankan serah terima dua pihak (Petugas -> Peminjam), menampilkan yang belum dikonfirmasi di dashboard, dan menerbitkan documentNo setelah kedua pihak konfirmasi', async () => {
			const handoverEv = await createEvidenceForActor(officer1, 'HANDOVER');

			// 1. Petugas (giver) membuat serah terima ke Peminjam 1 (receiver)
			const createdRes = await createHandover(officer1, {
				loanId: activeLoanId,
				giverId: officer1.id,
				receiverId: borrower1.id,
				evidenceId: handoverEv.id,
				autoConfirmGiver: true
			});

			const handoverId = createdRes.handover.id;
			expect(createdRes.handover.giverConfirmedAt).not.toBeNull();
			expect(createdRes.handover.receiverConfirmedAt).toBeNull();
			expect(createdRes.handover.isConfirmed).toBe(false);
			expect(createdRes.handover.documentNo).toBeNull();

			// 2. Foto bukti yang sudah dipakai pada handover pertama tidak boleh dipakai ulang (DUPLICATE_OPERATION)
			await expect(
				createHandover(officer1, {
					loanId: activeLoanId,
					giverId: officer1.id,
					receiverId: borrower1.id,
					evidenceId: handoverEv.id,
					autoConfirmGiver: true
				})
			).rejects.toMatchObject({
				code: 'DUPLICATE_OPERATION',
				status: 409
			});

			// 3. Serah terima yang belum lengkap konfirmasinya muncul di dashboard admin (BR-21)
			const dashboardBefore = await getDashboardSummary(adminActor);
			expect(dashboardBefore.loans.unconfirmedHandoversCount).toBeGreaterThanOrEqual(1);

			// 4. Pihak ketiga yang tidak terlibat (borrower2) ditolak mengonfirmasi serah terima ini
			await expect(confirmHandover(borrower2, handoverId, {})).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			// 5. Penerima (borrower1) menekan konfirmasi -> kedua pihak terkonfirmasi & documentNo terbit
			const confirmedRes = await confirmHandover(borrower1, handoverId, {});
			expect(confirmedRes.handover.giverConfirmedAt).not.toBeNull();
			expect(confirmedRes.handover.receiverConfirmedAt).not.toBeNull();
			expect(confirmedRes.handover.isConfirmed).toBe(true);
			expect(confirmedRes.handover.documentNo).toMatch(/^BA-\d{8}-[A-F0-9]{6}$/);

			const listed = await listHandovers(borrower1, { loanId: activeLoanId });
			expect(listed.items.some((h) => h.id === handoverId && h.isConfirmed)).toBe(true);
		});

		it('memindahkan pemegang barang (Loan.borrowerId) ke penerima setelah serah terima dikonfirmasi kedua pihak (Pilihan a: currentHolder, Pinjaman Saya, tutup shift, USER_HOLDS_ASSETS, & AuditLog)', async () => {
			// Saat ini activeLoanId dipegang oleh borrower1. Buat serah terima dari borrower1 (giver) ke borrower2 (receiver)
			const hoToB2 = await createHandover(borrower1, {
				loanId: activeLoanId,
				giverId: borrower1.id,
				receiverId: borrower2.id,
				autoConfirmGiver: true
			});

			// Sebelum borrower2 konfirmasi, pemegang masih borrower1
			const loanBefore = await prisma.loan.findUniqueOrThrow({ where: { id: activeLoanId } });
			expect(loanBefore.borrowerId).toBe(borrower1.id);

			// Borrower2 mengonfirmasi sebagai penerima -> kedua pihak lengkap -> pemegang berpindah ke borrower2
			const confirmed = await confirmHandover(borrower2, hoToB2.handover.id, {});
			expect(confirmed.handover.isConfirmed).toBe(true);
			expect(confirmed.handover.loan.borrower.id).toBe(borrower2.id);

			// 1. Cek AuditLog LOAN_HOLDER_TRANSFERRED tercatat
			const transferLog = await prisma.auditLog.findFirst({
				where: {
					entityType: 'Loan',
					entityId: activeLoanId,
					action: 'LOAN_HOLDER_TRANSFERRED'
				}
			});
			expect(transferLog).not.toBeNull();

			// 2. Cek currentHolder pada info scan barang kini adalah borrower2 dan borrower2 punya aksi RETURN
			const assetId = confirmed.handover.loan.items[0].asset.id;
			const assetCode = confirmed.handover.loan.items[0].asset.code;
			const scanForB2 = await getAssetScanInfo(borrower2, { code: assetCode });
			expect(scanForB2.currentHolder).toBe('Peminjam 2 M3');
			expect(scanForB2.allowedActions).toContain('RETURN');

			// 3. Cek daftar "Pinjaman Saya" milik borrower2 kini memuat pinjaman ini, sedangkan borrower1 tidak lagi menjadi pemegang
			const b2Loans = await listLoans(borrower2, { status: 'ACTIVE' });
			expect(b2Loans.items.some((l) => l.id === activeLoanId)).toBe(true);

			// 4. Cek penanggung jawab bawaan tutup shift (defaultResponsibleUserId) kini menunjuk ke borrower2
			const shiftState = await getCurrentShiftState(officer1);
			const outItem = shiftState.outstandingItems.find((i) => i.asset.id === assetId);
			expect(outItem?.defaultResponsibleUserId).toBe(borrower2.id);

			// 5. Cek aturan USER_HOLDS_ASSETS (BR-16): borrower2 tidak boleh dinonaktifkan karena kini memegang barang aktif
			await expect(updateUser(adminActor, borrower2.id, { isActive: false })).rejects.toMatchObject(
				{
					code: 'USER_HOLDS_ASSETS',
					status: 409
				}
			);
		});

		it('menangani 3 kasus batas serah terima: petugas -> peminjam awal (tanpa perpindahan), dua serah terima dari pemberi yang sama (konflik & superseded), dan konfirmasi setelah barang dikembalikan', async () => {
			// Buat aset khusus & pinjaman awal untuk borrower1
			const edgeAsset = await prisma.asset.create({
				data: {
					code: `AST-M3-EDGE-${randomUUID().slice(0, 6).toUpperCase()}`,
					qrToken: randomUUID(),
					name: 'Laptop Uji Kasus Batas Handover',
					categoryId,
					homeLocationId: locationId
				}
			});
			const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
			const createdLoan = await createLoan(borrower1, {
				assetId: edgeAsset.id,
				evidenceId: checkoutEv.id,
				purpose: 'Uji Kasus Batas Handover',
				expectedReturnAt: new Date(Date.now() + 86400_000).toISOString()
			});
			const edgeLoanId = createdLoan.loan.id;
			const edgeLoanItemId = createdLoan.loan.items[0].id;

			// KASUS A: Petugas (officer1) menyerahkan fisik barang ke peminjam awal (borrower1) yang sudah tercatat sebagai loan.borrowerId
			const hoOfficerEv = await createEvidenceForActor(officer1, 'HANDOVER');
			const hoInitial = await createHandover(officer1, {
				loanId: edgeLoanId,
				receiverId: borrower1.id,
				evidenceId: hoOfficerEv.id,
				note: 'Penyerahan fisik awal dari gudang oleh petugas'
			});
			const confirmedInitial = await confirmHandover(borrower1, hoInitial.handover.id);
			expect(confirmedInitial.handover.loan.borrowerId).toBe(borrower1.id);

			// Pastikan TIDAK ada AuditLog LOAN_HOLDER_TRANSFERRED untuk penyerahan awal ke peminjam yang sudah sama
			const initialTransferLog = await prisma.auditLog.findFirst({
				where: {
					entityType: 'Loan',
					entityId: edgeLoanId,
					action: 'LOAN_HOLDER_TRANSFERRED'
				}
			});
			expect(initialTransferLog).toBeNull();

			// KASUS B: Pemegang saat ini (borrower1) membuat DUA serah terima gantung:
			// Handover #1: borrower1 -> borrower2
			// Handover #2: borrower1 -> officer1
			const hoDup1Ev = await createEvidenceForActor(borrower1, 'HANDOVER');
			const hoDup1 = await createHandover(borrower1, {
				loanId: edgeLoanId,
				receiverId: borrower2.id,
				evidenceId: hoDup1Ev.id,
				note: 'Handover 1 ke borrower2'
			});

			const hoDup2Ev = await createEvidenceForActor(borrower1, 'HANDOVER');
			const hoDup2 = await createHandover(borrower1, {
				loanId: edgeLoanId,
				receiverId: officer1.id,
				evidenceId: hoDup2Ev.id,
				note: 'Handover 2 ke officer1'
			});

			// Saat borrower2 mengonfirmasi Handover #1, pemegang berpindah ke borrower2
			// dan Handover #2 otomatis dibatalkan (superseded)
			const confirmedDup1 = await confirmHandover(borrower2, hoDup1.handover.id);
			expect(confirmedDup1.handover.loan.borrowerId).toBe(borrower2.id);

			const supersededRecord = await prisma.handover.findUniqueOrThrow({
				where: { id: hoDup2.handover.id }
			});
			expect(supersededRecord.documentNo).toMatch(/^SUPERSEDED-/);

			const supersededAudit = await prisma.auditLog.findFirst({
				where: {
					entityType: 'Handover',
					entityId: hoDup2.handover.id,
					action: 'HANDOVER_SUPERSEDED'
				}
			});
			expect(supersededAudit).not.toBeNull();

			// Jika officer1 mencoba mengonfirmasi Handover #2 setelah pemegang sudah berpindah ke borrower2 -> DITOLAK (409 INVALID_STATUS_TRANSITION)
			await expect(confirmHandover(officer1, hoDup2.handover.id)).rejects.toMatchObject({
				code: 'INVALID_STATUS_TRANSITION',
				status: 409
			});

			// Jika borrower1 (yang sudah bukan pemegang lagi) mencoba membuat handover baru -> DITOLAK (409 INVALID_STATUS_TRANSITION)
			const hoStaleGiverEv = await createEvidenceForActor(borrower1, 'HANDOVER');
			await expect(
				createHandover(borrower1, {
					loanId: edgeLoanId,
					receiverId: officer1.id,
					evidenceId: hoStaleGiverEv.id
				})
			).rejects.toMatchObject({
				code: 'INVALID_STATUS_TRANSITION',
				status: 409
			});

			// KASUS C: Konfirmasi setelah barang sudah dikembalikan (Loan COMPLETED)
			// Pertama, pemegang sah saat ini (borrower2) membuat handover ke borrower1 (masih belum dikonfirmasi)
			const hoBeforeReturnEv = await createEvidenceForActor(borrower2, 'HANDOVER');
			const hoBeforeReturn = await createHandover(borrower2, {
				loanId: edgeLoanId,
				receiverId: borrower1.id,
				evidenceId: hoBeforeReturnEv.id,
				note: 'Handover dibuat sebelum barang dikembalikan'
			});

			// Lalu barang dikembalikan ke gudang sehingga Loan menjadi COMPLETED
			const returnEv = await createEvidenceForActor(borrower2, 'RETURN');
			const returned = await returnLoanItem(borrower2, edgeLoanItemId, {
				returnCondition: 'NORMAL',
				evidenceId: returnEv.id
			});
			expect(returned.loan.status).toBe('COMPLETED');

			// Setelah Loan selesai (COMPLETED), borrower1 mencoba mengonfirmasi handover gantung tadi -> WAJIB DITOLAK (409 INVALID_STATUS_TRANSITION)
			await expect(confirmHandover(borrower1, hoBeforeReturn.handover.id)).rejects.toMatchObject({
				code: 'INVALID_STATUS_TRANSITION',
				status: 409
			});

			// Dan pemegang historis pada Loan yang sudah selesai TIDAK boleh berubah (tetap borrower2)
			const finalLoan = await prisma.loan.findUniqueOrThrow({ where: { id: edgeLoanId } });
			expect(finalLoan.status).toBe('COMPLETED');
			expect(finalLoan.borrowerId).toBe(borrower2.id);
		});
	});

	describe('2. Buka & Tutup Shift (Tanpa Barang Tertinggal vs Dengan Barang Tertinggal — Bagian 7.4 & BR-12)', () => {
		beforeAll(async () => {
			// Pastikan seluruh LoanItem aktif dari suite test sebelumnya sudah dikembalikan agar kondisi awal bersih
			await prisma.loanItem.updateMany({
				where: { returnedAt: null },
				data: { returnedAt: new Date(), returnCondition: 'NORMAL' }
			});
		});

		it('menolak BORROWER untuk membuka shift, melihat shift aktif, menutup shift, atau membaca laporan shift (Bagian 3.2)', async () => {
			await expect(openShift(borrower1, { note: 'Tidak boleh' })).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			await expect(getCurrentShiftState(borrower1)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			await expect(closeShift(borrower1, randomUUID(), { items: [] })).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			await expect(listShifts(borrower1)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			// OFFICER juga ditolak melihat laporan seluruh shift (hanya ADMIN)
			await expect(listShifts(officer1)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});
		});

		it('dapat membuka dan menutup shift dengan bersih saat tidak ada barang yang masih keluar', async () => {
			const opened = await openShift(officer1, { note: 'Shift Pagi Bersih' });
			expect(opened.shift.status).toBe('OPEN');

			// Menolak buka shift kedua bila shift pertama masih OPEN
			await expect(openShift(officer1, { note: 'Shift Ganda' })).rejects.toMatchObject({
				code: 'DUPLICATE_OPERATION',
				status: 409
			});

			const state = await getCurrentShiftState(officer1);
			expect(state.currentShift?.id).toBe(opened.shift.id);
			expect(state.outstandingItems).toHaveLength(0);

			const closed = await closeShift(officer1, opened.shift.id, {
				note: 'Semua barang sudah kembali lengkap',
				items: []
			});
			expect(closed.shift.status).toBe('CLOSED');
			expect(closed.shift.closedAt).not.toBeNull();
			expect(closed.shift.items).toHaveLength(0);
		});

		it('mewajibkan alasan untuk setiap barang yang masih keluar saat tutup shift (BR-12) dan menampilkan catatan tersebut ke petugas shift berikutnya', async () => {
			const suffix = randomUUID().slice(0, 8);
			const assetOut = await prisma.asset.create({
				data: {
					code: `AST-SHF-${suffix}`,
					qrToken: `qr-shf-${randomUUID()}`,
					name: 'Proyektor Acara Malam',
					categoryId,
					status: 'AVAILABLE'
				}
			});

			// 1. Petugas 1 membuka shift
			const shift1 = await openShift(officer1, { note: 'Shift Pagi Ada Barang Tertinggal' });

			// 2. Ada 1 barang dipinjam oleh borrower1 dan belum kembali
			const checkoutEv = await createEvidenceForActor(borrower1, 'CHECKOUT');
			const activeLoan = await createLoan(borrower1, {
				assetId: assetOut.id,
				evidenceId: checkoutEv.id,
				purpose: 'Seminar Malam',
				expectedReturnAt: new Date(Date.now() + 86400_000).toISOString()
			});
			const activeLoanItemId = activeLoan.loan.items[0].id;

			// 3. Server menampilkan barang keluar dari database
			const currentState = await getCurrentShiftState(officer1);
			expect(currentState.outstandingItems.some((i) => i.loanItemId === activeLoanItemId)).toBe(
				true
			);

			// 4. Petugas lain (officer2) ditolak menutup shift milik officer1
			await expect(
				closeShift(officer2, shift1.shift.id, {
					items: [
						{
							loanItemId: activeLoanItemId,
							reason: 'Acara masih berlanjut'
						}
					]
				})
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				status: 403
			});

			// 5. Percobaan menutup shift TANPA alasan untuk barang yang masih keluar wajib ditolak (BR-12)
			await expect(
				closeShift(officer1, shift1.shift.id, {
					note: 'Coba tutup tanpa alasan',
					items: []
				})
			).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 400
			});

			// 6. Menutup shift dengan alasan tiap barang keluar (+ foto bukti HANDOVER sekali pakai) berhasil
			const shiftCloseEv = await createEvidenceForActor(officer1, 'HANDOVER');
			const closedShift1 = await closeShift(officer1, shift1.shift.id, {
				note: 'Diserahterimakan ke shift sore',
				evidenceId: shiftCloseEv.id,
				items: [
					{
						loanItemId: activeLoanItemId,
						reason: 'Acara seminar di Ruang Utama masih berlangsung sampai pukul 20.00'
					}
				]
			});

			expect(closedShift1.shift.status).toBe('CLOSED');
			expect(closedShift1.shift.items).toHaveLength(1);
			// BR-12: responsibleUserId bawaan = peminjam pada Loan tersebut
			expect(closedShift1.shift.items[0].responsibleUserId).toBe(borrower1.id);
			expect(closedShift1.shift.items[0].reason).toContain('masih berlangsung');

			// 7. Foto bukti yang sudah dipakai pada tutup shift tidak boleh dipakai ulang (DUPLICATE_OPERATION)
			await expect(
				createHandover(officer1, {
					loanId: activeLoan.loan.id,
					giverId: officer1.id,
					receiverId: borrower1.id,
					evidenceId: shiftCloseEv.id
				})
			).rejects.toMatchObject({
				code: 'DUPLICATE_OPERATION',
				status: 409
			});

			// 8. Petugas shift berikutnya (officer2) melihat catatan barang tertinggal dari shift sebelumnya
			const nextOfficerState = await getCurrentShiftState(officer2);
			expect(nextOfficerState.previousClosedShift?.id).toBe(shift1.shift.id);
			expect(nextOfficerState.previousClosedShift?.items).toHaveLength(1);
			expect(nextOfficerState.previousClosedShift?.items[0].loanItemId).toBe(activeLoanItemId);

			// 9. Admin melihat laporan shift lengkap di GET /api/v1/shifts
			const adminShiftReport = await listShifts(adminActor, { status: 'CLOSED' });
			expect(adminShiftReport.items.some((s) => s.id === shift1.shift.id)).toBe(true);
		});
	});

	describe('3. Penanganan CORS Ketat untuk Origin Capacitor (Bagian 12)', () => {
		it('mengizinkan origin https://localhost dan capacitor://localhost serta menolak origin asing dan wildcard (*)', () => {
			const allowed = parseAllowedCorsOrigins('https://localhost, capacitor://localhost');
			expect(allowed.has('https://localhost')).toBe(true);
			expect(allowed.has('capacitor://localhost')).toBe(true);

			const headersCapHttps = getCorsHeadersForOrigin('https://localhost', allowed);
			expect(headersCapHttps?.['access-control-allow-origin']).toBe('https://localhost');
			expect(headersCapHttps?.vary).toBe('Origin');

			const headersCapScheme = getCorsHeadersForOrigin('capacitor://localhost', allowed);
			expect(headersCapScheme?.['access-control-allow-origin']).toBe('capacitor://localhost');

			// Origin tidak dikenal wajib ditolak (null)
			expect(getCorsHeadersForOrigin('https://evil.example.com', allowed)).toBeNull();

			// Wildcard (*) wajib ditolak
			expect(() => parseAllowedCorsOrigins('*')).toThrowError(/tidak boleh menggunakan wildcard/);
			expect(() => parseAllowedCorsOrigins('https://localhost, *')).toThrowError(
				/tidak boleh menggunakan wildcard/
			);
			expect(() => parseAllowedCorsOrigins('https://*.example.com')).toThrowError(
				/tidak boleh menggunakan wildcard/
			);
		});

		it('merespons preflight OPTIONS 204 untuk origin Capacitor yang sah dan 403 untuk origin yang tidak sah di hooks.server.ts', async () => {
			const prevCors = process.env.CORS_ALLOWED_ORIGINS;
			try {
				process.env.CORS_ALLOWED_ORIGINS = 'https://localhost,capacitor://localhost';

				// 1. Preflight OPTIONS dari https://localhost -> 204 No Content dengan header CORS lengkap
				const okPreflight = await handle({
					event: {
						request: new Request('http://localhost:5173/api/v1/loans', {
							method: 'OPTIONS',
							headers: {
								origin: 'https://localhost',
								'access-control-request-method': 'POST'
							}
						}),
						url: new URL('http://localhost:5173/api/v1/loans'),
						locals: {} as App.Locals,
						cookies: { get: () => undefined } as never
					} as never,
					resolve: async () => new Response('Should not reach resolve on OPTIONS')
				});

				expect(okPreflight.status).toBe(204);
				expect(okPreflight.headers.get('access-control-allow-origin')).toBe('https://localhost');
				expect(okPreflight.headers.get('access-control-allow-methods')).toContain('POST');
				expect(okPreflight.headers.get('access-control-allow-headers')).toContain('Authorization');

				// 2. Preflight OPTIONS dari origin asing -> 403 Forbidden tanpa header Access-Control-Allow-Origin
				const blockedPreflight = await handle({
					event: {
						request: new Request('http://localhost:5173/api/v1/loans', {
							method: 'OPTIONS',
							headers: {
								origin: 'https://attacker.invalid'
							}
						}),
						url: new URL('http://localhost:5173/api/v1/loans'),
						locals: {} as App.Locals,
						cookies: { get: () => undefined } as never
					} as never,
					resolve: async () => new Response('Should not reach resolve on OPTIONS')
				});

				expect(blockedPreflight.status).toBe(403);
				expect(blockedPreflight.headers.get('access-control-allow-origin')).toBeNull();
			} finally {
				process.env.CORS_ALLOWED_ORIGINS = prevCors;
			}
		});
	});
});
