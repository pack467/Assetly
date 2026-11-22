<script lang="ts">
	import { onMount } from 'svelte';
	import {
		AssetStatusLabels,
		LoanStatusLabels,
		RiskLevelLabels,
		type AssetStatusKey
	} from '$lib/shared/enums';

	interface DashboardSummary {
		totalAssets: number;
		assetsByStatus: Record<string, number>;
		loans: {
			activeLoansCount: number;
			activeLoanItemsCount: number;
			overdueLoanItemsCount: number;
			pendingApprovalsCount: number;
			unconfirmedHandoversCount: number;
			riskReviewCount: number;
		};
		recentLoans: Array<{
			id: string;
			status: keyof typeof LoanStatusLabels;
			purpose: string;
			expectedReturnAt: string;
			createdAt: string;
			isOverdue: boolean;
			borrower: {
				id: string;
				name: string;
				email: string;
			};
			items: Array<{
				id: string;
				returnedAt: string | null;
				asset: {
					id: string;
					code: string;
					name: string;
					status: AssetStatusKey;
				};
				riskLevel: keyof typeof RiskLevelLabels;
				riskReasons: string[];
			}>;
		}>;
	}

	let summary = $state<DashboardSummary | null>(null);
	let loading = $state(true);
	let errorMsg = $state('');

	async function loadSummary() {
		loading = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/v1/dashboard/summary');
			const data = await res.json();
			if (!res.ok) {
				errorMsg = data?.error?.message || 'Gagal memuat ringkasan dashboard.';
				return;
			}
			summary = data;
		} catch {
			errorMsg = 'Gagal menghubungi server.';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadSummary();
	});
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold text-slate-900">Dashboard Peminjaman & Inventaris</h1>
			<p class="mt-1 text-sm text-slate-600">
				Pantauan status barang, peminjaman aktif, keterlambatan, persetujuan, dan sinyal risiko
				bukti (Bagian 8.2).
			</p>
		</div>
		<button
			type="button"
			onclick={loadSummary}
			class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
		>
			Muat Ulang
		</button>
	</div>

	{#if errorMsg}
		<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
			{errorMsg}
		</div>
	{/if}

	{#if loading || !summary}
		<p class="text-sm text-slate-500">Memuat ringkasan dashboard...</p>
	{:else}
		<!-- KARTU RINGKASAN PEMINJAMAN & RISIKO -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
			<a
				href="/admin/loans?status=ACTIVE"
				class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs hover:border-slate-300"
			>
				<div class="text-xs font-medium uppercase text-slate-500">Peminjaman Aktif</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">
					{summary.loans.activeLoansCount}
				</div>
				<div class="mt-1 text-xs text-slate-600">
					{summary.loans.activeLoanItemsCount} unit barang sedang keluar
				</div>
			</a>

			<a
				href="/admin/loans?overdueOnly=true"
				class="rounded-xl border border-red-200 bg-white p-5 shadow-xs hover:border-red-300"
			>
				<div class="text-xs font-medium uppercase text-red-600">Barang Terlambat</div>
				<div class="mt-2 text-3xl font-bold text-red-700">
					{summary.loans.overdueLoanItemsCount}
				</div>
				<div class="mt-1 text-xs text-slate-600">Melewati jadwal pengembalian</div>
			</a>

			<a
				href="/admin/loans?status=PENDING_APPROVAL"
				class="rounded-xl border border-amber-200 bg-white p-5 shadow-xs hover:border-amber-300"
			>
				<div class="text-xs font-medium uppercase text-amber-700">Menunggu Persetujuan</div>
				<div class="mt-2 text-3xl font-bold text-amber-800">
					{summary.loans.pendingApprovalsCount}
				</div>
				<div class="mt-1 text-xs text-slate-600">Kategori barang butuh izin Admin</div>
			</a>

			<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
				<div class="text-xs font-medium uppercase text-slate-500">Serah Terima Tertunda</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">
					{summary.loans.unconfirmedHandoversCount}
				</div>
				<div class="mt-1 text-xs text-slate-600">Belum dikonfirmasi dua pihak</div>
			</div>

			<a
				href="/admin/loans"
				class="rounded-xl border border-purple-200 bg-white p-5 shadow-xs hover:border-purple-300"
			>
				<div class="text-xs font-medium uppercase text-purple-700">Risiko Bukti GPS/Jam</div>
				<div class="mt-2 text-3xl font-bold text-purple-800">
					{summary.loans.riskReviewCount}
				</div>
				<div class="mt-1 text-xs text-slate-600">Perlu dicek / Mencurigakan</div>
			</a>
		</div>

		<!-- SEBARAN STATUS BARANG -->
		<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
			<div class="flex items-center justify-between">
				<h2 class="text-base font-semibold text-slate-900">
					Sebaran Status Barang (Total: {summary.totalAssets})
				</h2>
				<a href="/admin/assets" class="text-xs font-medium text-slate-900 underline">
					Kelola Barang →
				</a>
			</div>
			<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
				{#each Object.entries(AssetStatusLabels) as [statusKey, label] (statusKey)}
					<div class="rounded-lg border border-slate-100 bg-slate-50 p-3">
						<div class="text-xs text-slate-500">{label}</div>
						<div class="mt-1 text-xl font-bold text-slate-900">
							{summary.assetsByStatus[statusKey as AssetStatusKey] ?? 0}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- DAFTAR PEMINJAMAN AKTIF / MENUNGGU PERSETUJUAN TERBARU -->
		<div class="rounded-xl border border-slate-200 bg-white shadow-xs">
			<div class="flex items-center justify-between border-b border-slate-200 px-5 py-4">
				<h2 class="text-base font-semibold text-slate-900">
					Peminjaman Aktif & Menunggu Persetujuan Terbaru
				</h2>
				<a href="/admin/loans" class="text-xs font-medium text-slate-900 underline">
					Lihat Semua Peminjaman →
				</a>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
						<tr>
							<th class="px-4 py-3">Peminjam</th>
							<th class="px-4 py-3">Barang</th>
							<th class="px-4 py-3">Keperluan</th>
							<th class="px-4 py-3">Batas Kembali</th>
							<th class="px-4 py-3">Status</th>
							<th class="px-4 py-3">Risiko Bukti</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-200">
						{#if summary.recentLoans.length === 0}
							<tr>
								<td colspan="6" class="px-4 py-6 text-center text-slate-500">
									Belum ada peminjaman aktif atau menunggu persetujuan.
								</td>
							</tr>
						{:else}
							{#each summary.recentLoans as loan (loan.id)}
								<tr class="hover:bg-slate-50">
									<td class="px-4 py-3">
										<div class="font-medium text-slate-900">{loan.borrower.name}</div>
										<div class="text-xs text-slate-500">{loan.borrower.email}</div>
									</td>
									<td class="px-4 py-3 text-xs">
										{#each loan.items as item (item.id)}
											<div>
												<span class="font-mono font-semibold text-slate-900">
													{item.asset.code}
												</span>
												· {item.asset.name}
											</div>
										{/each}
									</td>
									<td class="px-4 py-3 text-slate-700">{loan.purpose}</td>
									<td class="px-4 py-3 text-xs">
										<div class={loan.isOverdue ? 'font-bold text-red-700' : 'text-slate-700'}>
											{new Date(loan.expectedReturnAt).toLocaleString('id-ID')}
										</div>
										{#if loan.isOverdue}
											<span
												class="mt-0.5 inline-block rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800"
											>
												TERLAMBAT
											</span>
										{/if}
									</td>
									<td class="px-4 py-3">
										<span
											class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800"
										>
											{LoanStatusLabels[loan.status]}
										</span>
									</td>
									<td class="px-4 py-3 text-xs">
										{#each loan.items as item (item.id)}
											<div>
												{#if item.riskLevel === 'SUSPICIOUS'}
													<span class="rounded bg-red-100 px-2 py-0.5 font-semibold text-red-800">
														{RiskLevelLabels[item.riskLevel]}
													</span>
												{:else if item.riskLevel === 'NEEDS_REVIEW'}
													<span
														class="rounded bg-amber-100 px-2 py-0.5 font-semibold text-amber-800"
													>
														{RiskLevelLabels[item.riskLevel]}
													</span>
												{:else}
													<span class="rounded bg-emerald-100 px-2 py-0.5 text-emerald-800">
														{RiskLevelLabels[item.riskLevel]}
													</span>
												{/if}
											</div>
										{/each}
									</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
