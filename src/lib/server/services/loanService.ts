import { Prisma, type LoanStatus } from '@prisma/client';
import { prisma } from '$lib/server/db';
import { writeAuditLog, type DbTx } from '$lib/server/audit';
import { assertCan, can, type PolicyUser } from '$lib/server/policy';
import { createEvidenceSignedUrl } from '$lib/server/storage';
import { isValidAssetStatusTransition } from '$lib/shared/enums';
import { AppError } from '$lib/shared/errors';
import type { z } from 'zod';
import type { createLoanSchema, returnLoanItemSchema } from '$lib/shared/schemas/loan';

const LOAN_DETAIL_INCLUDE = {
	borrower: {
		select: { id: true, name: true, email: true, role: true }
	},
	createdBy: {
		select: { id: true, name: true, email: true, role: true }
	},
	approvedBy: {
		select: { id: true, name: true, email: true, role: true }
	},
	items: {
		include: {
			asset: {
				include: {
					category: true,
					homeLocation: true
				}
			},
			checkoutEvidence: {
				include: { location: true }
			},
			returnEvidence: {
				include: { location: true }
			},
			accessoryChecks: true
		}
	},
	handovers: true
} satisfies Prisma.LoanInclude;

async function assertEvidenceNotUsed(tx: DbTx, evidenceIds: string[]): Promise<void> {
	const [usedInLoanItem, usedInHandover] = await Promise.all([
		tx.loanItem.findFirst({
			where: {
				OR: [{ checkoutEvidenceId: { in: evidenceIds } }, { returnEvidenceId: { in: evidenceIds } }]
			},
			select: { id: true, checkoutEvidenceId: true, returnEvidenceId: true }
		}),
		tx.handover.findFirst({
			where: { evidenceId: { in: evidenceIds } },
			select: { id: true, evidenceId: true }
		})
	]);

	if (usedInLoanItem || usedInHandover) {
		const duplicateId =
			usedInLoanItem?.checkoutEvidenceId ??
			usedInLoanItem?.returnEvidenceId ??
			usedInHandover?.evidenceId;
		throw new AppError(
			'DUPLICATE_OPERATION',
			'Foto bukti (Evidence) ini sudah pernah digunakan dan tidak boleh dipakai ulang.',
			{ evidenceId: duplicateId }
		);
	}
}

export async function createLoan(
	actor: PolicyUser | null | undefined,
	input: z.infer<typeof createLoanSchema>,
	ip?: string
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const borrowerId = input.borrowerId ?? actor.id;
	assertCan(actor, 'loan:create', { borrowerId });

	// BR-14: Idempotensi melalui clientOpId
	if (input.clientOpId) {
		const existingByOp = await prisma.loan.findUnique({
			where: { clientOpId: input.clientOpId },
			include: LOAN_DETAIL_INCLUDE
		});
		if (existingByOp) {
			if (existingByOp.borrowerId !== borrowerId && existingByOp.createdById !== actor.id) {
				throw new AppError(
					'DUPLICATE_OPERATION',
					'clientOpId sudah digunakan oleh operasi pengguna lain.'
				);
			}
			return {
				loan: existingByOp,
				idempotentReplay: true
			};
		}
	}

	const normalizedItems =
		input.items && input.items.length > 0
			? input.items
			: input.assetId
				? [{ assetId: input.assetId, checkoutEvidenceId: input.evidenceId }]
				: [];

	if (normalizedItems.length === 0) {
		throw new AppError('VALIDATION_ERROR', 'Minimal satu barang wajib dipilih untuk peminjaman.');
	}

	// Pastikan tidak ada duplikasi assetId dalam satu permintaan
	const uniqueAssetIds = new Set(normalizedItems.map((i) => i.assetId));
	if (uniqueAssetIds.size !== normalizedItems.length) {
		throw new AppError(
			'VALIDATION_ERROR',
			'Tidak boleh memasukkan barang yang sama lebih dari satu kali dalam satu peminjaman.'
		);
	}

	const expectedReturnAt = new Date(input.expectedReturnAt);
	if (Number.isNaN(expectedReturnAt.getTime())) {
		throw new AppError('VALIDATION_ERROR', 'Tanggal rencana pengembalian tidak valid.');
	}

	// Setiap item wajib punya bukti foto CHECKOUT tersendiri (satu Evidence hanya boleh dipakai sekali)
	const evidenceIdsList: string[] = [];
	for (const item of normalizedItems) {
		const evId = item.checkoutEvidenceId ?? input.evidenceId;
		if (!evId) {
			throw new AppError(
				'EVIDENCE_REQUIRED',
				'Foto bukti kondisi barang saat meminjam (evidenceId) wajib disertakan.'
			);
		}
		if (evidenceIdsList.includes(evId)) {
			throw new AppError(
				'DUPLICATE_OPERATION',
				'Satu foto bukti (Evidence) hanya boleh dipakai sekali dan tidak boleh dibagi untuk beberapa item.',
				{ evidenceId: evId }
			);
		}
		evidenceIdsList.push(evId);
	}

	const evidences = await prisma.evidence.findMany({
		where: { id: { in: evidenceIdsList } }
	});
	if (evidences.length !== evidenceIdsList.length) {
		throw new AppError('EVIDENCE_REQUIRED', 'Data foto bukti (Evidence) tidak ditemukan.');
	}

	const blockOnMock = (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false';
	for (const ev of evidences) {
		// 1. Saat pinjam, foto bukti harus ber-purpose CHECKOUT
		if (ev.purpose !== 'CHECKOUT') {
			throw new AppError(
				'VALIDATION_ERROR',
				`Foto bukti untuk peminjaman wajib ber-purpose CHECKOUT (diterima: ${ev.purpose}).`,
				{ evidenceId: ev.id, expectedPurpose: 'CHECKOUT', actualPurpose: ev.purpose }
			);
		}

		// 2. Foto bukti harus diunggah oleh user yang sedang melakukan aksi
		if (ev.userId !== actor.id) {
			throw new AppError(
				'FORBIDDEN',
				'Foto bukti peminjaman harus diunggah oleh pengguna yang sedang melakukan aksi.',
				{ evidenceId: ev.id }
			);
		}

		// 4. Aturan MOCK_LOCATION (BR-07)
		if (ev.isMockLocation && blockOnMock) {
			throw new AppError(
				'MOCK_LOCATION_BLOCKED',
				'Bukti menggunakan lokasi palsu (mock location) dan tidak dapat dipakai meminjam (BR-07).'
			);
		}
	}

	try {
		const createdLoan = await prisma.$transaction(async (tx) => {
			// 3. Satu Evidence hanya boleh dipakai sekali
			await assertEvidenceNotUsed(tx, evidenceIdsList);

			const assets = await tx.asset.findMany({
				where: { id: { in: Array.from(uniqueAssetIds) } },
				include: {
					category: true,
					accessories: true,
					loanItems: {
						where: { returnedAt: null },
						take: 1,
						include: {
							loan: {
								include: {
									borrower: { select: { name: true } }
								}
							}
						}
					}
				}
			});

			if (assets.length !== uniqueAssetIds.size) {
				throw new AppError('NOT_FOUND', 'Salah satu barang tidak ditemukan.');
			}

			const assetMap = new Map(assets.map((a) => [a.id, a]));

			// BR-01: Barang hanya bisa dipinjam bila status = AVAILABLE
			for (const item of normalizedItems) {
				const asset = assetMap.get(item.assetId)!;
				if (asset.status !== 'AVAILABLE') {
					const holder = asset.loanItems[0]?.loan.borrower.name ?? null;
					throw new AppError(
						'ASSET_NOT_AVAILABLE',
						`Barang ${asset.code} (${asset.name}) sedang tidak tersedia (status: ${asset.status}).`,
						{
							assetId: asset.id,
							code: asset.code,
							status: asset.status,
							...(holder ? { currentHolder: holder } : {})
						}
					);
				}
			}

			// BR-08: Bila Category.requiresApproval = true, masuk PENDING_APPROVAL
			const requiresApproval = assets.some((a) => a.category.requiresApproval);
			const nextLoanStatus: LoanStatus = requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE';
			const nextAssetStatus = requiresApproval ? 'PENDING_APPROVAL' : 'BORROWED';

			// Kunci dan ubah status tiap barang secara atomik (optimistic/conditional update)
			for (const item of normalizedItems) {
				const asset = assetMap.get(item.assetId)!;
				const updatedCount = await tx.asset.updateMany({
					where: {
						id: asset.id,
						status: 'AVAILABLE',
						version: asset.version
					},
					data: {
						status: nextAssetStatus,
						version: { increment: 1 }
					}
				});

				if (updatedCount.count === 0) {
					throw new AppError(
						'ALREADY_BORROWED_CONFLICT',
						`Barang ${asset.code} baru saja dipinjam oleh pengguna lain pada saat bersamaan.`,
						{ assetId: asset.id, code: asset.code }
					);
				}
			}

			const loan = await tx.loan.create({
				data: {
					borrowerId,
					createdById: actor.id,
					purpose: input.purpose.trim(),
					purposeNote: input.purposeNote?.trim() || null,
					expectedReturnAt,
					status: nextLoanStatus,
					clientOpId: input.clientOpId ?? null,
					items: {
						create: normalizedItems.map((item) => {
							const asset = assetMap.get(item.assetId)!;
							const checksToCreate =
								item.accessoryChecks && item.accessoryChecks.length > 0
									? item.accessoryChecks
									: asset.accessories.map((acc) => ({
											name: acc.name,
											quantity: acc.quantity,
											outOk: true
										}));

							return {
								assetId: item.assetId,
								checkoutEvidenceId: item.checkoutEvidenceId ?? input.evidenceId ?? null,
								...(checksToCreate.length > 0
									? {
											accessoryChecks: {
												create: checksToCreate.map((c) => ({
													name: c.name,
													quantity: c.quantity ?? 1,
													outOk: c.outOk ?? true
												}))
											}
										}
									: {})
							};
						})
					}
				},
				include: LOAN_DETAIL_INCLUDE
			});

			await writeAuditLog(tx, {
				actorId: actor.id,
				action: 'LOAN_CREATED',
				entityType: 'Loan',
				entityId: loan.id,
				after: {
					borrowerId: loan.borrowerId,
					status: loan.status,
					purpose: loan.purpose,
					expectedReturnAt: loan.expectedReturnAt.toISOString(),
					assetIds: normalizedItems.map((i) => i.assetId)
				},
				ip: ip ?? null
			});

			for (const item of normalizedItems) {
				const asset = assetMap.get(item.assetId)!;
				await writeAuditLog(tx, {
					actorId: actor.id,
					action: 'ASSET_STATUS_CHANGED',
					entityType: 'Asset',
					entityId: asset.id,
					before: { status: 'AVAILABLE' },
					after: { status: nextAssetStatus, loanId: loan.id },
					ip: ip ?? null
				});
			}

			return loan;
		});

		return {
			loan: createdLoan,
			idempotentReplay: false
		};
	} catch (err) {
		if (err instanceof AppError) throw err;

		// Tangkap pelanggaran unique partial index one_active_loan_per_asset atau clientOpId dari PostgreSQL
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			const target = JSON.stringify(err.meta ?? '');
			if (input.clientOpId && target.includes('clientOpId')) {
				const existing = await prisma.loan.findUnique({
					where: { clientOpId: input.clientOpId },
					include: LOAN_DETAIL_INCLUDE
				});
				if (existing) {
					return { loan: existing, idempotentReplay: true };
				}
			}
			throw new AppError(
				'ALREADY_BORROWED_CONFLICT',
				'Barang sedang dipinjam oleh pengguna lain (ditolak oleh constraint database BR-02).'
			);
		}

		throw err;
	}
}

export async function returnLoanItem(
	actor: PolicyUser | null | undefined,
	loanItemId: string,
	input: z.infer<typeof returnLoanItemSchema>,
	ip?: string
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const existingItem = await prisma.loanItem.findUnique({
		where: { id: loanItemId },
		include: {
			loan: true,
			asset: true,
			accessoryChecks: true
		}
	});

	if (!existingItem) {
		throw new AppError('NOT_FOUND', 'Data item peminjaman tidak ditemukan.');
	}

	assertCan(actor, 'loan:return', { borrowerId: existingItem.loan.borrowerId });

	if (existingItem.returnedAt !== null) {
		throw new AppError('INVALID_STATUS_TRANSITION', 'Barang ini sudah dikembalikan sebelumnya.', {
			returnedAt: existingItem.returnedAt.toISOString()
		});
	}

	if (existingItem.loan.status !== 'ACTIVE') {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Peminjaman berstatus ${existingItem.loan.status} tidak dapat diproses pengembaliannya.`
		);
	}

	// BR-09: Pengembalian wajib foto kondisi + pilihan kondisi. Bila DAMAGED: catatan kerusakan wajib
	if (input.returnCondition === 'DAMAGED') {
		if (!input.damageNote || input.damageNote.trim().length < 3) {
			throw new AppError(
				'VALIDATION_ERROR',
				'Catatan detail kerusakan wajib diisi saat mengembalikan barang dalam kondisi rusak (BR-09).',
				{ field: 'damageNote' }
			);
		}
	}

	const evidence = await prisma.evidence.findUnique({
		where: { id: input.evidenceId }
	});
	if (!evidence) {
		throw new AppError('EVIDENCE_REQUIRED', 'Foto bukti pengembalian tidak ditemukan.');
	}

	// 1. Saat kembali, foto bukti harus ber-purpose RETURN
	if (evidence.purpose !== 'RETURN') {
		throw new AppError(
			'VALIDATION_ERROR',
			`Foto bukti untuk pengembalian wajib ber-purpose RETURN (diterima: ${evidence.purpose}).`,
			{ evidenceId: evidence.id, expectedPurpose: 'RETURN', actualPurpose: evidence.purpose }
		);
	}

	// 2. Foto bukti harus diunggah oleh user yang sedang melakukan aksi
	if (evidence.userId !== actor.id) {
		throw new AppError(
			'FORBIDDEN',
			'Foto bukti pengembalian harus diunggah oleh pengguna yang sedang memproses pengembalian.',
			{ evidenceId: evidence.id }
		);
	}

	// 4. Terapkan aturan MOCK_LOCATION (BR-07) juga pada alur pengembalian
	const blockOnMock = (process.env.RISK_BLOCK_ON_MOCK ?? 'true').toLowerCase() !== 'false';
	if (evidence.isMockLocation && blockOnMock) {
		throw new AppError(
			'MOCK_LOCATION_BLOCKED',
			'Bukti pengembalian menggunakan lokasi palsu (mock location) dan diblokir sesuai kebijakan keamanan (BR-07).',
			{ evidenceId: evidence.id, riskLevel: evidence.riskLevel }
		);
	}

	const nextAssetStatus = input.returnCondition === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE';
	if (!isValidAssetStatusTransition(existingItem.asset.status, nextAssetStatus)) {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Transisi status barang dari ${existingItem.asset.status} ke ${nextAssetStatus} tidak sah.`
		);
	}

	const now = new Date();

	const result = await prisma.$transaction(async (tx) => {
		// 3. Satu Evidence hanya boleh dipakai sekali (tidak boleh sudah terpakai untuk pinjam atau kembali lain)
		await assertEvidenceNotUsed(tx, [input.evidenceId]);

		const updatedItem = await tx.loanItem.update({
			where: { id: loanItemId },
			data: {
				returnedAt: now,
				returnCondition: input.returnCondition,
				returnEvidenceId: input.evidenceId,
				damageNote: input.damageNote?.trim() || null
			}
		});

		if (input.accessoryChecks && input.accessoryChecks.length > 0) {
			for (const check of input.accessoryChecks) {
				if (check.id) {
					await tx.accessoryCheck.updateMany({
						where: { id: check.id, loanItemId },
						data: { returnOk: check.returnOk }
					});
				} else if (check.name) {
					await tx.accessoryCheck.updateMany({
						where: { loanItemId, name: check.name },
						data: { returnOk: check.returnOk }
					});
				}
			}
		} else {
			await tx.accessoryCheck.updateMany({
				where: { loanItemId },
				data: { returnOk: true }
			});
		}

		const updatedAsset = await tx.asset.update({
			where: { id: existingItem.assetId },
			data: {
				status: nextAssetStatus,
				version: { increment: 1 }
			}
		});

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'LOAN_ITEM_RETURNED',
			entityType: 'LoanItem',
			entityId: loanItemId,
			before: { returnedAt: null, assetStatus: existingItem.asset.status },
			after: {
				returnedAt: now.toISOString(),
				returnCondition: input.returnCondition,
				damageNote: input.damageNote?.trim() || null,
				assetStatus: nextAssetStatus
			},
			ip: ip ?? null
		});

		await writeAuditLog(tx, {
			actorId: actor.id,
			action: 'ASSET_STATUS_CHANGED',
			entityType: 'Asset',
			entityId: existingItem.assetId,
			before: { status: existingItem.asset.status },
			after: {
				status: nextAssetStatus,
				loanId: existingItem.loanId,
				returnCondition: input.returnCondition
			},
			ip: ip ?? null
		});

		const remainingActiveCount = await tx.loanItem.count({
			where: {
				loanId: existingItem.loanId,
				returnedAt: null
			}
		});

		let updatedLoan = await tx.loan.findUniqueOrThrow({
			where: { id: existingItem.loanId },
			include: LOAN_DETAIL_INCLUDE
		});

		if (remainingActiveCount === 0) {
			updatedLoan = await tx.loan.update({
				where: { id: existingItem.loanId },
				data: {
					status: 'COMPLETED',
					completedAt: now
				},
				include: LOAN_DETAIL_INCLUDE
			});

			await writeAuditLog(tx, {
				actorId: actor.id,
				action: 'LOAN_COMPLETED',
				entityType: 'Loan',
				entityId: existingItem.loanId,
				before: { status: 'ACTIVE' },
				after: { status: 'COMPLETED', completedAt: now.toISOString() },
				ip: ip ?? null
			});
		}

		return {
			loanItem: updatedItem,
			asset: updatedAsset,
			loan: updatedLoan
		};
	});

	return result;
}

export async function approveLoan(
	actor: PolicyUser | null | undefined,
	loanId: string,
	ip?: string
) {
	assertCan(actor, 'loan:approve');
	const adminActor = actor;

	const existing = await prisma.loan.findUnique({
		where: { id: loanId },
		include: { items: { include: { asset: true } } }
	});
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Peminjaman tidak ditemukan.');
	}
	if (existing.status !== 'PENDING_APPROVAL') {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			`Hanya peminjaman berstatus PENDING_APPROVAL yang dapat disetujui (saat ini: ${existing.status}).`
		);
	}

	const now = new Date();
	const updated = await prisma.$transaction(async (tx) => {
		for (const item of existing.items) {
			if (!isValidAssetStatusTransition(item.asset.status, 'BORROWED')) {
				throw new AppError(
					'INVALID_STATUS_TRANSITION',
					`Barang ${item.asset.code} tidak dalam status PENDING_APPROVAL.`
				);
			}
			await tx.asset.update({
				where: { id: item.assetId },
				data: { status: 'BORROWED', version: { increment: 1 } }
			});
			await writeAuditLog(tx, {
				actorId: adminActor.id,
				action: 'ASSET_STATUS_CHANGED',
				entityType: 'Asset',
				entityId: item.assetId,
				before: { status: item.asset.status },
				after: { status: 'BORROWED', loanId },
				ip: ip ?? null
			});
		}

		const loan = await tx.loan.update({
			where: { id: loanId },
			data: {
				status: 'ACTIVE',
				approvedById: adminActor.id,
				approvedAt: now
			},
			include: LOAN_DETAIL_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'LOAN_APPROVED',
			entityType: 'Loan',
			entityId: loanId,
			before: { status: 'PENDING_APPROVAL' },
			after: { status: 'ACTIVE', approvedAt: now.toISOString() },
			ip: ip ?? null
		});

		return loan;
	});

	return { loan: updated };
}

export async function rejectLoan(
	actor: PolicyUser | null | undefined,
	loanId: string,
	reason: string,
	ip?: string
) {
	assertCan(actor, 'loan:approve');
	const adminActor = actor;

	const existing = await prisma.loan.findUnique({
		where: { id: loanId },
		include: { items: { include: { asset: true } } }
	});
	if (!existing) {
		throw new AppError('NOT_FOUND', 'Peminjaman tidak ditemukan.');
	}
	if (existing.status !== 'PENDING_APPROVAL') {
		throw new AppError(
			'INVALID_STATUS_TRANSITION',
			'Hanya peminjaman berstatus PENDING_APPROVAL yang dapat ditolak.'
		);
	}

	const now = new Date();
	const updated = await prisma.$transaction(async (tx) => {
		for (const item of existing.items) {
			await tx.asset.update({
				where: { id: item.assetId },
				data: { status: 'AVAILABLE', version: { increment: 1 } }
			});
			await writeAuditLog(tx, {
				actorId: adminActor.id,
				action: 'ASSET_STATUS_CHANGED',
				entityType: 'Asset',
				entityId: item.assetId,
				before: { status: item.asset.status },
				after: { status: 'AVAILABLE', loanId, reason: 'LOAN_REJECTED' },
				ip: ip ?? null
			});
		}

		// Penting: Isi returnedAt pada LoanItem peminjaman yang ditolak agar unique index one_active_loan_per_asset bebas kembali
		await tx.loanItem.updateMany({
			where: { loanId },
			data: { returnedAt: now }
		});

		const loan = await tx.loan.update({
			where: { id: loanId },
			data: {
				status: 'REJECTED',
				rejectedReason: reason.trim(),
				completedAt: now
			},
			include: LOAN_DETAIL_INCLUDE
		});

		await writeAuditLog(tx, {
			actorId: adminActor.id,
			action: 'LOAN_REJECTED',
			entityType: 'Loan',
			entityId: loanId,
			before: { status: 'PENDING_APPROVAL' },
			after: { status: 'REJECTED', rejectedReason: reason.trim() },
			ip: ip ?? null
		});

		return loan;
	});

	return { loan: updated };
}

export async function listLoans(
	actor: PolicyUser | null | undefined,
	params: {
		page?: number;
		pageSize?: number;
		status?: LoanStatus;
		overdueOnly?: boolean;
		borrowerId?: string;
	} = {}
) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const page = Math.max(1, params.page ?? 1);
	const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
	const skip = (page - 1) * pageSize;
	const now = new Date();

	// Bagian 3.2: BORROWER hanya melihat miliknya, OFFICER melihat peminjaman yang ia tangani, ADMIN melihat semua
	const roleWhere: Prisma.LoanWhereInput =
		actor.role === 'ADMIN'
			? {}
			: actor.role === 'OFFICER'
				? {
						OR: [{ createdById: actor.id }, { borrowerId: actor.id }]
					}
				: { borrowerId: actor.id };

	const where: Prisma.LoanWhereInput = {
		...roleWhere,
		...(params.status ? { status: params.status } : {}),
		...(params.borrowerId && actor.role === 'ADMIN' ? { borrowerId: params.borrowerId } : {}),
		...(params.overdueOnly
			? {
					status: 'ACTIVE',
					expectedReturnAt: { lt: now },
					items: { some: { returnedAt: null } }
				}
			: {})
	};

	const [total, loans] = await Promise.all([
		prisma.loan.count({ where }),
		prisma.loan.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			skip,
			take: pageSize,
			include: LOAN_DETAIL_INCLUDE
		})
	]);

	// Bagian 5.2: "Terlambat" bukan status tersimpan; dihitung saat query
	const items = loans.map((l) => {
		const hasActiveItems = l.items.some((i) => i.returnedAt === null);
		const isOverdue = hasActiveItems && l.expectedReturnAt < now;
		return {
			...l,
			isOverdue,
			items: l.items.map((item) => ({
				...item,
				isOverdue: item.returnedAt === null && l.expectedReturnAt < now,
				checkoutSignedUrl: item.checkoutEvidence
					? createEvidenceSignedUrl(item.checkoutEvidence.id, item.checkoutEvidence.imageKey).url
					: null,
				returnSignedUrl: item.returnEvidence
					? createEvidenceSignedUrl(item.returnEvidence.id, item.returnEvidence.imageKey).url
					: null
			}))
		};
	});

	return {
		items,
		pagination: {
			page,
			pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize))
		}
	};
}

export async function getLoanDetail(actor: PolicyUser | null | undefined, loanId: string) {
	if (!actor || actor.isActive === false) {
		throw new AppError('UNAUTHENTICATED', 'Sesi login tidak valid.');
	}

	const loan = await prisma.loan.findUnique({
		where: { id: loanId },
		include: LOAN_DETAIL_INCLUDE
	});

	if (!loan) {
		throw new AppError('NOT_FOUND', 'Peminjaman tidak ditemukan.');
	}

	if (
		!can(actor, 'loan:read', {
			borrowerId: loan.borrowerId,
			createdById: loan.createdById
		})
	) {
		throw new AppError('FORBIDDEN', 'Anda tidak memiliki akses untuk melihat peminjaman ini.');
	}

	const now = new Date();
	const hasActiveItems = loan.items.some((i) => i.returnedAt === null);

	return {
		loan: {
			...loan,
			isOverdue: hasActiveItems && loan.expectedReturnAt < now,
			items: loan.items.map((item) => ({
				...item,
				isOverdue: item.returnedAt === null && loan.expectedReturnAt < now,
				checkoutSignedUrl: item.checkoutEvidence
					? createEvidenceSignedUrl(item.checkoutEvidence.id, item.checkoutEvidence.imageKey).url
					: null,
				returnSignedUrl: item.returnEvidence
					? createEvidenceSignedUrl(item.returnEvidence.id, item.returnEvidence.imageKey).url
					: null
			}))
		}
	};
}

export async function getDashboardSummary(actor: PolicyUser | null | undefined) {
	assertCan(actor, 'report:read');

	const now = new Date();

	const [
		assetGroups,
		activeLoansCount,
		activeLoanItemsCount,
		overdueLoanItemsCount,
		pendingApprovalsCount,
		unconfirmedHandoversCount,
		riskReviewCount,
		recentLoans
	] = await Promise.all([
		prisma.asset.groupBy({
			by: ['status'],
			_count: { _all: true }
		}),
		prisma.loan.count({
			where: { status: 'ACTIVE' }
		}),
		prisma.loanItem.count({
			where: { returnedAt: null, loan: { status: 'ACTIVE' } }
		}),
		prisma.loanItem.count({
			where: {
				returnedAt: null,
				loan: {
					status: 'ACTIVE',
					expectedReturnAt: { lt: now }
				}
			}
		}),
		prisma.loan.count({
			where: { status: 'PENDING_APPROVAL' }
		}),
		prisma.handover.count({
			where: {
				OR: [{ giverConfirmedAt: null }, { receiverConfirmedAt: null }]
			}
		}),
		prisma.evidence.count({
			where: {
				riskLevel: { in: ['NEEDS_REVIEW', 'SUSPICIOUS'] }
			}
		}),
		prisma.loan.findMany({
			where: {
				status: { in: ['ACTIVE', 'PENDING_APPROVAL'] }
			},
			orderBy: { createdAt: 'desc' },
			take: 10,
			include: LOAN_DETAIL_INCLUDE
		})
	]);

	const assetsByStatus: Record<string, number> = {
		AVAILABLE: 0,
		PENDING_APPROVAL: 0,
		BORROWED: 0,
		DAMAGED: 0,
		IN_MAINTENANCE: 0,
		LOST: 0,
		RETIRED: 0
	};
	let totalAssets = 0;
	for (const g of assetGroups) {
		assetsByStatus[g.status] = g._count._all;
		totalAssets += g._count._all;
	}

	return {
		totalAssets,
		assetsByStatus,
		loans: {
			activeLoansCount,
			activeLoanItemsCount,
			overdueLoanItemsCount,
			pendingApprovalsCount,
			unconfirmedHandoversCount,
			riskReviewCount
		},
		recentLoans: recentLoans.map((l) => {
			const hasActive = l.items.some((i) => i.returnedAt === null);
			return {
				id: l.id,
				status: l.status,
				purpose: l.purpose,
				expectedReturnAt: l.expectedReturnAt,
				createdAt: l.createdAt,
				isOverdue: hasActive && l.expectedReturnAt < now,
				borrower: l.borrower,
				items: l.items.map((item) => ({
					id: item.id,
					returnedAt: item.returnedAt,
					asset: {
						id: item.asset.id,
						code: item.asset.code,
						name: item.asset.name,
						status: item.asset.status
					},
					riskLevel: item.checkoutEvidence?.riskLevel ?? 'NORMAL',
					riskReasons: item.checkoutEvidence?.riskReasons ?? []
				}))
			};
		})
	};
}
