import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type { AssetStatus, Prisma } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, can, type PolicyUser } from '$lib/server/policy';
import { isValidAssetStatusTransition } from '$lib/shared/enums';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type {
	changeAssetStatusSchema,
	createAssetSchema,
	reprintQrSchema,
	updateAssetSchema
} from '$lib/shared/schemas/master';

// BR-23: Isi QR adalah qrToken acak kriptografis, bukan kode berurutan
export function generateRandomQrToken(): string {
	return randomBytes(18).toString('base64url');
}

export async function generateQrSvg(qrToken: string): Promise<string> {
	return QRCode.toString(qrToken, {
		type: 'svg',
		margin: 1,
		width: 200,
		errorCorrectionLevel: 'M'
	});
}

export async function generateNextAssetCode(tx: DbTx): Promise<string> {
	const latest = await tx.asset.findMany({
		where: { code: { startsWith: 'AST-' } },
		select: { code: true },
		orderBy: { createdAt: 'desc' },
		take: 200
	});

	let maxNumber = 0;
	for (const row of latest) {
		const match = /^AST-(\d+)$/i.exec(row.code);
		if (match) {
			const num = parseInt(match[1], 10);
			if (num > maxNumber) maxNumber = num;
		}
	}

	const totalCount = await tx.asset.count();
	let candidateNum = Math.max(maxNumber + 1, totalCount + 1);

	while (true) {
		const candidate = `AST-${String(candidateNum).padStart(4, '0')}`;
		const exists = await tx.asset.findUnique({ where: { code: candidate } });
		if (!exists) return candidate;
		candidateNum += 1;
	}
}

export function computeAllowedActionsForAsset(
	user: PolicyUser,
	asset: { status: AssetStatus },
	activeBorrowerId: string | null
): string[] {
	const actions: string[] = [];
	if (asset.status === 'AVAILABLE' && can(user, 'loan:create')) {
		actions.push('BORROW');
	}
	if (
		asset.status === 'BORROWED' &&
		activeBorrowerId &&
		can(user, 'loan:return', { borrowerId: activeBorrowerId })
	) {
		actions.push('RETURN');
	}
	if (
		asset.status === 'BORROWED' &&
		activeBorrowerId &&
		can(user, 'handover:confirm', { borrowerId: activeBorrowerId })
	) {
		actions.push('HANDOVER');
	}
	return actions;
}

export async function listAssets(
	actor: PolicyUser | null | undefined,
	params: {
		page?: number;
		pageSize?: number;
		status?: AssetStatus;
		categoryId?: string;
		homeLocationId?: string;
		search?: string;
	} = {}
) {
	assertCan(actor, 'asset:read');

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;

	const q = params.search?.trim();
	const where: Prisma.AssetWhereInput = {
		...(params.status ? { status: params.status } : {}),
		...(params.categoryId ? { categoryId: params.categoryId } : {}),
		...(params.homeLocationId ? { homeLocationId: params.homeLocationId } : {}),
		...(q
			? {
					OR: [
						{ code: { contains: q, mode: 'insensitive' } },
						{ name: { contains: q, mode: 'insensitive' } },
						{ serialNumber: { contains: q, mode: 'insensitive' } }
					]
				}
			: {})
	};

	const [total, assets] = await Promise.all([
		prisma.asset.count({ where }),
		prisma.asset.findMany({
			where,
			orderBy: [{ createdAt: 'desc' }],
			skip,
			take: pageSize,
			include: {
				category: true,
				homeLocation: true,
				accessories: true,
				loanItems: {
					where: { returnedAt: null },
					take: 1,
					include: {
						loan: {
							include: {
								borrower: {
									select: { id: true, name: true, email: true }
								}
							}
						}
					}
				}
			}
		})
	]);

	return {
		items: assets.map((a) => {
			const activeLoanItem = a.loanItems[0] ?? null;
			return {
				id: a.id,
				code: a.code,
				qrToken: a.qrToken,
				name: a.name,
				status: a.status,
				serialNumber: a.serialNumber,
				photoUrl: a.photoUrl,
				purchasedAt: a.purchasedAt,
				notes: a.notes,
				lastMaintenanceAt: a.lastMaintenanceAt,
				nextMaintenanceAt: a.nextMaintenanceAt,
				version: a.version,
				category: a.category,
				homeLocation: a.homeLocation,
				accessories: a.accessories,
				currentHolder: activeLoanItem?.loan.borrower.name ?? null,
				createdAt: a.createdAt,
				updatedAt: a.updatedAt
			};
		}),
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}

export async function getAssetDetail(actor: PolicyUser | null | undefined, id: string) {
	assertCan(actor, 'asset:read');

	const asset = await prisma.asset.findUnique({
		where: { id },
		include: {
			category: true,
			homeLocation: true,
			accessories: true,
			loanItems: {
				orderBy: { loan: { createdAt: 'desc' } },
				take: 10,
				include: {
					loan: {
						include: {
							borrower: {
								select: { id: true, name: true, email: true }
							}
						}
					}
				}
			}
		}
	});

	if (!asset) {
		throw new AppError('NOT_FOUND', 'Barang tidak ditemukan.');
	}

	const activeLoanItem = asset.loanItems.find((li) => li.returnedAt === null) ?? null;
	const qrSvg = await generateQrSvg(asset.qrToken);

	return {
		asset: {
			...asset,
			currentHolder: activeLoanItem?.loan.borrower.name ?? null,
			qrSvg
		},
		allowedActions: computeAllowedActionsForAsset(
			actor,
			asset,
			activeLoanItem?.loan.borrowerId ?? null
		)
	};
}

export async function getAssetScanInfo(
	actor: PolicyUser | null | undefined,
	lookup: { qrToken?: string; code?: string }
) {
	assertCan(actor, 'asset:read');

	const asset = lookup.qrToken
		? await prisma.asset.findUnique({
				where: { qrToken: lookup.qrToken },
				include: {
					category: true,
					homeLocation: true,
					accessories: true,
					loanItems: {
						where: { returnedAt: null },
						take: 1,
						include: {
							accessoryChecks: true,
							loan: {
								include: {
									borrower: { select: { id: true, name: true, email: true } }
								}
							}
						}
					}
				}
			})
		: await prisma.asset.findFirst({
				where: {
					OR: [
						{ code: { equals: lookup.code?.trim() ?? '', mode: 'insensitive' } },
						{ serialNumber: { equals: lookup.code?.trim() ?? '', mode: 'insensitive' } }
					]
				},
				include: {
					category: true,
					homeLocation: true,
					accessories: true,
					loanItems: {
						where: { returnedAt: null },
						take: 1,
						include: {
							accessoryChecks: true,
							loan: {
								include: {
									borrower: { select: { id: true, name: true, email: true } }
								}
							}
						}
					}
				}
			});

	if (!asset) {
		throw new AppError('NOT_FOUND', 'Barang tidak ditemukan.');
	}

	const activeLoanItem = asset.loanItems[0] ?? null;

	// Format respons Bagian 11.3 PROJECT_SPEC.md
	return {
		asset: {
			id: asset.id,
			code: asset.code,
			name: asset.name,
			status: asset.status,
			photoUrl: asset.photoUrl,
			serialNumber: asset.serialNumber,
			notes: asset.notes,
			category: {
				id: asset.category.id,
				name: asset.category.name,
				requiresApproval: asset.category.requiresApproval
			},
			homeLocation: asset.homeLocation
				? {
						id: asset.homeLocation.id,
						name: asset.homeLocation.name
					}
				: null,
			accessories: asset.accessories
		},
		allowedActions: computeAllowedActionsForAsset(
			actor,
			asset,
			activeLoanItem?.loan.borrowerId ?? null
		),
		currentHolder: activeLoanItem?.loan.borrower.name ?? null,
		requiresApproval: asset.category.requiresApproval,
		activeLoanItem: activeLoanItem
			? {
					id: activeLoanItem.id,
					loanId: activeLoanItem.loanId,
					borrowerId: activeLoanItem.loan.borrowerId,
					purpose: activeLoanItem.loan.purpose,
					expectedReturnAt: activeLoanItem.loan.expectedReturnAt,
					accessoryChecks: activeLoanItem.accessoryChecks
				}
			: null
	};
}

export async function createAsset(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createAssetSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
	if (!category) {
		throw new AppError('VALIDATION_ERROR', 'Kategori tidak ditemukan.', { field: 'categoryId' });
	}

	if (input.homeLocationId) {
		const loc = await prisma.location.findUnique({ where: { id: input.homeLocationId } });
		if (!loc) {
			throw new AppError('VALIDATION_ERROR', 'Lokasi tidak ditemukan.', {
				field: 'homeLocationId'
			});
		}
	}

	const purchasedAtDate = input.purchasedAt ? new Date(input.purchasedAt) : null;
	const nextMaintenanceAt = category.maintenanceIntervalDays
		? new Date(Date.now() + category.maintenanceIntervalDays * 86400_000)
		: null;

	const created = await prisma.$transaction(async (tx) => {
		const code = input.code ? input.code.trim().toUpperCase() : await generateNextAssetCode(tx);

		if (input.code) {
			const existingCode = await tx.asset.findUnique({ where: { code } });
			if (existingCode) {
				throw new AppError('VALIDATION_ERROR', `Kode barang ${code} sudah digunakan.`, {
					field: 'code'
				});
			}
		}

		const qrToken = generateRandomQrToken();

		const asset = await tx.asset.create({
			data: {
				code,
				qrToken,
				name: input.name.trim(),
				categoryId: input.categoryId,
				serialNumber: input.serialNumber?.trim() || null,
				status: 'AVAILABLE',
				homeLocationId: input.homeLocationId ?? null,
				photoUrl: input.photoUrl?.trim() || null,
				purchasedAt: purchasedAtDate,
				notes: input.notes?.trim() || null,
				nextMaintenanceAt,
				...(input.accessories && input.accessories.length > 0
					? {
							accessories: {
								create: input.accessories.map((acc) => ({
									name: acc.name.trim(),
									quantity: acc.quantity ?? 1
								}))
							}
						}
					: {})
			},
			include: {
				category: true,
				homeLocation: true,
				accessories: true
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'ASSET_CREATED',
			entityType: 'Asset',
			entityId: asset.id,
			after: {
				id: asset.id,
				code: asset.code,
				name: asset.name,
				categoryId: asset.categoryId,
				serialNumber: asset.serialNumber,
				status: asset.status
			},
			ip: ip ?? null
		});

		return asset;
	});

	return { asset: created };
}

export async function updateAsset(
	actor: PolicyUser | null | undefined,
	id: string,
	input: z.infer<typeof updateAssetSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.asset.findUnique({
		where: { id },
		include: { accessories: true }
	});
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Barang tidak ditemukan.');
	}

	if (input.version !== undefined && input.version !== existing.version) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Data barang telah berubah oleh pengguna lain. Muat ulang halaman dan coba lagi.',
			{ expectedVersion: existing.version, receivedVersion: input.version },
			409
		);
	}

	if (input.categoryId) {
		const cat = await prisma.category.findUnique({ where: { id: input.categoryId } });
		if (!cat) {
			throw new AppError('VALIDATION_ERROR', 'Kategori tidak ditemukan.', { field: 'categoryId' });
		}
	}

	if (input.homeLocationId) {
		const loc = await prisma.location.findUnique({ where: { id: input.homeLocationId } });
		if (!loc) {
			throw new AppError('VALIDATION_ERROR', 'Lokasi tidak ditemukan.', {
				field: 'homeLocationId'
			});
		}
	}

	const updated = await prisma.$transaction(async (tx) => {
		if (input.accessories !== undefined) {
			await tx.accessoryTemplate.deleteMany({ where: { assetId: id } });
		}

		const asset = await tx.asset.update({
			where: { id },
			data: {
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
				...(input.serialNumber !== undefined
					? { serialNumber: input.serialNumber?.trim() || null }
					: {}),
				...(input.homeLocationId !== undefined ? { homeLocationId: input.homeLocationId } : {}),
				...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl?.trim() || null } : {}),
				...(input.purchasedAt !== undefined
					? { purchasedAt: input.purchasedAt ? new Date(input.purchasedAt) : null }
					: {}),
				...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
				version: { increment: 1 },
				...(input.accessories !== undefined && input.accessories.length > 0
					? {
							accessories: {
								create: input.accessories.map((acc) => ({
									name: acc.name.trim(),
									quantity: acc.quantity ?? 1
								}))
							}
						}
					: {})
			},
			include: {
				category: true,
				homeLocation: true,
				accessories: true
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'ASSET_UPDATED',
			entityType: 'Asset',
			entityId: asset.id,
			before: {
				name: existing.name,
				categoryId: existing.categoryId,
				serialNumber: existing.serialNumber,
				homeLocationId: existing.homeLocationId,
				notes: existing.notes,
				version: existing.version
			},
			after: {
				name: asset.name,
				categoryId: asset.categoryId,
				serialNumber: asset.serialNumber,
				homeLocationId: asset.homeLocationId,
				notes: asset.notes,
				version: asset.version
			},
			ip: ip ?? null
		});

		return asset;
	});

	return { asset: updated };
}

export async function changeAssetSpecialStatus(
	actor: PolicyUser | null | undefined,
	id: string,
	input: z.infer<typeof changeAssetStatusSchema>,
	ip?: string
) {
	// BR-11: Hanya ADMIN yang boleh menetapkan status khusus (LOST, RETIRED, AVAILABLE dari LOST/DAMAGED)
	assertCan(actor, 'asset:set_terminal_status');
	const adminActor = actor;

	const existing = await prisma.asset.findUnique({ where: { id } });
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Barang tidak ditemukan.');
	}

	if (!isValidAssetStatusTransition(existing.status, input.status)) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Perubahan status dari ${existing.status} ke ${input.status} tidak diizinkan.`,
			{ from: existing.status, to: input.status }
		);
	}

	const updated = await prisma.$transaction(async (tx) => {
		const asset = await tx.asset.update({
			where: { id },
			data: {
				status: input.status,
				notes: input.note.trim(),
				version: { increment: 1 }
			}
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'ASSET_STATUS_CHANGED',
			entityType: 'Asset',
			entityId: asset.id,
			before: { status: existing.status },
			after: { status: asset.status, note: input.note.trim() },
			ip: ip ?? null
		});

		return asset;
	});

	return { asset: updated };
}

export async function reprintAssetQr(
	actor: PolicyUser | null | undefined,
	id: string,
	input: z.infer<typeof reprintQrSchema>,
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const existing = await prisma.asset.findUnique({
		where: { id },
		include: { category: true, homeLocation: true }
	});
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Barang tidak ditemukan.');
	}

	const newQrToken = input.rotateToken ? generateRandomQrToken() : existing.qrToken;

	const updated = await prisma.$transaction(async (tx) => {
		const asset = input.rotateToken
			? await tx.asset.update({
					where: { id },
					data: { qrToken: newQrToken, version: { increment: 1 } },
					include: { category: true, homeLocation: true }
				})
			: existing;

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'ASSET_QR_REPRINTED',
			entityType: 'Asset',
			entityId: existing.id,
			before: { qrTokenRotated: false },
			after: {
				code: asset.code,
				qrTokenRotated: Boolean(input.rotateToken),
				reason: input.reason ?? 'Cetak label QR'
			},
			ip: ip ?? null
		});

		return asset;
	});

	const qrSvg = await generateQrSvg(updated.qrToken);

	return {
		asset: {
			id: updated.id,
			code: updated.code,
			name: updated.name,
			qrToken: updated.qrToken,
			categoryName: updated.category.name,
			locationName: updated.homeLocation?.name ?? null
		},
		qrSvg
	};
}

function parseCsvLine(line: string, delimiter: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === delimiter && !inQuotes) {
			result.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	result.push(current.trim());
	return result;
}

export interface CsvImportRowPreview {
	rowNumber: number;
	name: string;
	category: string;
	categoryId: string | null;
	serialNumber: string | null;
	homeLocation: string | null;
	homeLocationId: string | null;
	purchasedAt: string | null;
	notes: string | null;
	status: 'VALID' | 'DUPLICATE_SKIPPED' | 'ERROR';
	reason?: string;
}

export async function importAssetsFromCsv(
	actor: PolicyUser | null | undefined,
	params: { csvText: string; mode: 'preview' | 'commit' },
	ip?: string
) {
	assertCan(actor, 'master:manage');
	const adminActor = actor;

	const rawLines = params.csvText
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	if (rawLines.length < 2) {
		throw new AppError(
			'VALIDATION_ERROR',
			'CSV harus memiliki baris header dan minimal 1 baris data.'
		);
	}

	const headerLine = rawLines[0];
	const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
	const headers = parseCsvLine(headerLine, delimiter).map((h) =>
		h.toLowerCase().replace(/[^a-z0-9_]/g, '')
	);

	const colIndex = {
		name: headers.findIndex((h) => ['name', 'nama', 'namabarang'].includes(h)),
		category: headers.findIndex((h) => ['category', 'kategori'].includes(h)),
		serialNumber: headers.findIndex((h) =>
			['serialnumber', 'nomorseri', 'sn', 'serial'].includes(h)
		),
		homeLocation: headers.findIndex((h) =>
			['homelocation', 'location', 'lokasi', 'lokasiawal'].includes(h)
		),
		purchasedAt: headers.findIndex((h) => ['purchasedat', 'tanggalbeli', 'tglbeli'].includes(h)),
		notes: headers.findIndex((h) => ['notes', 'catatan', 'keterangan'].includes(h))
	};

	if (colIndex.name === -1 || colIndex.category === -1) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Header CSV wajib memuat minimal kolom "name" (atau "nama") dan "category" (atau "kategori").'
		);
	}

	const [categories, locations, existingSerialAssets] = await Promise.all([
		prisma.category.findMany(),
		prisma.location.findMany(),
		prisma.asset.findMany({
			where: { serialNumber: { not: null } },
			select: { serialNumber: true, code: true }
		})
	]);

	const categoryMap = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
	const locationMap = new Map(locations.map((l) => [l.name.trim().toLowerCase(), l]));
	const existingSerials = new Set(
		existingSerialAssets
			.map((a) => a.serialNumber?.trim().toLowerCase())
			.filter((s): s is string => Boolean(s))
	);
	const seenSerialsInFile = new Set<string>();

	const previewRows: CsvImportRowPreview[] = [];
	const errors: { rowNumber: number; reason: string; raw: string }[] = [];

	for (let i = 1; i < rawLines.length; i++) {
		const rowNumber = i + 1;
		const raw = rawLines[i];
		const cols = parseCsvLine(raw, delimiter);

		const name = (cols[colIndex.name] ?? '').trim();
		const categoryName = (cols[colIndex.category] ?? '').trim();
		const serialNumber =
			colIndex.serialNumber >= 0 ? (cols[colIndex.serialNumber] ?? '').trim() || null : null;
		const homeLocationName =
			colIndex.homeLocation >= 0 ? (cols[colIndex.homeLocation] ?? '').trim() || null : null;
		const purchasedAtRaw =
			colIndex.purchasedAt >= 0 ? (cols[colIndex.purchasedAt] ?? '').trim() || null : null;
		const notes = colIndex.notes >= 0 ? (cols[colIndex.notes] ?? '').trim() || null : null;

		const rowReasons: string[] = [];
		if (name.length < 2) {
			rowReasons.push('Nama barang wajib diisi (minimal 2 karakter).');
		}

		const matchedCategory = categoryName
			? (categoryMap.get(categoryName.toLowerCase()) ?? null)
			: null;
		if (!matchedCategory) {
			rowReasons.push(
				`Kategori "${categoryName || '(kosong)'}" tidak ditemukan di master kategori.`
			);
		}

		let matchedLocationId: string | null = null;
		if (homeLocationName) {
			const matchedLocation = locationMap.get(homeLocationName.toLowerCase()) ?? null;
			if (!matchedLocation) {
				rowReasons.push(`Lokasi "${homeLocationName}" tidak ditemukan di master lokasi.`);
			} else {
				matchedLocationId = matchedLocation.id;
			}
		}

		let parsedPurchasedAt: string | null = null;
		if (purchasedAtRaw) {
			const d = new Date(purchasedAtRaw);
			if (isNaN(d.getTime())) {
				rowReasons.push(
					`Format tanggal beli "${purchasedAtRaw}" tidak valid (gunakan YYYY-MM-DD).`
				);
			} else {
				parsedPurchasedAt = d.toISOString();
			}
		}

		if (rowReasons.length > 0) {
			const reason = rowReasons.join(' ');
			errors.push({ rowNumber, reason, raw });
			previewRows.push({
				rowNumber,
				name,
				category: categoryName,
				categoryId: matchedCategory?.id ?? null,
				serialNumber,
				homeLocation: homeLocationName,
				homeLocationId: matchedLocationId,
				purchasedAt: parsedPurchasedAt,
				notes,
				status: 'ERROR',
				reason
			});
			continue;
		}

		// Bagian 18: Impor harus idempoten terhadap baris yang sama (cocokkan berdasarkan nomor seri bila ada)
		if (serialNumber) {
			const normSn = serialNumber.toLowerCase();
			if (existingSerials.has(normSn) || seenSerialsInFile.has(normSn)) {
				previewRows.push({
					rowNumber,
					name,
					category: categoryName,
					categoryId: matchedCategory!.id,
					serialNumber,
					homeLocation: homeLocationName,
					homeLocationId: matchedLocationId,
					purchasedAt: parsedPurchasedAt,
					notes,
					status: 'DUPLICATE_SKIPPED',
					reason: `Nomor seri "${serialNumber}" sudah terdaftar (dilewati secara idempoten).`
				});
				continue;
			}
			seenSerialsInFile.add(normSn);
		}

		previewRows.push({
			rowNumber,
			name,
			category: categoryName,
			categoryId: matchedCategory!.id,
			serialNumber,
			homeLocation: homeLocationName,
			homeLocationId: matchedLocationId,
			purchasedAt: parsedPurchasedAt,
			notes,
			status: 'VALID'
		});
	}

	const validRows = previewRows.filter((r) => r.status === 'VALID');
	const skippedRows = previewRows.filter((r) => r.status === 'DUPLICATE_SKIPPED');

	if (params.mode === 'preview') {
		return {
			mode: 'preview' as const,
			totalRows: previewRows.length,
			validCount: validRows.length,
			skippedDuplicateCount: skippedRows.length,
			failedCount: errors.length,
			createdCount: 0,
			previewRows,
			errors
		};
	}

	// Mode commit: tulis baris valid ke database dalam satu transaksi + AuditLog
	const createdAssets = await prisma.$transaction(async (tx) => {
		const results = [];
		for (const row of validRows) {
			const code = await generateNextAssetCode(tx);
			const qrToken = generateRandomQrToken();
			const cat = categories.find((c) => c.id === row.categoryId);
			const nextMaintenanceAt = cat?.maintenanceIntervalDays
				? new Date(Date.now() + cat.maintenanceIntervalDays * 86400_000)
				: null;

			const created = await tx.asset.create({
				data: {
					code,
					qrToken,
					name: row.name,
					categoryId: row.categoryId!,
					serialNumber: row.serialNumber,
					status: 'AVAILABLE',
					homeLocationId: row.homeLocationId,
					purchasedAt: row.purchasedAt ? new Date(row.purchasedAt) : null,
					notes: row.notes,
					nextMaintenanceAt
				}
			});

			await writeAuditLog(tx, {
				actorId: adminActor.id,
				action: 'ASSET_CREATED_VIA_IMPORT',
				entityType: 'Asset',
				entityId: created.id,
				after: {
					code: created.code,
					name: created.name,
					serialNumber: created.serialNumber,
					rowNumber: row.rowNumber
				},
				ip: ip ?? null
			});

			results.push(created);
		}

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'ASSET_CSV_IMPORTED',
			entityType: 'AssetImport',
			entityId: `import-${Date.now()}`,
			after: {
				totalRows: previewRows.length,
				createdCount: results.length,
				skippedDuplicateCount: skippedRows.length,
				failedCount: errors.length
			},
			ip: ip ?? null
		});

		return results;
	});

	return {
		mode: 'commit' as const,
		totalRows: previewRows.length,
		validCount: validRows.length,
		skippedDuplicateCount: skippedRows.length,
		failedCount: errors.length,
		createdCount: createdAssets.length,
		createdAssets: createdAssets.map((a) => ({
			id: a.id,
			code: a.code,
			qrToken: a.qrToken,
			name: a.name,
			serialNumber: a.serialNumber
		})),
		previewRows,
		errors
	};
}
