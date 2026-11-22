import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importAssetsFromCsv } from '$lib/server/services/assetService';
import { assertCan } from '$lib/server/policy';
import { csvImportSchema } from '$lib/shared/schemas/master';
import { toErrorResponse } from '$lib/shared/errors';

const CSV_TEMPLATE = [
	'name,category,serialNumber,homeLocation,purchasedAt,notes',
	'Laptop Dell Latitude 5420,Laptop,DL5420-001,Ruang Seminar A,2026-01-15,Kondisi baik lengkap dengan charger',
	'Proyektor Epson EB-X500,Proyektor,EPS-X500-02,Ruang Seminar A,2026-02-10,Termasuk kabel HDMI'
].join('\n');

export const GET: RequestHandler = async (event) => {
	try {
		assertCan(event.locals.user, 'master:manage');
		return new Response(CSV_TEMPLATE, {
			status: 200,
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="templat-impor-barang-itam.csv"'
			}
		});
	} catch (err) {
		return toErrorResponse(err);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const body = await event.request.json();
		const parsed = csvImportSchema.parse(body);
		const ip = event.getClientAddress?.() ?? undefined;
		const result = await importAssetsFromCsv(event.locals.user, parsed, ip);
		return json(result, { status: parsed.mode === 'commit' ? 201 : 200 });
	} catch (err) {
		return toErrorResponse(err);
	}
};
