<script lang="ts">
	import { onMount } from 'svelte';
	import { AssetStatusLabels, type AssetStatusKey } from '$lib/shared/enums';

	interface ShiftItemReport {
		id: string;
		reason: string;
		responsible: { id: string; name: string; email: string } | null;
		loanItem: {
			id: string;
			returnedAt: string | null;
			asset: {
				id: string;
				code: string;
				name: string;
				status: AssetStatusKey;
			};
			loan: {
				id: string;
				purpose: string;
				expectedReturnAt: string;
				borrower: { id: string; name: string; email: string };
			};
		};
	}

	interface ShiftReport {
		id: string;
		status: 'OPEN' | 'CLOSED';
		openedAt: string;
		closedAt: string | null;
		note: string | null;
		user: { id: string; name: string; email: string; role: string };
		items: ShiftItemReport[];
	}

	interface UnconfirmedHandover {
		id: string;
		createdAt: string;
		giverConfirmedAt: string | null;
		receiverConfirmedAt: string | null;
		isOverdueConfirmation: boolean;
		giver: { name: string; email: string };
		receiver: { name: string; email: string };
		loan: {
			purpose: string;
			items: Array<{ asset: { code: string; name: string } }>;
		};
	}

	let shifts = $state<ShiftReport[]>([]);
	let unconfirmedHandovers = $state<UnconfirmedHandover[]>([]);
	let statusFilter = $state('');
	let loading = $state(true);
	let errorMsg = $state('');

	async function loadShiftReports() {
		loading = true;
		errorMsg = '';
		try {
			const params = new URLSearchParams({ pageSize: '50' });
			if (statusFilter) params.set('status', statusFilter);

			const [shiftRes, hoRes] = await Promise.all([
				fetch(`/api/v1/shifts?${params.toString()}`),
				fetch('/api/v1/handovers?unconfirmedOnly=true&pageSize=25')
			]);

			if (shiftRes.ok) {
				const data = await shiftRes.json();
				shifts = data.items ?? [];
			} else {
				const err = await shiftRes.json();
				errorMsg = err?.error?.message || 'Gagal memuat laporan shift.';
			}

			if (hoRes.ok) {
				const hoData = await hoRes.json();
				unconfirmedHandovers = hoData.items ?? [];
			}
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadShiftReports();
	});
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold text-slate-900">Laporan Shift Petugas & Serah Terima (M3)</h1>
			<p class="mt-1 text-sm text-slate-600">
				Tinjau riwayat tutup shift, daftar barang yang masih keluar saat pergantian shift beserta
				alasannya (BR-12), dan serah terima yang belum lengkap dikonfirmasi dua pihak (BR-21).
			</p>
		</div>
	</div>

	{#if errorMsg}
		<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
			{errorMsg}
		</div>
	{/if}

	<!-- SERAH TERIMA BELUM DIKONFIRMASI DUA PIHAK -->
	{#if unconfirmedHandovers.length > 0}
		<div class="rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-xs space-y-3">
			<h2 class="text-base font-bold text-amber-950">
				Serah Terima Belum Lengkap Dikonfirmasi Dua Pihak ({unconfirmedHandovers.length})
			</h2>
			<div class="divide-y divide-amber-200">
				{#each unconfirmedHandovers as ho (ho.id)}
					<div class="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
						<div>
							<span class="font-bold text-slate-900">
								{ho.loan.items.map((i) => `${i.asset.code} (${i.asset.name})`).join(', ')}
							</span>
							· Keperluan: {ho.loan.purpose}
							<div class="text-slate-700">
								Pemberi: <strong>{ho.giver.name}</strong> ({ho.giverConfirmedAt
									? '✓ Sudah'
									: 'Belum'}) → Penerima: <strong>{ho.receiver.name}</strong>
								({ho.receiverConfirmedAt ? '✓ Sudah' : 'Belum'})
							</div>
						</div>
						<div class="text-right">
							<div class="text-slate-600">
								Dibuat: {new Date(ho.createdAt).toLocaleString('id-ID')}
							</div>
							{#if ho.isOverdueConfirmation}
								<span class="inline-block rounded bg-red-100 px-2 py-0.5 font-bold text-red-800">
									Lewat 24 Jam
								</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- FILTER LAPORAN SHIFT -->
	<form
		onsubmit={(e) => {
			e.preventDefault();
			loadShiftReports();
		}}
		class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
	>
		<div>
			<label for="sh-status" class="block text-xs font-medium text-slate-600">Status Shift</label>
			<select
				id="sh-status"
				bind:value={statusFilter}
				class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			>
				<option value="">Semua Shift</option>
				<option value="OPEN">Sedang Terbuka (OPEN)</option>
				<option value="CLOSED">Sudah Ditutup (CLOSED)</option>
			</select>
		</div>
		<button
			type="submit"
			class="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
		>
			Filter Laporan
		</button>
	</form>

	<!-- DAFTAR LAPORAN SHIFT -->
	<div class="space-y-4">
		{#if loading}
			<p class="text-sm text-slate-500">Memuat laporan shift...</p>
		{:else if shifts.length === 0}
			<div
				class="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
			>
				Belum ada data shift yang tercatat.
			</div>
		{:else}
			{#each shifts as shift (shift.id)}
				<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
					<div
						class="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-3"
					>
						<div>
							<div class="flex items-center gap-2">
								<span class="font-bold text-slate-900">{shift.user.name}</span>
								<span class="text-xs text-slate-500">({shift.user.email})</span>
								<span
									class="rounded-full px-2.5 py-0.5 text-xs font-semibold {shift.status === 'OPEN'
										? 'bg-emerald-100 text-emerald-800'
										: 'bg-slate-100 text-slate-800'}"
								>
									{shift.status === 'OPEN' ? 'Masih Terbuka (OPEN)' : 'Ditutup (CLOSED)'}
								</span>
							</div>
							<div class="mt-1 text-xs text-slate-600">
								Dibuka: <strong>{new Date(shift.openedAt).toLocaleString('id-ID')}</strong>
								{#if shift.closedAt}
									· Ditutup: <strong>{new Date(shift.closedAt).toLocaleString('id-ID')}</strong>
								{/if}
								{#if shift.note}
									· Catatan: <em>"{shift.note}"</em>
								{/if}
							</div>
						</div>
						<div class="text-xs font-semibold text-slate-700">
							Barang Tertinggal: {shift.items.length}
						</div>
					</div>

					{#if shift.status === 'CLOSED' && shift.items.length === 0}
						<div class="text-xs font-medium text-emerald-700">
							✓ Shift ditutup bersih (tidak ada barang yang masih keluar saat shift ditutup).
						</div>
					{:else if shift.items.length > 0}
						<div class="overflow-x-auto">
							<table class="w-full text-left text-xs">
								<thead class="bg-slate-50 uppercase text-slate-500">
									<tr>
										<th class="px-3 py-2">Barang</th>
										<th class="px-3 py-2">Alasan Belum Kembali (BR-12)</th>
										<th class="px-3 py-2">Penanggung Jawab</th>
										<th class="px-3 py-2">Status Barang Saat Ini</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-slate-100">
									{#each shift.items as item (item.id)}
										<tr>
											<td class="px-3 py-2">
												<span class="font-mono font-bold text-slate-900">
													{item.loanItem.asset.code}
												</span>
												· {item.loanItem.asset.name}
											</td>
											<td class="px-3 py-2 font-medium text-slate-800">{item.reason}</td>
											<td class="px-3 py-2 text-slate-600">
												{item.responsible?.name || item.loanItem.loan.borrower.name}
											</td>
											<td class="px-3 py-2">
												<span class="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800">
													{AssetStatusLabels[item.loanItem.asset.status]}
												</span>
												<a
													href="/admin/assets"
													class="ml-2 text-blue-700 underline hover:text-blue-900"
												>
													Tindak Lanjut →
												</a>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
