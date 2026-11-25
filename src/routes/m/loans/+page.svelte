<script lang="ts">
	import { onMount } from 'svelte';
	import { mobileApi } from '$lib/client/api';
	import { LoanStatusLabels } from '$lib/shared/enums';

	interface LoanItemEntry {
		id: string;
		returnedAt: string | null;
		returnCondition: 'NORMAL' | 'DAMAGED' | null;
		damageNote: string | null;
		isOverdue: boolean;
		checkoutSignedUrl: string | null;
		returnSignedUrl: string | null;
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
		purposeNote: string | null;
		expectedReturnAt: string;
		createdAt: string;
		completedAt: string | null;
		status: keyof typeof LoanStatusLabels;
		isOverdue: boolean;
		items: LoanItemEntry[];
	}

	let loans = $state<LoanEntry[]>([]);
	let loading = $state(true);
	let isFromOfflineCache = $state(false);
	let activeTab = $state<'active' | 'history'>('active');

	async function loadMyLoans() {
		loading = true;
		try {
			const res = await mobileApi.get('/api/v1/loans?pageSize=50');
			if (res.ok) {
				const data = await res.json();
				loans = data.items ?? [];
				isFromOfflineCache = false;
				try {
					sessionStorage.setItem('itam_my_loans_cache', JSON.stringify(loans));
				} catch {
					// Abaikan bila storage penuh
				}
				return;
			}
		} catch {
			// Fallback ke cache lokal saat offline
		} finally {
			try {
				if (loans.length === 0) {
					const cached = sessionStorage.getItem('itam_my_loans_cache');
					if (cached) {
						loans = JSON.parse(cached);
						isFromOfflineCache = true;
					}
				}
			} catch {
				// Abaikan
			}
			loading = false;
		}
	}

	const filteredLoans = $derived(
		loans.filter((l) =>
			activeTab === 'active'
				? l.status === 'ACTIVE' || l.status === 'PENDING_APPROVAL'
				: l.status === 'COMPLETED' || l.status === 'REJECTED' || l.status === 'CANCELLED'
		)
	);

	onMount(() => {
		loadMyLoans();
	});
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-xl font-bold text-slate-900">Peminjaman Saya</h1>
		<p class="mt-1 text-xs text-slate-600">
			Daftar barang yang sedang Anda pinjam beserta riwayat pengembalian.
		</p>
		{#if isFromOfflineCache}
			<div
				class="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs font-medium text-amber-900"
			>
				<strong>Cache Offline:</strong> Menampilkan daftar peminjaman terakhir yang tersimpan di HP (mungkin
				tidak terkini).
			</div>
		{/if}
	</div>

	<div class="grid grid-cols-2 gap-2 rounded-xl bg-slate-200 p-1">
		<button
			type="button"
			onclick={() => (activeTab = 'active')}
			class="rounded-lg py-2.5 text-xs font-bold {activeTab === 'active'
				? 'bg-white text-slate-900 shadow-2xs'
				: 'text-slate-600'}"
		>
			Aktif / Menunggu
		</button>
		<button
			type="button"
			onclick={() => (activeTab = 'history')}
			class="rounded-lg py-2.5 text-xs font-bold {activeTab === 'history'
				? 'bg-white text-slate-900 shadow-2xs'
				: 'text-slate-600'}"
		>
			Riwayat Selesai
		</button>
	</div>

	{#if loading}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			Memuat data peminjaman...
		</div>
	{:else if filteredLoans.length === 0}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			{activeTab === 'active'
				? 'Tidak ada peminjaman aktif saat ini.'
				: 'Belum ada riwayat peminjaman yang selesai.'}
		</div>
	{:else}
		<div class="space-y-3">
			{#each filteredLoans as loan (loan.id)}
				<div class="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
					<div class="flex items-center justify-between">
						<span class="rounded-full bg-slate-100 px-3 py-0.5 text-xs font-bold text-slate-800">
							{LoanStatusLabels[loan.status]}
						</span>
						{#if loan.isOverdue}
							<span class="rounded-full bg-red-100 px-3 py-0.5 text-xs font-bold text-red-800">
								TERLAMBAT
							</span>
						{/if}
					</div>

					<div class="text-xs text-slate-600 space-y-0.5">
						<div>
							Keperluan: <strong class="text-slate-900">{loan.purpose}</strong>
							{loan.purposeNote ? ` (${loan.purposeNote})` : ''}
						</div>
						<div>
							Dipinjam: {new Date(loan.createdAt).toLocaleString('id-ID')}
						</div>
						<div>
							Batas Kembali:
							<strong class={loan.isOverdue ? 'text-red-700' : 'text-slate-900'}>
								{new Date(loan.expectedReturnAt).toLocaleString('id-ID')}
							</strong>
						</div>
					</div>

					<div class="space-y-2 border-t border-slate-100 pt-2.5">
						{#each loan.items as item (item.id)}
							<div class="rounded-xl bg-slate-50 p-3 space-y-2">
								<div class="flex items-center justify-between gap-2">
									<div>
										<div class="font-mono text-xs font-bold text-slate-700">
											{item.asset.code}
										</div>
										<div class="text-sm font-bold text-slate-900">{item.asset.name}</div>
									</div>
									{#if !item.returnedAt && loan.status === 'ACTIVE'}
										<a
											href={`/m/assets/${encodeURIComponent(item.asset.code)}?mode=return`}
											class="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white"
										>
											Kembalikan
										</a>
									{/if}
								</div>

								{#if item.returnedAt}
									<div class="text-xs text-emerald-800">
										Sudah dikembalikan pada {new Date(item.returnedAt).toLocaleString('id-ID')} (Kondisi:
										{item.returnCondition})
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
