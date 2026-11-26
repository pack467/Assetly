import type { RiskLevel } from '@prisma/client';
import type { DbTx } from '$lib/server/audit';

export type RiskReasonCode =
	| 'MOCK_LOCATION'
	| 'CLOCK_SKEW'
	| 'CLOCK_SKEW_LARGE'
	| 'OFFLINE_CAPTURE'
	| 'NO_GPS'
	| 'ZERO_ACCURACY'
	| 'FAR_FROM_LOCATION'
	| 'FAR_FROM_LOCATION_LARGE'
	| 'IMPOSSIBLE_JUMP'
	| 'REPEATED_COORDS';

export interface RiskConfig {
	blockOnMock: boolean;
	clockSkewWarnSec: number;
	clockSkewSuspiciousSec: number;
	futureToleranceSec: number;
	maxOfflineQueueSec: number;
	offlineCaptureNoteMinSec: number;
	maxAccuracyM: number;
	farLocationMultiplier: number;
	maxSpeedKmh: number;
	repeatedCoordsThreshold: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
	blockOnMock: (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false',
	clockSkewWarnSec: 300,
	clockSkewSuspiciousSec: 3600,
	futureToleranceSec: 60,
	maxOfflineQueueSec: Number(process.env.RISK_MAX_OFFLINE_SEC) || 24 * 60 * 60, // batas wajar antrean offline (default 24 jam)
	offlineCaptureNoteMinSec: 60, // tambahkan catatan informatif OFFLINE_CAPTURE bila mengantre >= 60 detik
	maxAccuracyM: 5000,
	farLocationMultiplier: 5,
	maxSpeedKmh: 150,
	repeatedCoordsThreshold: 3
};

export interface EvidenceRiskInput {
	takenAtDevice: Date;
	uploadedAtDevice?: Date | null;
	receivedAtServer?: Date;
	gpsAvailable: boolean;
	latitude?: number | null;
	longitude?: number | null;
	accuracyM?: number | null;
	isMockLocation?: boolean;
	location?: {
		id: string;
		latitude: number | null;
		longitude: number | null;
		radiusM: number;
	} | null;
}

export interface PreviousEvidencePoint {
	latitude: number;
	longitude: number;
	locationId: string | null;
	receivedAtServer: Date;
	takenAtDevice: Date;
	offlineDelaySec?: number | null;
}

export interface EvidenceRiskContext {
	recentUserEvidences?: PreviousEvidencePoint[];
	/**
	 * Waktu takenAtDevice dari bukti terakhir pengguna yang sama (termasuk bukti non-GPS)
	 * untuk menegakkan urutan waktu monotonik (takenAtDevice baru tidak boleh lebih tua dari bukti terakhir).
	 */
	latestPreviousTakenAt?: Date | null;
}

export interface EvidenceRiskEvaluation {
	riskLevel: RiskLevel;
	riskReasons: RiskReasonCode[];
	shouldBlock: boolean;
	/** Selisih jam efektif setelah memperhitungkan jeda antrean offline yang sah */
	clockSkewSec: number;
	/** Selisih mentah |receivedAtServer - takenAtDevice| dalam detik */
	rawClockSkewSec: number;
	/** Lama antrean offline yang terverifikasi dan diterima oleh server (detik) */
	offlineDelaySec: number;
	/** Waktu pengambilan efektif yang sudah dibatasi oleh server (dipakai untuk IMPOSSIBLE_JUMP) */
	effectiveCapturedAt: Date;
	distanceToLocationM: number | null;
}

const LEVEL_WEIGHT: Record<RiskLevel, number> = {
	NORMAL: 0,
	NEEDS_REVIEW: 1,
	SUSPICIOUS: 2
};

function elevateLevel(current: RiskLevel, candidate: RiskLevel): RiskLevel {
	return LEVEL_WEIGHT[candidate] > LEVEL_WEIGHT[current] ? candidate : current;
}

/**
 * Menghitung jarak permukaan bumi (meter) menggunakan rumus Haversine.
 */
export function calculateHaversineDistanceM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number
): number {
	const R = 6371000; // meter
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

function formatCoord6(lat: number, lng: number): string {
	return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * Fungsi murni penilaian risiko bukti (Bagian 9.2 PROJECT_SPEC.md).
 */
export function evaluateEvidenceRisk(
	input: EvidenceRiskInput,
	context: EvidenceRiskContext = {},
	config: Partial<RiskConfig> = {}
): EvidenceRiskEvaluation {
	const cfg: RiskConfig = {
		...DEFAULT_RISK_CONFIG,
		blockOnMock:
			config.blockOnMock ?? (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false',
		...config
	};

	const receivedAt = input.receivedAtServer ?? new Date();
	const rawClockSkewSec = Math.round(
		Math.abs(receivedAt.getTime() - input.takenAtDevice.getTime()) / 1000
	);

	// Bila uploadedAtDevice disertakan klien, gunakan untuk mengukur selisih jam HP saat unggah (a)
	// dan klaim durasi offline uploadedAtDevice - takenAtDevice (b).
	const uploadedAt = input.uploadedAtDevice ?? input.takenAtDevice;
	const uploadClockSkewSec = Math.round(
		Math.abs(receivedAt.getTime() - uploadedAt.getTime()) / 1000
	);
	const rawClaimedOfflineSec = Math.round(
		(uploadedAt.getTime() - input.takenAtDevice.getTime()) / 1000
	);

	const recent = context.recentUserEvidences ?? [];
	const latestPrev = recent[0] ?? null;
	const latestPrevEffectiveAt = latestPrev
		? new Date(latestPrev.receivedAtServer.getTime() - (latestPrev.offlineDelaySec ?? 0) * 1000)
		: null;
	const latestPrevTakenAt = context.latestPreviousTakenAt ?? latestPrev?.takenAtDevice ?? null;

	// Syarat keabsahan klaim antrean offline (tanpa ketergantungan pada Session.lastSeenAt):
	// 1) Jam HP saat unggah (uploadedAtDevice) konsisten dengan jam server (selisih <= clockSkewWarnSec)
	const isUploadClockConsistent = uploadClockSkewSec <= cfg.clockSkewWarnSec;

	// 2) takenAtDevice tidak boleh di masa depan terhadap receivedAtServer maupun uploadedAtDevice (toleransi 60 detik)
	const isTakenInFutureOfServer =
		(input.takenAtDevice.getTime() - receivedAt.getTime()) / 1000 > cfg.futureToleranceSec;
	const isTakenInFutureOfUpload = rawClaimedOfflineSec < -cfg.futureToleranceSec;

	// 3) takenAtDevice tidak boleh lebih tua dari bukti terakhir milik pengguna yang sama
	const isOlderThanPreviousEvidence = Boolean(
		latestPrevTakenAt && input.takenAtDevice.getTime() < latestPrevTakenAt.getTime()
	);

	// 4) Lama antrean offline (uploadedAtDevice - takenAtDevice) berada di bawah batas wajar yang dikonfigurasi (default 24 jam)
	const positiveClaimedOfflineSec = Math.max(0, rawClaimedOfflineSec);
	const isWithinMaxOfflineLimit = positiveClaimedOfflineSec <= cfg.maxOfflineQueueSec;

	let offlineDelaySec = 0;
	let clockSkewSec = rawClockSkewSec;
	let isValidOfflineCapture = false;

	if (
		isUploadClockConsistent &&
		!isTakenInFutureOfServer &&
		!isTakenInFutureOfUpload &&
		!isOlderThanPreviousEvidence &&
		isWithinMaxOfflineLimit
	) {
		offlineDelaySec = positiveClaimedOfflineSec;
		clockSkewSec = uploadClockSkewSec;
		isValidOfflineCapture = offlineDelaySec >= cfg.offlineCaptureNoteMinSec;
	} else {
		// Bila jam HP saat unggah tidak konsisten dengan server, atau takenAtDevice di masa depan / lebih tua dari batas -> tandai CLOCK_SKEW
		offlineDelaySec = 0;
		clockSkewSec = Math.max(uploadClockSkewSec, rawClockSkewSec);
	}

	const effectiveCapturedAt = new Date(receivedAt.getTime() - offlineDelaySec * 1000);

	let riskLevel: RiskLevel = 'NORMAL';
	const reasons: RiskReasonCode[] = [];
	let shouldBlock = false;

	// 1. MOCK_LOCATION
	if (input.isMockLocation) {
		reasons.push('MOCK_LOCATION');
		riskLevel = elevateLevel(riskLevel, 'SUSPICIOUS');
		if (cfg.blockOnMock) {
			shouldBlock = true;
		}
	}

	// 2. CLOCK_SKEW & CLOCK_SKEW_LARGE vs catatan informatif OFFLINE_CAPTURE
	if (clockSkewSec > cfg.clockSkewSuspiciousSec) {
		reasons.push('CLOCK_SKEW_LARGE');
		riskLevel = elevateLevel(riskLevel, 'SUSPICIOUS');
	} else if (clockSkewSec > cfg.clockSkewWarnSec) {
		reasons.push('CLOCK_SKEW');
		riskLevel = elevateLevel(riskLevel, 'NEEDS_REVIEW');
	} else if (isValidOfflineCapture) {
		// Catatan informatif (tidak menaikkan riskLevel; foto tetap NORMAL)
		reasons.push('OFFLINE_CAPTURE');
	}

	const hasValidCoords =
		input.gpsAvailable &&
		typeof input.latitude === 'number' &&
		typeof input.longitude === 'number' &&
		!Number.isNaN(input.latitude) &&
		!Number.isNaN(input.longitude);

	let distanceToLocationM: number | null = null;

	// 3. NO_GPS: hanya mencatat alasan, tidak menaikkan level sendiri (Bagian 9.2)
	if (!hasValidCoords) {
		reasons.push('NO_GPS');
	} else {
		const lat = input.latitude!;
		const lng = input.longitude!;

		// 4. ZERO_ACCURACY: accuracyM = 0 atau tidak wajar
		if (
			input.accuracyM !== undefined &&
			input.accuracyM !== null &&
			(input.accuracyM <= 0 || input.accuracyM > cfg.maxAccuracyM)
		) {
			reasons.push('ZERO_ACCURACY');
			riskLevel = elevateLevel(riskLevel, 'NEEDS_REVIEW');
		}

		// 5. FAR_FROM_LOCATION & FAR_FROM_LOCATION_LARGE
		if (
			input.location &&
			typeof input.location.latitude === 'number' &&
			typeof input.location.longitude === 'number'
		) {
			distanceToLocationM = calculateHaversineDistanceM(
				lat,
				lng,
				input.location.latitude,
				input.location.longitude
			);
			const radiusM = Math.max(1, input.location.radiusM);
			const effectiveAcc = Math.max(0, input.accuracyM ?? 0);

			if (distanceToLocationM > cfg.farLocationMultiplier * radiusM) {
				reasons.push('FAR_FROM_LOCATION_LARGE');
				riskLevel = elevateLevel(riskLevel, 'SUSPICIOUS');
			} else if (distanceToLocationM > radiusM + effectiveAcc) {
				reasons.push('FAR_FROM_LOCATION');
				riskLevel = elevateLevel(riskLevel, 'NEEDS_REVIEW');
			}
		}

		// 6. IMPOSSIBLE_JUMP & 7. REPEATED_COORDS terhadap bukti sebelumnya milik user yang sama
		if (recent.length > 0 && latestPrev && latestPrevEffectiveAt) {
			const jumpDistanceM = calculateHaversineDistanceM(
				lat,
				lng,
				latestPrev.latitude,
				latestPrev.longitude
			);
			// Gunakan waktu pengambilan efektif yang sudah dibatasi (bukan receivedAtServer mentah)
			const deltaSec = Math.max(
				1,
				Math.abs(effectiveCapturedAt.getTime() - latestPrevEffectiveAt.getTime()) / 1000
			);
			const speedKmh = (jumpDistanceM / deltaSec) * 3.6;

			// Abaikan jitter kecil (< 500 m) agar selisih detik singkat tidak dianggap lompatan
			if (jumpDistanceM > 500 && speedKmh > cfg.maxSpeedKmh) {
				reasons.push('IMPOSSIBLE_JUMP');
				riskLevel = elevateLevel(riskLevel, 'SUSPICIOUS');
			}

			// REPEATED_COORDS: koordinat identik sampai 6 desimal >= 3 kali berturut-turut di lokasi berbeda
			const currentCoordKey = formatCoord6(lat, lng);
			const currentLocationId = input.location?.id ?? null;
			const locationSet = new Set<string>();
			if (currentLocationId) locationSet.add(currentLocationId);

			let consecutiveIdentical = 1;
			for (const prev of recent) {
				if (formatCoord6(prev.latitude, prev.longitude) === currentCoordKey) {
					consecutiveIdentical += 1;
					if (prev.locationId) locationSet.add(prev.locationId);
				} else {
					break;
				}
			}

			if (consecutiveIdentical >= cfg.repeatedCoordsThreshold && locationSet.size >= 2) {
				reasons.push('REPEATED_COORDS');
				riskLevel = elevateLevel(riskLevel, 'NEEDS_REVIEW');
			}
		}
	}

	return {
		riskLevel,
		riskReasons: reasons,
		shouldBlock,
		clockSkewSec,
		rawClockSkewSec,
		offlineDelaySec,
		effectiveCapturedAt,
		distanceToLocationM
	};
}

export async function loadRecentUserEvidencesForRisk(
	tx: DbTx,
	userId: string
): Promise<PreviousEvidencePoint[]> {
	const rows = await tx.evidence.findMany({
		where: {
			userId,
			gpsAvailable: true,
			latitude: { not: null },
			longitude: { not: null }
		},
		orderBy: { receivedAtServer: 'desc' },
		take: 5,
		select: {
			latitude: true,
			longitude: true,
			locationId: true,
			receivedAtServer: true,
			takenAtDevice: true,
			offlineDelaySec: true
		}
	});

	return rows
		.filter(
			(r): r is typeof r & { latitude: number; longitude: number } =>
				typeof r.latitude === 'number' && typeof r.longitude === 'number'
		)
		.map((r) => ({
			latitude: r.latitude,
			longitude: r.longitude,
			locationId: r.locationId,
			receivedAtServer: r.receivedAtServer,
			takenAtDevice: r.takenAtDevice,
			offlineDelaySec: r.offlineDelaySec ?? 0
		}));
}

/**
 * Memuat konteks risiko pengguna dari database:
 * - recentUserEvidences: 5 bukti ber-GPS terakhir untuk IMPOSSIBLE_JUMP & REPEATED_COORDS
 * - latestPreviousTakenAt: takenAtDevice dari bukti terakhir pengguna (termasuk non-GPS) untuk cek urutan waktu monotonik
 * (Tidak lagi bergantung pada Session.lastSeenAt untuk penilaian risiko agar refresh token saat rekoneksi tidak memicu false positive).
 */
export async function loadUserEvidenceRiskContext(
	tx: DbTx,
	userId: string
): Promise<EvidenceRiskContext> {
	const [recentUserEvidences, latestAnyEvidence] = await Promise.all([
		loadRecentUserEvidencesForRisk(tx, userId),
		tx.evidence.findFirst({
			where: { userId },
			orderBy: { receivedAtServer: 'desc' },
			select: {
				takenAtDevice: true
			}
		})
	]);

	return {
		recentUserEvidences,
		latestPreviousTakenAt: latestAnyEvidence?.takenAtDevice ?? null
	};
}
