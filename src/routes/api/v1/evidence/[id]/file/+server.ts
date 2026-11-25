import type { RequestHandler } from './$types';
import { prisma } from '$lib/server/db';
import { readPrivateEvidenceFile, verifyEvidenceSignedUrl } from '$lib/server/storage';
import { AppError, toErrorResponse } from '$lib/shared/errors';

export const GET: RequestHandler = async (event) => {
	try {
		const evidence = await prisma.evidence.findUnique({
			where: { id: event.params.id },
			select: { id: true, imageKey: true }
		});

		if (!evidence) {
			throw new AppError('NOT_FOUND', 'Bukti foto tidak ditemukan.');
		}

		const expiresParam = event.url.searchParams.get('expires');
		const sigParam = event.url.searchParams.get('sig');

		const validSignature = verifyEvidenceSignedUrl({
			evidenceId: evidence.id,
			imageKey: evidence.imageKey,
			expiresParam,
			sigParam
		});

		if (!validSignature) {
			throw new AppError(
				'FORBIDDEN',
				'Akses foto ditolak: signed URL tidak valid atau telah kedaluwarsa (Bagian 12).'
			);
		}

		const buffer = await readPrivateEvidenceFile(evidence.imageKey);

		return new Response(new Uint8Array(buffer), {
			status: 200,
			headers: {
				'content-type': 'image/jpeg',
				'cache-control': 'private, max-age=300',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (err) {
		return toErrorResponse(err);
	}
};
