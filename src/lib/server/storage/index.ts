import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { AppError } from '$lib/shared/errors';

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB (Bagian 9.1)
export const SIGNED_URL_TTL_SEC = 5 * 60; // 5 menit (Bagian 12)
const MIN_SIGNING_SECRET_LENGTH = 32;

const STORAGE_ROOT = resolve(process.cwd(), '.storage', 'evidence');

export function getEvidenceSigningSecret(): Uint8Array {
	const rawSecret = (
		process.env.EVIDENCE_SIGNING_SECRET ??
		env.EVIDENCE_SIGNING_SECRET ??
		''
	).trim();
	if (!rawSecret) {
		throw new Error(
			'EVIDENCE_SIGNING_SECRET wajib diatur pada variabel lingkungan (.env) dan tidak boleh kosong.'
		);
	}
	if (rawSecret.length < MIN_SIGNING_SECRET_LENGTH) {
		throw new Error(
			`EVIDENCE_SIGNING_SECRET terlalu pendek (${rawSecret.length} karakter). Gunakan minimal ${MIN_SIGNING_SECRET_LENGTH} karakter.`
		);
	}
	return new TextEncoder().encode(rawSecret);
}

/**
 * Validasi bahwa buffer benar-benar berkas JPEG (magic bytes FF D8 FF) dan <= 5 MB (Bagian 9.1 & 12).
 */
export function validateJpegBuffer(buffer: Buffer, mimeType?: string | null): void {
	if (!buffer || buffer.byteLength === 0) {
		throw new AppError('VALIDATION_ERROR', 'Berkas foto bukti tidak boleh kosong.');
	}

	if (buffer.byteLength > MAX_EVIDENCE_BYTES) {
		throw new AppError(
			'VALIDATION_ERROR',
			`Ukuran foto bukti melebihi batas maksimum 5 MB (${buffer.byteLength} byte).`
		);
	}

	if (mimeType && !['image/jpeg', 'image/jpg'].includes(mimeType.toLowerCase())) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Format berkas foto tidak didukung. Hanya JPEG yang diizinkan.'
		);
	}

	// Cek magic bytes JPEG: 0xFF 0xD8 0xFF
	if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Berkas bukan gambar JPEG yang sah (magic bytes tidak cocok).'
		);
	}
}

export function generateEvidenceImageKey(purpose: string): string {
	const datePrefix = new Date().toISOString().slice(0, 10);
	return `${purpose.toLowerCase()}/${datePrefix}/${randomUUID()}.jpg`;
}

function resolveSafeEvidencePath(imageKey: string): string {
	const safeRelPath = imageKey.replace(/\.\./g, '').replace(/^\/+/, '');
	const fullPath = resolve(STORAGE_ROOT, safeRelPath);
	if (!fullPath.startsWith(STORAGE_ROOT)) {
		throw new AppError('VALIDATION_ERROR', 'Kunci objek foto tidak sah.');
	}
	return fullPath;
}

export async function savePrivateEvidenceFile(imageKey: string, buffer: Buffer): Promise<void> {
	const fullPath = resolveSafeEvidencePath(imageKey);
	await mkdir(dirname(fullPath), { recursive: true });
	await writeFile(fullPath, buffer);
}

export async function readPrivateEvidenceFile(imageKey: string): Promise<Buffer> {
	const fullPath = resolveSafeEvidencePath(imageKey);
	try {
		return await readFile(fullPath);
	} catch {
		throw new AppError('NOT_FOUND', 'Berkas foto bukti tidak ditemukan di storage privat.');
	}
}

export async function deletePrivateEvidenceFile(imageKey: string): Promise<void> {
	const fullPath = resolveSafeEvidencePath(imageKey);
	try {
		await unlink(fullPath);
	} catch {
		// Abaikan bila berkas sudah tidak ada
	}
}

function computeSignature(evidenceId: string, imageKey: string, expiresEpochSec: number): string {
	const secret = getEvidenceSigningSecret();
	return createHmac('sha256', secret)
		.update(`${evidenceId}:${imageKey}:${expiresEpochSec}`)
		.digest('hex');
}

export function createEvidenceSignedUrl(
	evidenceId: string,
	imageKey: string,
	ttlSec = SIGNED_URL_TTL_SEC
): { url: string; expiresAt: string } {
	const expiresEpochSec = Math.floor(Date.now() / 1000) + ttlSec;
	const sig = computeSignature(evidenceId, imageKey, expiresEpochSec);
	return {
		url: `/api/v1/evidence/${evidenceId}/file?expires=${expiresEpochSec}&sig=${sig}`,
		expiresAt: new Date(expiresEpochSec * 1000).toISOString()
	};
}

export function verifyEvidenceSignedUrl(params: {
	evidenceId: string;
	imageKey: string;
	expiresParam: string | null;
	sigParam: string | null;
	nowEpochSec?: number;
}): boolean {
	if (!params.expiresParam || !params.sigParam) return false;
	const expiresEpochSec = parseInt(params.expiresParam, 10);
	if (Number.isNaN(expiresEpochSec)) return false;

	const nowSec = params.nowEpochSec ?? Math.floor(Date.now() / 1000);
	if (nowSec > expiresEpochSec) {
		return false;
	}

	const expectedSig = computeSignature(params.evidenceId, params.imageKey, expiresEpochSec);
	const expectedBuf = Buffer.from(expectedSig, 'utf8');
	const actualBuf = Buffer.from(params.sigParam, 'utf8');
	if (expectedBuf.length !== actualBuf.length) return false;

	return timingSafeEqual(expectedBuf, actualBuf);
}
