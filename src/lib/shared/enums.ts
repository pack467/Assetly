export const RoleLabels = {
	ADMIN: 'Admin',
	OFFICER: 'Petugas',
	BORROWER: 'Peminjam'
} as const;

export const AssetStatusLabels = {
	AVAILABLE: 'Tersedia',
	PENDING_APPROVAL: 'Menunggu persetujuan',
	BORROWED: 'Dipinjam',
	DAMAGED: 'Rusak',
	IN_MAINTENANCE: 'Dalam perbaikan',
	LOST: 'Hilang',
	RETIRED: 'Afkir'
} as const;

export const RiskLevelLabels = {
	NORMAL: 'Normal',
	NEEDS_REVIEW: 'Perlu dicek',
	SUSPICIOUS: 'Mencurigakan'
} as const;

export const LoanStatusLabels = {
	ACTIVE: 'Aktif',
	COMPLETED: 'Selesai',
	PENDING_APPROVAL: 'Menunggu persetujuan',
	REJECTED: 'Ditolak',
	CANCELLED: 'Dibatalkan'
} as const;

export type AssetStatusKey = keyof typeof AssetStatusLabels;

const ALLOWED_ASSET_TRANSITIONS: Record<AssetStatusKey, readonly AssetStatusKey[]> = {
	AVAILABLE: ['PENDING_APPROVAL', 'BORROWED', 'IN_MAINTENANCE', 'LOST'],
	PENDING_APPROVAL: ['BORROWED', 'AVAILABLE'],
	BORROWED: ['AVAILABLE', 'DAMAGED', 'LOST'],
	DAMAGED: ['IN_MAINTENANCE', 'AVAILABLE', 'RETIRED', 'LOST'],
	IN_MAINTENANCE: ['AVAILABLE', 'RETIRED'],
	LOST: ['AVAILABLE'],
	RETIRED: []
};

export function isValidAssetStatusTransition(from: AssetStatusKey, to: AssetStatusKey): boolean {
	return ALLOWED_ASSET_TRANSITIONS[from]?.includes(to) ?? false;
}
