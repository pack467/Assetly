<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { mobileApi } from '$lib/client/api';
	import {
		getOfflineQueueStorage,
		subscribeOfflineQueue,
		type OfflineQueueItem
	} from '$lib/client/offlineQueue';
	import { enqueueOfflineOperation, syncPendingOperations } from '$lib/client/syncManager';
	import { formatFriendlyErrorMessage } from '$lib/shared/mobile/watermark';

	interface OutstandingLoanItem {
		loanItemId?: string;
		loanId?: string;
		assetId: string;
		purpose: string;
		expectedReturnAt?: string;
		isOverdue: boolean;
		defaultResponsibleUserId?: string;
		isQueuedOfflineBorrow?: boolean;
		asset: {
			id: string;
			code: string;
			name: string;
			status: string;
		};
		borrower: {
			id: string;
			name: string;
			email: string;
		};
	}

	interface ShiftItemRecord {
		id: string;
		loanItemId: string;
		reason: string;
		responsible: { id: string; name: string; email: string } | null;
		loanItem: {
			asset: { id: string; code: string; name: string; status: string };
			loan: {
				borrower: { id: string; name: string; email: string };
			};
		};
	}

	interface ShiftRecord {
		id: string;
		status: 'OPEN' | 'CLOSED';
		openedAt: string;
		closedAt: string | null;
		note: string | null;
		user: { id: string; name: string; email: string; role: string };
		items: ShiftItemRecord[];
		forceClosedByAdmin?: {
			adminId: string;
			adminName: string;
			adminEmail: string;
			emergencyCloseReason: string;
			closedAt: string;
		} | null;
	}

	let currentShift = $state<ShiftRecord | null>(null);
	let serverOutstandingItems = $state<OutstandingLoanItem[]>([]);
	let pendingQueueOps = $state<OfflineQueueItem[]>([]);
	let previousClosedShift = $state<ShiftRecord | null>(null);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');
	let queuedMsg = $state('');

	let openNote = $state('');
	let closeNote = $state('');
	// Map alasan berdasarkan key unik (loanItemId atau assetId)
	let reasonsByKey = $state<Record<string, string>>({});
	let submitting = $state(false);
	let unsubscribeQueue: (() => void) | null = null;

	function getItemKey(item: OutstandingLoanItem): string {
		return item.loanItemId || item.assetId || item.asset.id;
	}

	/**
	 * Lapis 1: Menggabungkan daftar barang keluar dari server dengan transaksi pinjam/kembali
	 * yang masih mengantre secara offline di HP ini (diidentifikasi lewat assetId).
	 */
	const effectiveOutstandingItems = $derived.by(() => {
		const returnedLoanItemIds = new Set<string>();
		const returnedAssetIds = new Set<string>();

		for (const op of pendingQueueOps) {
			if (op.type === 'LOAN_RETURN') {
				if (typeof op.payload.loanItemId === 'string') {
					returnedLoanItemIds.add(op.payload.loanItemId);
				}
				if (typeof op.payload.assetId === 'string') {
					returnedAssetIds.add(op.payload.assetId);
				}
			}
		}

		const list: OutstandingLoanItem[] = serverOutstandingItems
			.filter(
				(item) =>
					!(item.loanItemId && returnedLoanItemIds.has(item.loanItemId)) &&
					!returnedAssetIds.has(item.asset.id)
			)
			.map((item) => ({
				...item,
				assetId: item.assetId || item.asset.id
			}));

		const existingAssetIds = new Set(list.map((i) => i.asset.id));

		for (const op of pendingQueueOps) {
			if (op.type === 'LOAN_CREATE') {
				const rawItems = Array.isArray(op.payload.items)
					? (op.payload.items as Array<Record<string, unknown>>)
					: typeof op.payload.assetId === 'string'
						? [{ assetId: op.payload.assetId }]
						: [];

				for (const raw of rawItems) {
					const assetId = typeof raw.assetId === 'string' ? raw.assetId : '';
					if (!assetId || existingAssetIds.has(assetId) || returnedAssetIds.has(assetId)) {
						continue;
					}
					existingAssetIds.add(assetId);
					list.push({
						assetId,
						purpose: String(op.payload.purpose ?? 'Pinjaman Offline'),
						isOverdue: false,
						isQueuedOfflineBorrow: true,
						asset: {
							id: assetId,
							code: op.assetCode ?? 'BARANG-OFFLINE',
							name: op.assetName ?? op.label,
							status: 'BORROWED'
						},
						borrower: {
							id: '',
							name: 'Antrean Pinjam Offline di HP Ini',
							email: ''
						}
					});
				}
			}
		}

		return list;
	});

	async function syncQueueSnapshot() {
		const all = await getOfflineQueueStorage().listAll();
		pendingQueueOps = all.filter((op) => op.syncState === 'PENDING' || op.syncState === 'SYNCING');
	}

	async function loadShiftState() {
		loading = true;
		errorMsg = '';
		try {
			const res = await mobileApi.get('/api/v1/shifts/current');
			const data = await res.json();
			if (!res.ok) {
				errorMsg = formatFriendlyErrorMessage(
					data,
					'Halaman Shift hanya untuk Petugas (OFFICER) dan Admin.'
				);
				return;
			}
			currentShift = data.currentShift;
			serverOutstandingItems = (data.outstandingItems ?? []).map((it: OutstandingLoanItem) => ({
				...it,
				assetId: it.assetId || it.asset.id
			}));
			previousClosedShift = data.previousClosedShift;

			try {
				sessionStorage.setItem(
					'itam_shift_state_cache',
					JSON.stringify({
						currentShift,
						outstandingItems: serverOutstandingItems,
						previousClosedShift
					})
				);
			} catch {
				// Abaikan bila storage penuh
			}
		} catch {
			try {
				const cached = sessionStorage.getItem('itam_shift_state_cache');
				if (cached) {
					const parsed = JSON.parse(cached);
					currentShift = parsed.currentShift ?? null;
					serverOutstandingItems = parsed.outstandingItems ?? [];
					previousClosedShift = parsed.previousClosedShift ?? null;
					return;
				}
			} catch {
				// Abaikan
			}
			errorMsg = 'Gagal memuat status shift. Periksa koneksi internet Anda.';
		} finally {
			loading = false;
		}
	}

	async function handleOpenShift(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		queuedMsg = '';
		submitting = true;
		try {
			const queued = await enqueueOfflineOperation({
				type: 'SHIFT_OPEN',
				label: 'Buka Shift Kerja Petugas',
				payload: {
					note: openNote.trim() || null
				}
			});

			await syncPendingOperations({ force: true });
			const latest = await getOfflineQueueStorage().getById(queued.clientOpId);

			if (latest?.syncState === 'ACCEPTED') {
				successMsg = 'Shift kerja berhasil dibuka dan tersinkron ke server.';
				openNote = '';
				await loadShiftState();
			} else if (latest?.syncState === 'CONFLICT' || latest?.syncState === 'REJECTED') {
				errorMsg =
					latest.conflictReason || latest.lastError || 'Gagal membuka shift kerja di server.';
			} else {
				queuedMsg =
					'Tersimpan di Antrean Lokal HP! Pembukaan shift akan dikirim otomatis ke server saat sinyal kembali.';
				openNote = '';
			}
		} catch {
			errorMsg = 'Gagal menyimpan pembukaan shift ke antrean lokal HP.';
		} finally {
			submitting = false;
		}
	}

	async function handleCloseShift(e: SubmitEvent) {
		e.preventDefault();
		if (!currentShift) return;
		errorMsg = '';
		successMsg = '';
		queuedMsg = '';

		// Validasi lokal awal agar pengguna tahu barang mana yang belum diisi alasannya (baik loanItemId maupun assetId offline)
		for (const item of effectiveOutstandingItems) {
			const key = getItemKey(item);
			const r = (reasonsByKey[key] || '').trim();
			if (r.length < 3) {
				errorMsg = `Mohon isi alasan untuk barang ${item.asset.code} (${item.asset.name}) yang masih keluar (minimal 3 karakter, BR-12).`;
				return;
			}
		}

		submitting = true;
		try {
			const queued = await enqueueOfflineOperation({
				type: 'SHIFT_CLOSE',
				label: `Tutup Shift Kerja (${effectiveOutstandingItems.length} barang keluar)`,
				payload: {
					shiftId: currentShift.id,
					note: closeNote.trim() || null,
					items: effectiveOutstandingItems.map((item) => {
						const key = getItemKey(item);
						return {
							...(item.loanItemId ? { loanItemId: item.loanItemId } : {}),
							assetId: item.asset.id,
							assetCode: item.asset.code,
							reason: (reasonsByKey[key] || '').trim(),
							...(item.defaultResponsibleUserId
								? { responsibleUserId: item.defaultResponsibleUserId }
								: {})
						};
					})
				}
			});

			await syncPendingOperations({ force: true });
			const latest = await getOfflineQueueStorage().getById(queued.clientOpId);

			if (latest?.syncState === 'ACCEPTED') {
				successMsg =
					effectiveOutstandingItems.length > 0
						? `Shift berhasil ditutup dengan mencatat ${effectiveOutstandingItems.length} barang yang masih keluar.`
						: 'Shift berhasil ditutup dengan bersih (semua barang telah kembali).';
				closeNote = '';
				await loadShiftState();
			} else if (latest?.syncState === 'CONFLICT' || latest?.syncState === 'REJECTED') {
				errorMsg =
					latest.conflictReason ||
					latest.lastError ||
					'Penutupan shift ditolak server. Silakan periksa dan lengkapi alasan di menu Sinkron (/m/sync).';
			} else {
				queuedMsg =
					'Tersimpan di Antrean Lokal HP! Data penutupan shift akan diproses berurutan setelah operasi peminjaman offline sebelumnya terkirim ke server.';
				closeNote = '';
			}
		} catch {
			errorMsg = 'Gagal menyimpan penutupan shift ke antrean lokal HP.';
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		unsubscribeQueue = subscribeOfflineQueue(() => {
			syncQueueSnapshot();
		});
		syncQueueSnapshot();
		loadShiftState();
	});

	onDestroy(() => {
		if (unsubscribeQueue) {
			unsubscribeQueue();
			unsubscribeQueue = null;
		}
	});
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-xl font-bold text-slate-900">Manajemen Shift Petugas</h1>
		<p class="mt-0.5 text-xs text-slate-600">
			Buka dan tutup shift kerja. Setiap barang yang belum kembali saat tutup shift wajib diberi
			alasan (Bagian 7.4 & BR-12).
		</p>
	</div>

	{#if queuedMsg}
		<div
			class="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-950"
		>
			<div>{queuedMsg}</div>
			<div class="mt-2">
				<a href="/m/sync" class="text-xs font-bold text-amber-900 underline">
					Lihat Antrean Sinkronisasi (/m/sync) →
				</a>
			</div>
		</div>
	{/if}

	{#if errorMsg}
		<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
			<div>{errorMsg}</div>
			<div class="mt-2">
				<a href="/m/sync" class="text-xs font-bold text-red-900 underline">
					Buka Layar Antrean & Lengkapi Alasan (/m/sync) →
				</a>
			</div>
		</div>
	{/if}
	{#if successMsg}
		<div
			class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800"
		>
			{successMsg}
		</div>
	{/if}

	{#if loading}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			Memuat status shift...
		</div>
	{:else}
		<!-- CATATAN SERAH TERIMA DARI SHIFT SEBELUMNYA (Bagian 7.4 langkah 4) -->
		{#if previousClosedShift}
			<div class="rounded-2xl border border-blue-200 bg-blue-50 p-4 space-y-2.5">
				<div class="flex items-center justify-between">
					<span class="text-xs font-extrabold uppercase tracking-wider text-blue-900">
						Catatan Shift Sebelumnya
					</span>
					<span class="text-[11px] text-blue-700">
						{previousClosedShift.closedAt
							? new Date(previousClosedShift.closedAt).toLocaleString('id-ID')
							: ''}
					</span>
				</div>
				<div class="text-xs text-blue-900">
					Petugas: <strong>{previousClosedShift.user.name}</strong>
					{previousClosedShift.note ? ` · Catatan: "${previousClosedShift.note}"` : ''}
				</div>
				{#if previousClosedShift.forceClosedByAdmin}
					<div
						class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 space-y-1"
					>
						<div class="font-extrabold text-amber-900">
							⚠ Shift Sebelumnya Ditutup Darurat oleh Admin ({previousClosedShift.forceClosedByAdmin
								.adminName})
						</div>
						<div>
							Alasan Darurat:
							<strong>"{previousClosedShift.forceClosedByAdmin.emergencyCloseReason}"</strong>
						</div>
					</div>
				{/if}
				{#if previousClosedShift.items.length === 0}
					<div class="text-xs font-medium text-emerald-800">
						✓ Shift sebelumnya ditutup bersih tanpa barang tertinggal.
					</div>
				{:else}
					<div class="space-y-2 pt-1">
						<div class="text-xs font-bold text-blue-950">
							Barang Tertinggal dari Shift Sebelumnya ({previousClosedShift.items.length}):
						</div>
						{#each previousClosedShift.items as sItem (sItem.id)}
							<div class="rounded-xl bg-white p-3 text-xs shadow-2xs space-y-1">
								<div class="font-bold text-slate-900">
									{sItem.loanItem.asset.code} — {sItem.loanItem.asset.name}
								</div>
								<div class="text-slate-700">
									Alasan: <strong>{sItem.reason}</strong>
								</div>
								<div class="text-slate-500">
									Penanggung Jawab:
									{sItem.responsible?.name || sItem.loanItem.loan.borrower.name}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- FORM BUKA SHIFT ATAU TUTUP SHIFT -->
		{#if !currentShift}
			<form
				onsubmit={handleOpenShift}
				class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
			>
				<h2 class="text-base font-bold text-slate-900">Buka Shift Kerja Baru</h2>
				<div>
					<label for="sh-open-note" class="block text-sm font-bold text-slate-800">
						Catatan Awal Shift (Opsional)
					</label>
					<input
						id="sh-open-note"
						type="text"
						bind:value={openNote}
						placeholder="Mis. Shift Pagi Ruang Seminar Utama"
						class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base"
					/>
				</div>
				<button
					type="submit"
					disabled={submitting}
					class="w-full rounded-xl bg-slate-900 py-4 text-base font-extrabold text-white active:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Membuka Shift...' : 'BUKA SHIFT SEKARANG'}
				</button>
			</form>
		{:else}
			<form
				onsubmit={handleCloseShift}
				class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
			>
				<div class="flex items-center justify-between border-b border-slate-100 pb-3">
					<div>
						<span
							class="rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-bold text-emerald-800"
						>
							SHIFT AKTIF (OPEN)
						</span>
						<div class="mt-1 text-xs text-slate-600">
							Dibuka: {new Date(currentShift.openedAt).toLocaleString('id-ID')}
						</div>
					</div>
				</div>

				{#if effectiveOutstandingItems.length === 0}
					<div
						class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-900"
					>
						<strong>Tidak Ada Barang yang Masih Keluar.</strong> Seluruh barang dalam keadaan tersimpan/kembali.
						Anda dapat menutup shift dengan bersih.
					</div>
				{:else}
					<div class="space-y-3">
						<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
							<strong>Perhatian (BR-12):</strong> Terdapat
							<strong>{effectiveOutstandingItems.length} barang</strong> yang masih keluar (termasuk pinjaman
							offline di HP ini). Anda wajib mengisi alasan untuk setiap barang di bawah sebelum menutup
							shift.
						</div>

						{#each effectiveOutstandingItems as item (getItemKey(item))}
							{@const key = getItemKey(item)}
							<div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
								<div class="flex items-start justify-between gap-2">
									<div>
										<div class="font-mono text-xs font-bold text-slate-700">
											{item.asset.code}
										</div>
										<div class="text-sm font-bold text-slate-900">{item.asset.name}</div>
									</div>
									{#if item.isQueuedOfflineBorrow}
										<span
											class="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900"
										>
											Antrean Offline (via assetId)
										</span>
									{:else if item.isOverdue}
										<span
											class="rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-bold text-red-800"
										>
											TERLAMBAT
										</span>
									{/if}
								</div>
								<div class="text-xs text-slate-600">
									Peminjam / Penanggung Jawab: <strong>{item.borrower.name}</strong> · Keperluan:
									{item.purpose}
								</div>
								<div>
									<label for={`reason-${key}`} class="block text-xs font-bold text-slate-800">
										Alasan Barang Belum Kembali (Wajib - BR-12)
									</label>
									<input
										id={`reason-${key}`}
										type="text"
										required
										minlength="3"
										bind:value={reasonsByKey[key]}
										placeholder="Mis. Acara seminar masih berlanjut hingga malam"
										class="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm"
									/>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<div>
					<label for="sh-close-note" class="block text-sm font-bold text-slate-800">
						Catatan Penutupan Shift (Opsional)
					</label>
					<input
						id="sh-close-note"
						type="text"
						bind:value={closeNote}
						placeholder="Catatan serah terima ke petugas shift berikutnya..."
						class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base"
					/>
				</div>

				<button
					type="submit"
					disabled={submitting}
					class="w-full rounded-xl bg-slate-900 py-4 text-base font-extrabold text-white active:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Menutup Shift...' : 'TUTUP SHIFT SEKARANG'}
				</button>
			</form>
		{/if}
	{/if}
</div>
