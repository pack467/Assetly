import type { RiskLevel } from '@prisma/client';
import type { DbTx } from '$lib/server/audit';

export type RiskReasonCode =
	| 'MOCK_LOCATION'
	| 'CLOCK_SKEW'
	| 'CLOCK_SKEW_LARGE'
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
	maxAccuracyM: number;
	farLocationMultiplier: number;
	maxSpeedKmh: number;
	repeatedCoordsThreshold: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
	blockOnMock: (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false',
	clockSkewWarnSec: 300,
	clockSkewSuspiciousSec: 3600,
	maxAccuracyM: 5000,
	farLocationMultiplier: 5,
	maxSpeedKmh: 150,
	repeatedCoordsThreshold: 3
};

export interface EvidenceRiskInput {
	takenAtDevice: Date;
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
}

export interface EvidenceRiskContext {
	recentUserEvidences?: PreviousEvidencePoint[];
}

export interface EvidenceRiskEvaluation {
	riskLevel: RiskLevel;
	riskReasons: RiskReasonCode[];
	shouldBlock: boolean;
	clockSkewSec: number;
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
	const clockSkewSec = Math.round(
		Math.abs(receivedAt.getTime() - input.takenAtDevice.getTime()) / 1000
	);

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

	// 2. CLOCK_SKEW & CLOCK_SKEW_LARGE
	if (clockSkewSec > cfg.clockSkewSuspiciousSec) {
		reasons.push('CLOCK_SKEW_LARGE');
		riskLevel = elevateLevel(riskLevel, 'SUSPICIOUS');
	} else if (clockSkewSec > cfg.clockSkewWarnSec) {
		reasons.push('CLOCK_SKEW');
		riskLevel = elevateLevel(riskLevel, 'NEEDS_REVIEW');
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
		const recent = context.recentUserEvidences ?? [];
		if (recent.length > 0) {
			const latestPrev = recent[0];
			const jumpDistanceM = calculateHaversineDistanceM(
				lat,
				lng,
				latestPrev.latitude,
				latestPrev.longitude
			);
			const deltaSec = Math.max(
				1,
				Math.abs(receivedAt.getTime() - latestPrev.receivedAtServer.getTime()) / 1000
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
			takenAtDevice: true
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
			takenAtDevice: r.takenAtDevice
		}));
}
