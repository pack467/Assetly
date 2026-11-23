<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { mobileApi } from '$lib/client/api';
	import {
		computeOfflineQueueSummary,
		subscribeOfflineQueue,
		type OfflineQueueSummary
	} from '$lib/client/offlineQueue';
	import { LoanStatusLabels } from '$lib/shared/enums';

	interface ActiveLoanItem {
		id: string;
		returnedAt: string | null;
		isOverdue: boolean;
		asset: {
			id: string;
			code: string;
			name: string;
			status: string;
		};
	}

	interface LoanEntry {
		id: string;
		purpose: string;
		expectedReturnAt: string;
		status: keyof typeof LoanStatusLabels;
		isOverdue: boolean;
		items: ActiveLoanItem[];
	}

	let activeLoans = $state<LoanEntry[]>([]);
	let loading = $state(true);
	let queueSummary = $state<OfflineQueueSummary>({
		pendingCount: 0,
		syncingCount: 0,
		conflictCount: 0,
		rejectedCount: 0,
		acceptedCount: 0,
		totalCount: 0
	});
	let unsubscribeQueue: (() => void) | null = null;

	async function refreshQueueSummary() {
		queueSummary = await computeOfflineQueueSummary();
	}

	async function loadMyActiveLoans() {
		loading = true;
		try {
			const res = await mobileApi.get('/api/v1/loans?pageSize=20');
			if (res.ok) {
				const data = await res.json();
				const all: LoanEntry[] = data.items ?? [];
				activeLoans = all.filter((l) => l.status === 'ACTIVE' || l.status === 'PENDING_APPROVAL');
			}
		} catch {
			// Abaikan bila sedang offline
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		unsubscribeQueue = subscribeOfflineQueue(() => {
			refreshQueueSummary();
		});
		refreshQueueSummary();
		loadMyActiveLoans();
	});

	onDestroy(() => {
		if (unsubscribeQueue) {
			unsubscribeQueue();
			unsubscribeQueue = null;
		}
	});
</script>

<div class="space-y-5">
	<!-- TOMBOL SCAN UTAMA EKSTRA BESAR (Bagian 8.1) -->
	<div class="rounded-2xl bg-slate-900 p-5 text-white shadow-sm">
		<div class="text-xs font-semibold uppercase tracking-wider text-slate-300">
			Aksi Cepat Lapangan
		</div>
		<h1 class="mt-1 text-xl font-bold">Pinjam atau Kembalikan Barang</h1>
		<p class="mt-1 text-xs text-slate-300">
			Arahkan kamera ke label QR pada barang, atau ketik kode barang (mis. AST-0001).
		</p>
		<a
			href="/m/scan"
			class="mt-4 flex w-full items-center justify-center rounded-xl bg-white px-5 py-4 text-center text-base font-extrabold text-slate-900 shadow-xs active:bg-slate-100"
		>
			SCAN QR / CARI BARANG
		</a>
	</div>

	<!-- STATUS SINKRONISASI & PINTASAN SERAH TERIMA / SHIFT (Bagian 8.1) -->
	<div class="grid grid-cols-2 gap-3">
		<a
			href="/m/handovers"
			class="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs active:bg-slate-50"
		>
			<div class="text-xs font-semibold text-slate-500">Dua Pihak</div>
			<div class="mt-0.5 text-sm font-bold text-slate-900">Serah Terima →</div>
		</a>
		<a
			href="/m/shifts"
			class="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs active:bg-slate-50"
		>
			<div class="text-xs font-semibold text-slate-500">Petugas</div>
			<div class="mt-0.5 text-sm font-bold text-slate-900">Buka / Tutup Shift →</div>
		</a>
	</div>

	<a
		href="/m/sync"
		class="flex items-center justify-between rounded-2xl border bg-white p-4 shadow-2xs active:bg-slate-50 {queueSummary.conflictCount +
			queueSummary.rejectedCount >
		0
			? 'border-red-300'
			: 'border-slate-200'}"
	>
		<div>
			<div class="text-xs font-semibold text-slate-500">
				Status Sinkronisasi (Ketuk untuk detail)
			</div>
			<div class="mt-0.5 text-sm font-bold text-slate-900">
				{#if queueSummary.conflictCount + queueSummary.rejectedCount > 0}
					{queueSummary.conflictCount + queueSummary.rejectedCount} konflik/ditolak perlu tindakan
				{:else if queueSummary.pendingCount + queueSummary.syncingCount > 0}
					{queueSummary.pendingCount + queueSummary.syncingCount} operasi menunggu kirim
				{:else}
					0 operasi menunggu kirim
				{/if}
			</div>
		</div>
		{#if queueSummary.conflictCount + queueSummary.rejectedCount > 0}
			<span class="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">
				Periksa Konflik →
			</span>
		{:else if queueSummary.pendingCount + queueSummary.syncingCount > 0}
			<span class="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
				Menunggu →
			</span>
		{:else}
			<span class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
				Tersinkron
			</span>
		{/if}
	</a>

	<!-- DAFTAR PEMINJAMAN AKTIF SAYA -->
	<div class="space-y-3">
		<div class="flex items-center justify-between">
			<h2 class="text-base font-bold text-slate-900">Peminjaman Aktif Saya</h2>
			<a href="/m/loans" class="text-xs font-semibold text-slate-700 underline"> Lihat Semua → </a>
		</div>

		{#if loading}
			<div
				class="rounded-2xl border border-slate-200 bg-white p-5 text-center text-sm text-slate-500"
			>
				Memuat daftar pinjaman...
			</div>
		{:else if activeLoans.length === 0}
			<div class="rounded-2xl border border-slate-200 bg-white p-6 text-center">
				<div class="text-sm font-semibold text-slate-800">
					Tidak ada barang yang sedang dipinjam
				</div>
				<p class="mt-1 text-xs text-slate-500">
					Tekan tombol Scan QR di atas untuk mulai meminjam perangkat IT.
				</p>
			</div>
		{:else}
			{#each activeLoans as loan (loan.id)}
				<div class="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
					<div class="flex items-center justify-between">
						<span class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-800">
							{LoanStatusLabels[loan.status]}
						</span>
						{#if loan.isOverdue}
							<span class="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-800">
								TERLAMBAT
							</span>
						{/if}
					</div>

					<div class="text-xs text-slate-600">
						Keperluan: <strong class="text-slate-900">{loan.purpose}</strong> · Batas kembali:
						<strong class={loan.isOverdue ? 'text-red-700' : 'text-slate-900'}>
							{new Date(loan.expectedReturnAt).toLocaleString('id-ID')}
						</strong>
					</div>

					<div class="space-y-2 border-t border-slate-100 pt-2">
						{#each loan.items as item (item.id)}
							<div class="flex items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
								<div>
									<div class="font-mono text-xs font-bold text-slate-700">
										{item.asset.code}
									</div>
									<div class="text-sm font-bold text-slate-900">{item.asset.name}</div>
								</div>
								{#if !item.returnedAt && loan.status === 'ACTIVE'}
									<a
										href={`/m/assets/${encodeURIComponent(item.asset.code)}?mode=return`}
										class="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white active:bg-slate-800"
									>
										Kembalikan
									</a>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
