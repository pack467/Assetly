import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { uploadEvidence } from '$lib/server/services/evidenceService';
import { uploadEvidenceMetaSchema } from '$lib/shared/schemas/loan';
import { AppError, toErrorResponse } from '$lib/shared/errors';

export const POST: RequestHandler = async (event) => {
	try {
		const contentType = (event.request.headers.get('content-type') || '').toLowerCase();
		const ip = event.getClientAddress?.() ?? undefined;

		if (contentType.includes('multipart/form-data')) {
			const formData = await event.request.formData();
			const filePart = formData.get('file') ?? formData.get('photo') ?? formData.get('image');
			if (!(filePart instanceof File)) {
				throw new AppError('VALIDATION_ERROR', 'Berkas foto (field "file") wajib diunggah.');
			}

			const arrayBuf = await filePart.arrayBuffer();
			const fileBuffer = Buffer.from(arrayBuf);

			const rawGps = formData.get('gpsAvailable');
			const rawMock = formData.get('isMockLocation');
			const rawLat = formData.get('latitude');
			const rawLng = formData.get('longitude');
			const rawAcc = formData.get('accuracyM');

			const meta = uploadEvidenceMetaSchema.parse({
				purpose: formData.get('purpose'),
				captureSource: (formData.get('captureSource') as string) || 'CAMERA',
				takenAtDevice: formData.get('takenAtDevice'),
				uploadedAtDevice: (formData.get('uploadedAtDevice') as string) || null,
				gpsAvailable: rawGps === 'true' || rawGps === '1',
				latitude: rawLat !== null && rawLat !== '' ? Number(rawLat) : null,
				longitude: rawLng !== null && rawLng !== '' ? Number(rawLng) : null,
				accuracyM: rawAcc !== null && rawAcc !== '' ? Number(rawAcc) : null,
				isMockLocation: rawMock === 'true' || rawMock === '1',
				locationId: (formData.get('locationId') as string) || null,
				locationNote: (formData.get('locationNote') as string) || null,
				mimeType: filePart.type || 'image/jpeg'
			});

			const result = await uploadEvidence(event.locals.user, { meta, fileBuffer }, ip);
			return json(result, { status: 201 });
		}

		const body = await event.request.json();
		const meta = uploadEvidenceMetaSchema.parse(body);
		if (!meta.imageBase64) {
			throw new AppError(
				'VALIDATION_ERROR',
				'Data foto (imageBase64 atau multipart file) wajib disertakan.'
			);
		}

		const cleanedBase64 = meta.imageBase64.replace(/^data:image\/\w+;base64,/, '');
		const fileBuffer = Buffer.from(cleanedBase64, 'base64');

		const result = await uploadEvidence(event.locals.user, { meta, fileBuffer }, ip);
		return json(result, { status: 201 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
