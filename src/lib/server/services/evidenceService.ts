import type { EvidencePurpose } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, type PolicyUser } from '$lib/server/policy';
import { evaluateEvidenceRisk, loadUserEvidenceRiskContext } from '$lib/server/risk';
import {
	createEvidenceSignedUrl,
	deletePrivateEvidenceFile,
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
	ip?: string,
	sessionId?: string | null
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

	let uploadedAtDevice: Date | null = null;
	if (meta.uploadedAtDevice) {
		const parsedUpload = new Date(meta.uploadedAtDevice);
		if (Number.isNaN(parsedUpload.getTime())) {
			throw new AppError(
				'VALIDATION_ERROR',
				'Waktu pengunggahan foto di perangkat (uploadedAtDevice) tidak valid.'
			);
		}
		uploadedAtDevice = parsedUpload;
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
	const riskContext = await loadUserEvidenceRiskContext(prisma, currentUser.id);

	const riskEvaluation = evaluateEvidenceRisk(
		{
			takenAtDevice,
			uploadedAtDevice,
			receivedAtServer,
			gpsAvailable: hasCoords,
			latitude: hasCoords ? meta.latitude : null,
			longitude: hasCoords ? meta.longitude : null,
			accuracyM: hasCoords ? (meta.accuracyM ?? null) : null,
			isMockLocation: meta.isMockLocation,
			location: selectedLocation
		},
		riskContext
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
	await savePrivateEvidenceFile(imageKey, fileBuffer);

	let created;
	try {
		created = await prisma.$transaction(async (tx) => {
			const evidence = await tx.evidence.create({
				data: {
					purpose: meta.purpose,
					imageKey,
					userId: currentUser.id,
					takenAtDevice,
					uploadedAtDevice,
					receivedAtServer,
					clockSkewSec: riskEvaluation.clockSkewSec,
					rawClockSkewSec: riskEvaluation.rawClockSkewSec,
					offlineDelaySec: riskEvaluation.offlineDelaySec,
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
					rawClockSkewSec: evidence.rawClockSkewSec,
					offlineDelaySec: evidence.offlineDelaySec,
					riskLevel: evidence.riskLevel,
					riskReasons: riskEvaluation.riskReasons
				},
				ip: ip ?? null
			});

			// Perbarui Session.lastSeenAt setelah konteks risiko dibaca dan bukti berhasil disimpan (#6)
			await tx.session.updateMany({
				where: {
					...(sessionId ? { id: sessionId } : { userId: currentUser.id }),
					revokedAt: null
				},
				data: {
					lastSeenAt: receivedAtServer
				}
			});

			return evidence;
		});
	} catch (err) {
		await deletePrivateEvidenceFile(imageKey);
		throw err;
	}

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

/**
 * Memastikan foto bukti (Evidence) belum pernah digunakan pada LoanItem (pinjam/kembali),
 * Handover (serah terima), maupun tutup shift (SHIFT_CLOSED).
 */
export async function assertEvidenceNotUsed(tx: DbTx, evidenceIds: string[]): Promise<void> {
	const [usedInLoanItem, usedInHandover, usedInShiftClose] = await Promise.all([
		tx.loanItem.findFirst({
			where: {
				OR: [{ checkoutEvidenceId: { in: evidenceIds } }, { returnEvidenceId: { in: evidenceIds } }]
			},
			select: { id: true, checkoutEvidenceId: true, returnEvidenceId: true }
		}),
		tx.handover.findFirst({
			where: { evidenceId: { in: evidenceIds } },
			select: { id: true, evidenceId: true }
		}),
		tx.auditLog.findFirst({
			where: {
				action: { in: ['SHIFT_CLOSED', 'SHIFT_FORCE_CLOSED_BY_ADMIN'] },
				OR: evidenceIds.map((id) => ({
					after: {
						path: ['evidenceId'],
						equals: id
					}
				}))
			},
			select: { id: true }
		})
	]);

	if (usedInLoanItem || usedInHandover || usedInShiftClose) {
		const duplicateId =
			usedInLoanItem?.checkoutEvidenceId ??
			usedInLoanItem?.returnEvidenceId ??
			usedInHandover?.evidenceId ??
			evidenceIds[0];
		throw new AppError(
			'DUPLICATE_OPERATION',
			'Foto bukti (Evidence) ini sudah pernah digunakan dan tidak boleh dipakai ulang.',
			{ evidenceId: duplicateId }
		);
	}
}

/**
 * Memvalidasi 3 aturan wajib pada kumpulan Evidence:
 * 1. Purpose cocok dengan aksi (CHECKOUT / RETURN / HANDOVER).
 * 2. Diunggah oleh pengguna yang sedang melakukan aksi (userId === actor.id).
 * 3. Tidak menggunakan lokasi palsu (MOCK_LOCATION, BR-07) saat RISK_BLOCK_ON_MOCK aktif.
 */
export function validateEvidenceOwnershipAndPurpose(params: {
	evidences: Array<{
		id: string;
		purpose: EvidencePurpose;
		userId: string;
		isMockLocation: boolean;
		riskLevel?: string;
	}>;
	actor: PolicyUser;
	expectedPurpose: EvidencePurpose;
	actionLabel: string;
}): void {
	const blockOnMock = (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false';

	for (const ev of params.evidences) {
		if (ev.purpose !== params.expectedPurpose) {
			throw new AppError(
				'VALIDATION_ERROR',
				`Foto bukti untuk ${params.actionLabel} wajib ber-purpose ${params.expectedPurpose} (diterima: ${ev.purpose}).`,
				{
					evidenceId: ev.id,
					expectedPurpose: params.expectedPurpose,
					actualPurpose: ev.purpose
				}
			);
		}

		if (ev.userId !== params.actor.id) {
			throw new AppError(
				'FORBIDDEN',
				`Foto bukti ${params.actionLabel} harus diunggah oleh pengguna yang sedang melakukan aksi.`,
				{ evidenceId: ev.id }
			);
		}

		if (ev.isMockLocation && blockOnMock) {
			throw new AppError(
				'MOCK_LOCATION_BLOCKED',
				`Bukti ${params.actionLabel} menggunakan lokasi palsu (mock location) dan diblokir sesuai kebijakan keamanan (BR-07).`,
				{
					evidenceId: ev.id,
					...(ev.riskLevel ? { riskLevel: ev.riskLevel } : {})
				}
			);
		}
	}
}

/**
 * Memuat Evidence dari database, memvalidasi purpose + kepemilikan + aturan MOCK_LOCATION,
 * serta memastikan Evidence belum pernah dipakai (sekali pakai).
 */
export async function validateAndAssertEvidenceUnused(
	tx: DbTx,
	params: {
		actor: PolicyUser;
		evidenceIds: string[];
		expectedPurpose: EvidencePurpose;
		actionLabel: string;
	}
): Promise<void> {
	const evidences = await tx.evidence.findMany({
		where: { id: { in: params.evidenceIds } }
	});

	if (evidences.length !== params.evidenceIds.length) {
		throw new AppError(
			'EVIDENCE_REQUIRED',
			`Data foto bukti ${params.actionLabel} tidak ditemukan.`
		);
	}

	validateEvidenceOwnershipAndPurpose({
		evidences,
		actor: params.actor,
		expectedPurpose: params.expectedPurpose,
		actionLabel: params.actionLabel
	});

	await assertEvidenceNotUsed(tx, params.evidenceIds);
}
