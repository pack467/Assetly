import { prisma } from '$lib/server/db';
import { writeAuditLog } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { evaluateEvidenceRisk, loadRecentUserEvidencesForRisk } from '$lib/server/risk';
import {
	createEvidenceSignedUrl,
	generateEvidenceImageKey,
	savePrivateEvidenceFile,
	validateJpegBuffer
} from '$lib/server/storage';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type { uploadEvidenceMetaSchema } from '$lib/shared/schemas/loan';

export async function uploadEvidence(
	actor: PolicyUser | null | undefined,
	params: {
		meta: z.infer<typeof uploadEvidenceMetaSchema>;
		fileBuffer: Buffer;
	},
	ip?: string
) {
	assertCan(actor, 'asset:read');
	const currentUser = actor;
	const { meta, fileBuffer } = params;

	// BR-04: Foto bukti hanya boleh diambil lewat kamera aplikasi. Unggah dari galeri ditolak.
	if (meta.captureSource.toUpperCase() !== 'CAMERA') {
		throw new AppError(
			'VALIDATION_ERROR',
			'Foto bukti hanya boleh diambil langsung dari kamera aplikasi. Unggah dari galeri ditolak (BR-04).',
			{ captureSource: meta.captureSource }
		);
	}

	// Bagian 9.1 & 12: Validasi tipe JPEG (magic bytes) dan ukuran <= 5 MB
	validateJpegBuffer(fileBuffer, meta.mimeType);

	const takenAtDevice = new Date(meta.takenAtDevice);
	if (Number.isNaN(takenAtDevice.getTime())) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Waktu pengambilan foto di perangkat (takenAtDevice) tidak valid.'
		);
	}

	const hasCoords =
		meta.gpsAvailable &&
		typeof meta.latitude === 'number' &&
		typeof meta.longitude === 'number' &&
		!Number.isNaN(meta.latitude) &&
		!Number.isNaN(meta.longitude);

	// BR-06: Bila GPS tidak tersedia, pengguna wajib memilih lokasi manual dari daftar Location
	if (!hasCoords && !meta.locationId) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Saat GPS tidak tersedia, lokasi wajib dipilih secara manual dari daftar Lokasi Resmi (BR-06).',
			{ field: 'locationId' }
		);
	}

	let selectedLocation: {
		id: string;
		name: string;
		latitude: number | null;
		longitude: number | null;
		radiusM: number;
	} | null = null;

	if (meta.locationId) {
		const loc = await prisma.location.findUnique({ where: { id: meta.locationId } });
		if (!loc || !loc.isActive) {
			throw new AppError('VALIDATION_ERROR', 'Lokasi resmi tidak ditemukan atau tidak aktif.', {
				field: 'locationId'
			});
		}
		selectedLocation = loc;
	}

	const receivedAtServer = new Date();
	const recentUserEvidences = await loadRecentUserEvidencesForRisk(prisma, currentUser.id);

	const riskEvaluation = evaluateEvidenceRisk(
		{
			takenAtDevice,
			receivedAtServer,
			gpsAvailable: hasCoords,
			latitude: hasCoords ? meta.latitude : null,
			longitude: hasCoords ? meta.longitude : null,
			accuracyM: hasCoords ? (meta.accuracyM ?? null) : null,
			isMockLocation: meta.isMockLocation,
			location: selectedLocation
		},
		{ recentUserEvidences }
	);

	// BR-07: Bila isMockLocation = true dan RISK_BLOCK_ON_MOCK aktif, blokir dan catat di AuditLog
	if (riskEvaluation.shouldBlock) {
		await writeAuditLog(prisma, {
			actorId: currentUser.id,
			action: 'EVIDENCE_MOCK_LOCATION_BLOCKED',
			entityType: 'Evidence',
			entityId: 'blocked',
			after: {
				purpose: meta.purpose,
				isMockLocation: true,
				riskLevel: riskEvaluation.riskLevel,
				riskReasons: riskEvaluation.riskReasons,
				latitude: meta.latitude ?? null,
				longitude: meta.longitude ?? null
			},
			ip: ip ?? null
		});

		throw new AppError(
			'MOCK_LOCATION_BLOCKED',
			'Lokasi palsu (mock location) terdeteksi. Transaksi diblokir sesuai kebijakan keamanan (BR-07).',
			{
				riskLevel: riskEvaluation.riskLevel,
				riskReasons: riskEvaluation.riskReasons
			}
		);
	}

	const imageKey = generateEvidenceImageKey(meta.purpose);
	savePrivateEvidenceFile(imageKey, fileBuffer);

	const created = await prisma.$transaction(async (tx) => {
		const evidence = await tx.evidence.create({
			data: {
				purpose: meta.purpose,
				imageKey,
				userId: currentUser.id,
				takenAtDevice,
				receivedAtServer,
				clockSkewSec: riskEvaluation.clockSkewSec,
				gpsAvailable: hasCoords,
				latitude: hasCoords ? meta.latitude : null,
				longitude: hasCoords ? meta.longitude : null,
				accuracyM: hasCoords ? (meta.accuracyM ?? null) : null,
				isMockLocation: meta.isMockLocation,
				locationId: selectedLocation?.id ?? null,
				locationNote: meta.locationNote ?? null,
				distanceToLocationM: riskEvaluation.distanceToLocationM,
				riskLevel: riskEvaluation.riskLevel,
				riskReasons: riskEvaluation.riskReasons
			}
		});

		await writeAuditLog(tx, {
			actorId: currentUser.id,
			action: 'EVIDENCE_UPLOADED',
			entityType: 'Evidence',
			entityId: evidence.id,
			after: {
				purpose: evidence.purpose,
				gpsAvailable: evidence.gpsAvailable,
				locationId: evidence.locationId,
				clockSkewSec: evidence.clockSkewSec,
				riskLevel: evidence.riskLevel,
				riskReasons: riskEvaluation.riskReasons
			},
			ip: ip ?? null
		});

		return evidence;
	});

	const signedUrl = createEvidenceSignedUrl(created.id, created.imageKey);

	return {
		evidence: created,
		signedUrl: signedUrl.url,
		signedUrlExpiresAt: signedUrl.expiresAt
	};
}

export async function getEvidenceDetail(actor: PolicyUser | null | undefined, evidenceId: string) {
	assertCan(actor, 'asset:read');
	const currentUser = actor;

	const evidence = await prisma.evidence.findUnique({
		where: { id: evidenceId },
		include: {
			user: {
				select: { id: true, name: true, email: true, role: true }
			},
			location: true
		}
	});

	if (!evidence) {
		throw new AppError('NOT_FOUND', 'Data bukti foto tidak ditemukan.');
	}

	if (currentUser.role === 'BORROWER' && evidence.userId !== currentUser.id) {
		throw new AppError('FORBIDDEN', 'Anda tidak memiliki akses ke bukti foto ini.');
	}

	const signedUrl = createEvidenceSignedUrl(evidence.id, evidence.imageKey);

	return {
		evidence,
		signedUrl: signedUrl.url,
		signedUrlExpiresAt: signedUrl.expiresAt
	};
}
