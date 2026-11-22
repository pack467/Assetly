export type WatermarkActionLabel = 'PINJAM' | 'KEMBALI' | 'SERAH TERIMA';

export interface WatermarkMetadata {
	actionLabel: WatermarkActionLabel;
	assetName: string;
	assetCode: string;
	userName: string;
	takenAt: Date;
	gpsAvailable: boolean;
	latitude?: number | null;
	longitude?: number | null;
	accuracyM?: number | null;
	locationName?: string | null;
}

export interface Canvas2DWatermarkTarget {
	fillStyle: string | CanvasGradient | CanvasPattern;
	font: string;
	textBaseline?: string;
	fillRect(x: number, y: number, w: number, h: number): void;
	fillText(text: string, x: number, y: number): void;
}

export interface LocationCandidate {
	id: string;
	name: string;
	latitude: number | null;
	longitude: number | null;
	radiusM: number;
}

export const MAX_IMAGE_DIMENSION_PX = 1280;
export const DEFAULT_JPEG_QUALITY = 0.82;

/**
 * Menghitung dimensi gambar hasil kompresi agar sisi terpanjang <= maxDimension (bawaan 1280 px, Bagian 9.1).
 * Tidak memperbesar gambar yang sudah lebih kecil dari maxDimension.
 */
export function computeCompressedDimensions(
	srcWidth: number,
	srcHeight: number,
	maxDimension = MAX_IMAGE_DIMENSION_PX
): { width: number; height: number } {
	if (srcWidth <= 0 || srcHeight <= 0 || Number.isNaN(srcWidth) || Number.isNaN(srcHeight)) {
		throw new Error('Dimensi gambar sumber tidak valid.');
	}

	const longestSide = Math.max(srcWidth, srcHeight);
	if (longestSide <= maxDimension) {
		return {
			width: Math.round(srcWidth),
			height: Math.round(srcHeight)
		};
	}

	const scale = maxDimension / longestSide;
	return {
		width: Math.max(1, Math.round(srcWidth * scale)),
		height: Math.max(1, Math.round(srcHeight * scale))
	};
}

const INDONESIAN_MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'Mei',
	'Jun',
	'Jul',
	'Agu',
	'Sep',
	'Okt',
	'Nov',
	'Des'
];

export function formatIndonesianTimestamp(date: Date): string {
	const offsetMin = -date.getTimezoneOffset();
	let tzLabel = 'WIB';
	if (offsetMin === 480) tzLabel = 'WITA';
	else if (offsetMin === 540) tzLabel = 'WIT';
	else if (offsetMin !== 420) tzLabel = 'WIB';

	const day = String(date.getDate()).padStart(2, '0');
	const month = INDONESIAN_MONTHS[date.getMonth()] ?? 'Jan';
	const year = date.getFullYear();
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');

	return `${day} ${month} ${year}, ${hours}:${minutes} ${tzLabel}`;
}

/**
 * Membentuk tepat 6 baris teks watermark sesuai Tabel Bagian 9.1 PROJECT_SPEC.md.
 */
export function formatWatermarkLines(meta: WatermarkMetadata): string[] {
	const hasCoords =
		meta.gpsAvailable &&
		typeof meta.latitude === 'number' &&
		typeof meta.longitude === 'number' &&
		!Number.isNaN(meta.latitude) &&
		!Number.isNaN(meta.longitude);

	const coordText = hasCoords
		? `${meta.latitude!.toFixed(4)}, ${meta.longitude!.toFixed(4)} (±${Math.round(meta.accuracyM ?? 0)} m)`
		: 'GPS tidak tersedia';

	return [
		`Aksi: ${meta.actionLabel}`,
		`Barang: ${meta.assetName} · ${meta.assetCode}`,
		`Pengguna: ${meta.userName}`,
		`Waktu: ${formatIndonesianTimestamp(meta.takenAt)}`,
		`Koordinat: ${coordText}`,
		`Lokasi: ${meta.locationName?.trim() || 'Lokasi belum dipilih'}`
	];
}

/**
 * Menggambar pita latar gelap dan ke-6 baris watermark langsung ke piksel canvas (Bagian 9.1).
 */
export function drawWatermarkToContext(
	ctx: Canvas2DWatermarkTarget,
	width: number,
	height: number,
	lines: string[]
): void {
	if (lines.length === 0) return;

	const fontSize = Math.max(13, Math.round(Math.min(width, height) * 0.025));
	const lineHeight = Math.round(fontSize * 1.38);
	const paddingX = Math.round(fontSize * 0.9);
	const paddingY = Math.round(fontSize * 0.75);
	const boxHeight = lines.length * lineHeight + paddingY * 2;
	const boxY = Math.max(0, height - boxHeight);

	ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
	ctx.fillRect(0, boxY, width, boxHeight);

	ctx.fillStyle = '#ffffff';
	ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
	ctx.textBaseline = 'top';

	for (let i = 0; i < lines.length; i++) {
		const y = boxY + paddingY + i * lineHeight;
		ctx.fillText(lines[i], paddingX, y);
	}
}

export function findNearestLocation(
	latitude: number,
	longitude: number,
	locations: LocationCandidate[]
): { location: LocationCandidate; distanceM: number; withinRadius: boolean } | null {
	let best: { location: LocationCandidate; distanceM: number; withinRadius: boolean } | null = null;
	const R = 6371000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;

	for (const loc of locations) {
		if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') continue;
		const dLat = toRad(loc.latitude - latitude);
		const dLon = toRad(loc.longitude - longitude);
		const a =
			Math.sin(dLat / 2) * Math.sin(dLat / 2) +
			Math.cos(toRad(latitude)) *
				Math.cos(toRad(loc.latitude)) *
				Math.sin(dLon / 2) *
				Math.sin(dLon / 2);
		const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
		const distanceM = R * c;
		const withinRadius = distanceM <= loc.radiusM;

		if (!best || distanceM < best.distanceM) {
			best = { location: loc, distanceM, withinRadius };
		}
	}

	return best;
}

export interface ApiErrorShape {
	error?: {
		code?: string;
		message?: string;
		details?: Record<string, unknown>;
	};
}

/**
 * Mengubah pesan error dari server menjadi bahasa Indonesia yang ramah dan mudah dipahami pengguna awam di lapangan.
 */
export function formatFriendlyErrorMessage(
	payload: ApiErrorShape | null | undefined,
	fallback = 'Terjadi kendala saat memproses permintaan. Silakan coba lagi.'
): string {
	const err = payload?.error;
	if (!err) return fallback;

	const code = err.code;
	const details = err.details ?? {};

	switch (code) {
		case 'ASSET_NOT_AVAILABLE': {
			const holder = typeof details.currentHolder === 'string' ? details.currentHolder : null;
			if (holder) {
				return `Barang ini sedang dipinjam oleh ${holder} dan belum dikembalikan.`;
			}
			return err.message || 'Barang ini sedang tidak tersedia untuk dipinjam.';
		}
		case 'ALREADY_BORROWED_CONFLICT':
			return 'Maaf, barang ini baru saja dipinjam oleh orang lain beberapa detik yang lalu.';
		case 'MOCK_LOCATION_BLOCKED':
			return 'Lokasi palsu (Fake GPS / Mock Location) terdeteksi di HP Anda. Matikan aplikasi lokasi palsu lalu coba lagi.';
		case 'EVIDENCE_REQUIRED':
			return 'Foto bukti kondisi barang wajib diambil langsung dari kamera sebelum mengirim.';
		case 'DUPLICATE_OPERATION':
			return 'Permintaan atau foto bukti ini sudah pernah dikirim sebelumnya. Silakan ambil foto bukti baru.';
		case 'UNAUTHENTICATED':
			return err.message || 'Sesi login Anda sudah berakhir. Silakan masuk kembali.';
		case 'FORBIDDEN':
			return err.message || 'Anda tidak memiliki izin untuk melakukan tindakan ini.';
		case 'NOT_FOUND':
			return err.message || 'Data barang tidak ditemukan. Pastikan kode QR atau kode barang benar.';
		case 'RATE_LIMITED':
			return 'Terlalu banyak percobaan gagal. Silakan tunggu beberapa menit sebelum mencoba lagi.';
		case 'VALIDATION_ERROR': {
			const issues = Array.isArray(details.issues)
				? (details.issues as Array<{ message?: string }>)
				: [];
			if (issues.length > 0 && issues[0]?.message) {
				return issues[0].message;
			}
			return err.message || 'Isian formulir belum lengkap atau belum sesuai.';
		}
		default:
			return err.message || fallback;
	}
}
