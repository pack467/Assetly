import { AppError } from '$lib/shared/errors';

export type PolicyRole = 'ADMIN' | 'OFFICER' | 'BORROWER';

export interface PolicyUser {
	id: string;
	role: PolicyRole;
	isActive?: boolean;
}

export type PolicyAction =
	| 'asset:read'
	| 'master:manage'
	| 'loan:create'
	| 'loan:approve'
	| 'loan:cancel'
	| 'loan:return'
	| 'loan:read'
	| 'handover:create'
	| 'handover:confirm'
	| 'shift:manage'
	| 'shift:read_all'
	| 'ticket:create'
	| 'ticket:manage'
	| 'asset:set_terminal_status'
	| 'risk:read'
	| 'audit:read'
	| 'map:read'
	| 'report:read'
	| 'session:revoke';

export interface PolicyResource {
	borrowerId?: string;
	createdById?: string;
	giverId?: string;
	receiverId?: string;
	userId?: string;
	handledByOfficer?: boolean;
}

/**
 * Fungsi kebijakan otorisasi terpusat sesuai Bagian 3.2 PROJECT_SPEC.md.
 * Semua endpoint wajib memanggil can() / assertCan() di server (BR-03).
 */
export function can(
	user: PolicyUser | null | undefined,
	action: PolicyAction,
	resource?: PolicyResource
): boolean {
	if (!user || user.isActive === false) {
		return false;
	}

	const role = user.role;

	switch (action) {
		// Login, scan QR, lihat info barang: Semua role
		case 'asset:read':
			return role === 'ADMIN' || role === 'OFFICER' || role === 'BORROWER';

		// Kelola user, kategori, lokasi, barang, impor CSV, cetak QR: Hanya ADMIN
		case 'master:manage':
			return role === 'ADMIN';

		// Membuat peminjaman: ADMIN, OFFICER, atau BORROWER (hanya untuk dirinya sendiri)
		case 'loan:create':
			if (role === 'ADMIN' || role === 'OFFICER') return true;
			if (role === 'BORROWER') {
				return !resource?.borrowerId || resource.borrowerId === user.id;
			}
			return false;

		// Menyetujui / menolak peminjaman: Hanya ADMIN
		case 'loan:approve':
			return role === 'ADMIN';

		// Membatalkan peminjaman sebelum disetujui: ADMIN atau peminjam pemilik
		case 'loan:cancel':
			if (role === 'ADMIN') return true;
			return Boolean(resource?.borrowerId && resource.borrowerId === user.id);

		// Mengembalikan barang: ADMIN, OFFICER, atau BORROWER (hanya peminjaman miliknya)
		case 'loan:return':
			if (role === 'ADMIN' || role === 'OFFICER') return true;
			if (role === 'BORROWER') {
				return Boolean(resource?.borrowerId && resource.borrowerId === user.id);
			}
			return false;

		// Melihat peminjaman: ADMIN (semua), OFFICER (peminjaman/shift yang ditangani), BORROWER (miliknya)
		case 'loan:read':
			if (role === 'ADMIN') return true;
			if (role === 'OFFICER') {
				if (!resource) return true;
				return (
					resource.handledByOfficer === true ||
					resource.createdById === user.id ||
					resource.borrowerId === user.id
				);
			}
			if (role === 'BORROWER') {
				if (!resource) return true;
				return resource.borrowerId === user.id;
			}
			return false;

		// Membuat / konfirmasi serah terima: ADMIN, OFFICER, atau BORROWER (sebagai penerima/pemberi)
		case 'handover:create':
		case 'handover:confirm':
			if (role === 'ADMIN' || role === 'OFFICER') return true;
			if (role === 'BORROWER') {
				return (
					resource?.giverId === user.id ||
					resource?.receiverId === user.id ||
					resource?.borrowerId === user.id
				);
			}
			return false;

		// Buka / tutup shift: ADMIN dan OFFICER
		case 'shift:manage':
			return role === 'ADMIN' || role === 'OFFICER';

		case 'shift:read_all':
			return role === 'ADMIN';

		// Membuat tiket perbaikan: ADMIN dan OFFICER (melapor)
		case 'ticket:create':
			return role === 'ADMIN' || role === 'OFFICER';

		// Mengubah status tiket, menetapkan hasil: Hanya ADMIN
		case 'ticket:manage':
			return role === 'ADMIN';

		// Menetapkan status LOST / RETIRED: Hanya ADMIN (BR-11)
		case 'asset:set_terminal_status':
			return role === 'ADMIN';

		// Melihat peta, risiko, audit log, laporan penuh, cabut sesi: Hanya ADMIN
		case 'risk:read':
		case 'audit:read':
		case 'map:read':
		case 'report:read':
		case 'session:revoke':
			return role === 'ADMIN';

		default:
			return false;
	}
}

export function assertCan(
	user: PolicyUser | null | undefined,
	action: PolicyAction,
	resource?: PolicyResource
): asserts user is PolicyUser {
	if (!user || user.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid atau telah berakhir.');
	}
	if (!can(user, action, resource)) {
		throw new AppError('FORBIDDEN', 'Anda tidak memiliki hak akses untuk melakukan aksi ini.');
	}
}
