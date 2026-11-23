<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		computeOfflineQueueSummary,
		getOfflineQueueStorage,
		subscribeOfflineQueue,
		type OfflineOpType,
		type OfflineQueueItem,
		type OfflineQueueSummary,
		type OfflineSyncState
	} from '$lib/client/offlineQueue';
	import { syncPendingOperations } from '$lib/client/syncManager';

	let items = $state<OfflineQueueItem[]>([]);
	let summary = $state<OfflineQueueSummary>({
		pendingCount: 0,
		syncingCount: 0,
		conflictCount: 0,
		rejectedCount: 0,
		acceptedCount: 0,
		totalCount: 0
	});
	let activeFilter = $state<'ALL' | 'PENDING' | 'PROBLEM' | 'ACCEPTED'>('ALL');
	let syncing = $state(false);
	let statusFeedback = $state('');
	let isOnline = $state(true);

	let unsubscribeQueue: (() => void) | null = null;

	const opTypeLabels: Record<OfflineOpType, string> = {
		LOAN_CREATE: 'Peminjaman Barang',
		LOAN_RETURN: 'Pengembalian Barang',
		HANDOVER_CREATE: 'Pembuatan Serah Terima',
		HANDOVER_CONFIRM: 'Konfirmasi Serah Terima',
		SHIFT_OPEN: 'Buka Shift Petugas',
		SHIFT_CLOSE: 'Tutup Shift Petugas'
	};

	const stateBadgeConfig: Record<OfflineSyncState, { label: string; className: string }> = {
		PENDING: {
			label: 'Menunggu Kirim',
			className: 'bg-amber-100 text-amber-900 border border-amber-300'
		},
		SYNCING: {
			label: 'Sedang Mengirim...',
			className: 'bg-sky-100 text-sky-900 border border-sky-300'
		},
		ACCEPTED: {
			label: 'Berhasil (ACCEPTED)',
			className: 'bg-emerald-100 text-emerald-900 border border-emerald-300'
		},
		CONFLICT: {
			label: 'Konflik (CONFLICT)',
			className: 'bg-red-100 text-red-900 border border-red-300'
		},
		REJECTED: {
			label: 'Ditolak (REJECTED)',
			className: 'bg-rose-100 text-rose-900 border border-rose-300'
		}
	};

	async function refreshQueueList() {
		const storage = getOfflineQueueStorage();
		const all = await storage.listAll();
		// Urutkan yang terbaru di atas untuk tampilan UI
		items = [...all].sort((a, b) => b.clientCreatedAt.localeCompare(a.clientCreatedAt));
		summary = await computeOfflineQueueSummary(storage);
	}

	async function handleSyncNow() {
		statusFeedback = '';
		syncing = true;
		try {
			const outcome = await syncPendingOperations({ force: true });
			await refreshQueueList();

			if (outcome.processed === 0) {
				statusFeedback = isOnline
					? 'Tidak ada operasi yang sedang menunggu pengiriman.'
					: 'HP sedang offline. Antrean akan otomatis dikirim begitu sinyal kembali.';
			} else if (outcome.conflicts > 0 || outcome.rejected > 0) {
				statusFeedback = `Sinkronisasi selesai: ${outcome.accepted} berhasil, ${outcome.conflicts} konflik, ${outcome.rejected} ditolak. Mohon periksa kotak merah di bawah.`;
			} else if (outcome.stillPending > 0) {
				statusFeedback = `Sebagian operasi masih menunggu koneksi stabil (${outcome.stillPending} menunggu).`;
			} else {
				statusFeedback = `Seluruh operasi (${outcome.accepted}) berhasil disinkronkan ke server!`;
			}
		} finally {
			syncing = false;
		}
	}

	async function handleDismissItem(clientOpId: string) {
		await getOfflineQueueStorage().remove(clientOpId);
		statusFeedback = 'Catatan operasi telah dihapus dari antrean HP.';
		await refreshQueueList();
	}

	async function handleResolveConflictAndPickAnother(clientOpId: string) {
		await getOfflineQueueStorage().remove(clientOpId);
		await goto('/m/scan');
	}

	async function handleClearAccepted() {
		const removed = await getOfflineQueueStorage().clearByStates(['ACCEPTED']);
		if (removed > 0) {
			statusFeedback = `${removed} riwayat operasi yang sudah berhasil telah dibersihkan.`;
		}
		await refreshQueueList();
	}

	const filteredItems = $derived.by(() => {
		if (activeFilter === 'PENDING') {
			return items.filter((i) => i.syncState === 'PENDING' || i.syncState === 'SYNCING');
		}
		if (activeFilter === 'PROBLEM') {
			return items.filter((i) => i.syncState === 'CONFLICT' || i.syncState === 'REJECTED');
		}
		if (activeFilter === 'ACCEPTED') {
			return items.filter((i) => i.syncState === 'ACCEPTED');
		}
		return items;
	});

	onMount(() => {
		isOnline = navigator.onLine;
		const onOnline = () => {
			isOnline = true;
		};
		const onOffline = () => {
			isOnline = false;
		};
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);

		unsubscribeQueue = subscribeOfflineQueue(() => {
			refreshQueueList();
		});
		refreshQueueList();

		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	});

	onDestroy(() => {
		if (unsubscribeQueue) {
			unsubscribeQueue();
			unsubscribeQueue = null;
		}
	});
</script>

<div class="space-y-4">
	<!-- HEADER ANTREAN SINKRONISASI -->
	<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
		<div class="flex items-start justify-between gap-2">
			<div>
				<div class="text-xs font-bold uppercase tracking-wider text-slate-500">
					Antrean Offline & Sinkronisasi
				</div>
				<h1 class="mt-0.5 text-lg font-bold text-slate-900">Status Sinkronisasi HP</h1>
			</div>
			<span
				class="rounded-full px-3 py-1 text-xs font-bold {isOnline
					? 'bg-emerald-100 text-emerald-800'
					: 'bg-amber-100 text-amber-900'}"
			>
				{isOnline ? 'Sinyal Online' : 'Mode Offline'}
			</span>
		</div>

		<p class="mt-1.5 text-xs text-slate-600">
			Saat sinyal lemah atau terputus di gudang/lapangan, transaksi dan foto bukti disimpan aman di
			HP lalu diunggah otomatis di latar belakang begitu koneksi kembali.
		</p>

		<!-- RINGKASAN 4 STATUS -->
		<div class="mt-4 grid grid-cols-4 gap-2 text-center">
			<div class="rounded-xl border border-amber-200 bg-amber-50 p-2.5">
				<div class="text-lg font-extrabold text-amber-900">
					{summary.pendingCount + summary.syncingCount}
				</div>
				<div class="text-[11px] font-semibold text-amber-800">Menunggu</div>
			</div>
			<div class="rounded-xl border border-red-200 bg-red-50 p-2.5">
				<div class="text-lg font-extrabold text-red-800">{summary.conflictCount}</div>
				<div class="text-[11px] font-semibold text-red-700">Konflik</div>
			</div>
			<div class="rounded-xl border border-rose-200 bg-rose-50 p-2.5">
				<div class="text-lg font-extrabold text-rose-800">{summary.rejectedCount}</div>
				<div class="text-[11px] font-semibold text-rose-700">Ditolak</div>
			</div>
			<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5">
				<div class="text-lg font-extrabold text-emerald-800">{summary.acceptedCount}</div>
				<div class="text-[11px] font-semibold text-emerald-700">Berhasil</div>
			</div>
		</div>

		<!-- TOMBOL AKSI UTAMA -->
		<div class="mt-4 flex flex-col gap-2">
			<button
				type="button"
				onclick={handleSyncNow}
				disabled={syncing}
				class="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-bold text-white shadow-xs active:bg-slate-800 disabled:opacity-50"
			>
				{syncing
					? 'Sedang Mengunggah Foto & Menyinkronkan...'
					: `Sinkronkan Sekarang (${summary.pendingCount + summary.syncingCount} Menunggu)`}
			</button>

			{#if summary.acceptedCount > 0}
				<button
					type="button"
					onclick={handleClearAccepted}
					class="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 active:bg-slate-100"
				>
					Bersihkan Riwayat Berhasil ({summary.acceptedCount})
				</button>
			{/if}
		</div>

		{#if statusFeedback}
			<div
				class="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-medium text-slate-800"
			>
				{statusFeedback}
			</div>
		{/if}
	</div>

	<!-- BANNER PERINGATAN BILA ADA KONFLIK -->
	{#if summary.conflictCount > 0 || summary.rejectedCount > 0}
		<div class="rounded-2xl border-2 border-red-300 bg-red-50 p-4 shadow-2xs">
			<div class="text-xs font-extrabold uppercase tracking-wider text-red-800">
				Perhatian — Perlu Tindakan Anda
			</div>
			<div class="mt-1 text-sm font-bold text-red-950">
				Ada {summary.conflictCount + summary.rejectedCount} transaksi offline yang mengalami konflik atau
				ditolak server.
			</div>
			<p class="mt-1 text-xs text-red-800">
				Periksa rincian di bawah. Jika barang sudah dipinjam orang lain saat HP Anda offline, tekan
				tombol <strong>"Scan / Pilih Barang Lain"</strong>.
			</p>
		</div>
	{/if}

	<!-- FILTER TAB -->
	<div class="grid grid-cols-4 gap-1.5 rounded-xl bg-slate-200 p-1">
		<button
			type="button"
			onclick={() => (activeFilter = 'ALL')}
			class="rounded-lg py-2 text-xs font-bold {activeFilter === 'ALL'
				? 'bg-white text-slate-900 shadow-2xs'
				: 'text-slate-600'}"
		>
			Semua ({summary.totalCount})
		</button>
		<button
			type="button"
			onclick={() => (activeFilter = 'PENDING')}
			class="rounded-lg py-2 text-xs font-bold {activeFilter === 'PENDING'
				? 'bg-white text-slate-900 shadow-2xs'
				: 'text-slate-600'}"
		>
			Menunggu ({summary.pendingCount + summary.syncingCount})
		</button>
		<button
			type="button"
			onclick={() => (activeFilter = 'PROBLEM')}
			class="rounded-lg py-2 text-xs font-bold {activeFilter === 'PROBLEM'
				? 'bg-white text-red-700 shadow-2xs'
				: 'text-slate-600'}"
		>
			Masalah ({summary.conflictCount + summary.rejectedCount})
		</button>
		<button
			type="button"
			onclick={() => (activeFilter = 'ACCEPTED')}
			class="rounded-lg py-2 text-xs font-bold {activeFilter === 'ACCEPTED'
				? 'bg-white text-emerald-800 shadow-2xs'
				: 'text-slate-600'}"
		>
			Berhasil ({summary.acceptedCount})
		</button>
	</div>

	<!-- DAFTAR ITEM ANTREAN -->
	{#if filteredItems.length === 0}
		<div class="rounded-2xl border border-slate-200 bg-white p-6 text-center">
			<div class="text-sm font-bold text-slate-800">Tidak ada operasi pada kategori ini</div>
			<p class="mt-1 text-xs text-slate-500">
				Seluruh aktivitas pinjam dan kembali yang dilakukan saat offline maupun online akan tercatat
				di sini.
			</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each filteredItems as item (item.clientOpId)}
				{@const badge = stateBadgeConfig[item.syncState]}
				<div
					class="space-y-3 rounded-2xl border bg-white p-4 shadow-2xs {item.syncState ===
						'CONFLICT' || item.syncState === 'REJECTED'
						? 'border-red-300'
						: 'border-slate-200'}"
				>
					<div class="flex items-start justify-between gap-2">
						<div>
							<div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">
								{opTypeLabels[item.type]}
							</div>
							<div class="mt-0.5 text-sm font-bold text-slate-900">{item.label}</div>
						</div>
						<span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold {badge.className}">
							{badge.label}
						</span>
					</div>

					<div class="space-y-1 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
						<div>
							Waktu dicatat di HP:
							<strong class="text-slate-800">
								{new Date(item.clientCreatedAt).toLocaleString('id-ID')}
							</strong>
						</div>
						{#if item.pendingEvidence}
							<div>
								Status Foto Bukti:
								{#if item.pendingEvidence.uploadedEvidenceId || item.syncState === 'ACCEPTED'}
									<strong class="text-emerald-700">Sudah terunggah ke server</strong>
								{:else}
									<strong class="text-amber-700">
										Tersimpan di HP (menunggu diunggah di latar belakang)
									</strong>
								{/if}
							</div>
						{/if}
						{#if item.syncedAt}
							<div>
								Tersinkron pada:
								<strong class="text-emerald-700">
									{new Date(item.syncedAt).toLocaleString('id-ID')}
								</strong>
							</div>
						{/if}
						<div class="font-mono text-[10px] text-slate-400">
							ID Operasi: {item.clientOpId}
						</div>
					</div>

					{#if item.syncState === 'CONFLICT' || item.syncState === 'REJECTED'}
						<div class="space-y-3 rounded-xl border border-red-200 bg-red-50 p-3.5">
							<div>
								<div class="text-xs font-extrabold text-red-900">
									{item.syncState === 'CONFLICT' ? 'Penjelasan Konflik:' : 'Alasan Penolakan:'}
								</div>
								<p class="mt-1 text-xs leading-relaxed text-red-800">
									{item.conflictReason ||
										item.lastError ||
										'Operasi ini tidak dapat dilanjutkan karena terjadi perubahan data di server.'}
								</p>
							</div>

							<div class="flex flex-col gap-2">
								<button
									type="button"
									onclick={() => handleResolveConflictAndPickAnother(item.clientOpId)}
									class="w-full rounded-xl bg-red-700 px-4 py-3 text-xs font-bold text-white shadow-2xs active:bg-red-800"
								>
									Scan / Pilih Barang Lain & Hapus Catatan Ini
								</button>
								<button
									type="button"
									onclick={() => handleDismissItem(item.clientOpId)}
									class="w-full rounded-xl border border-red-300 bg-white px-4 py-2.5 text-xs font-bold text-red-800 active:bg-red-100"
								>
									Saya Mengerti, Hapus dari Antrean
								</button>
							</div>
						</div>
					{:else if item.syncState === 'PENDING'}
						{#if item.retryCount > 0 && item.lastError}
							<div
								class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
							>
								<div class="font-bold">
									Menunggu percobaan ulang otomatis (Percobaan ke-{item.retryCount})
								</div>
								<div class="mt-0.5 text-amber-800">{item.lastError}</div>
							</div>
						{/if}

						<div class="flex gap-2">
							<button
								type="button"
								onclick={handleSyncNow}
								disabled={syncing}
								class="flex-1 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white active:bg-slate-800 disabled:opacity-50"
							>
								Coba Kirim Sekarang
							</button>
							<button
								type="button"
								onclick={() => handleDismissItem(item.clientOpId)}
								disabled={syncing}
								class="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 active:bg-slate-100"
							>
								Batalkan
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
