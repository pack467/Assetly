<script lang="ts">
	import { onMount } from 'svelte';
	import { LoanStatusLabels, RiskLevelLabels } from '$lib/shared/enums';

	interface LoanEvidence {
		id: string;
		takenAtDevice: string;
		uploadedAtDevice?: string | null;
		receivedAtServer: string;
		clockSkewSec: number | null;
		rawClockSkewSec?: number | null;
		offlineDelaySec?: number | null;
		gpsAvailable: boolean;
		latitude: number | null;
		longitude: number | null;
		accuracyM: number | null;
		isMockLocation: boolean;
		distanceToLocationM: number | null;
		riskLevel: keyof typeof RiskLevelLabels;
		riskReasons: string[] | null;
		location: { id: string; name: string } | null;
	}

	interface LoanItemRecord {
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
		checkoutEvidence: LoanEvidence | null;
		returnEvidence: LoanEvidence | null;
	}

	interface LoanRecord {
		id: string;
		purpose: string;
		purposeNote: string | null;
		expectedReturnAt: string;
		status: keyof typeof LoanStatusLabels;
		isOverdue: boolean;
		createdAt: string;
		completedAt: string | null;
		rejectedReason: string | null;
		borrower: { id: string; name: string; email: string };
		items: LoanItemRecord[];
	}

	let loans = $state<LoanRecord[]>([]);
	let loading = $state(true);
	let statusFilter = $state('');
	let overdueOnly = $state(false);
	let errorMsg = $state('');
	let successMsg = $state('');

	function formatOfflineQueueDuration(sec: number | null | undefined): string {
		const s = Math.max(0, Math.round(sec ?? 0));
		if (s < 60) return `${s} detik`;
		const hours = Math.floor(s / 3600);
		const minutes = Math.floor((s % 3600) / 60);
		if (hours > 0) {
			return `${hours} jam ${minutes} menit (${s} detik)`;
		}
		return `${minutes} menit (${s} detik)`;
	}

	async function loadLoans() {
		loading = true;
		errorMsg = '';
		try {
			const params = new URLSearchParams({ pageSize: '50' });
			if (statusFilter) params.set('status', statusFilter);
			if (overdueOnly) params.set('overdueOnly', 'true');

			const res = await fetch(`/api/v1/loans?${params.toString()}`);
			const data = await res.json();
			if (res.ok) {
				loans = data.items ?? [];
			} else {
				errorMsg = data?.error?.message || 'Gagal memuat daftar peminjaman.';
			}
		} finally {
			loading = false;
		}
	}

	async function handleApprove(loanId: string) {
		errorMsg = '';
		successMsg = '';
		const res = await fetch(`/api/v1/loans/${loanId}/approve`, { method: 'POST' });
		const data = await res.json();
		if (!res.ok) {
			errorMsg = data?.error?.message || 'Gagal menyetujui peminjaman.';
			return;
		}
		successMsg = 'Peminjaman berhasil disetujui.';
		await loadLoans();
	}

	async function handleReject(loanId: string) {
		const reason = window.prompt('Masukkan alasan penolakan peminjaman (minimal 3 karakter):');
		if (!reason) return;
		errorMsg = '';
		successMsg = '';
		const res = await fetch(`/api/v1/loans/${loanId}/reject`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ reason })
		});
		const data = await res.json();
		if (!res.ok) {
			errorMsg = data?.error?.message || 'Gagal menolak peminjaman.';
			return;
		}
		successMsg = 'Peminjaman ditolak dan status barang dikembalikan ke Tersedia.';
		await loadLoans();
	}

	onMount(() => {
		loadLoans();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">
			Daftar Peminjaman, Persetujuan, & Bukti Risiko
		</h1>
		<p class="mt-1 text-sm text-slate-600">
			Tinjau peminjaman aktif, keterlambatan, foto bukti (melalui signed URL berumur pendek),
			selisih jam HP vs server, dan sinyal risiko GPS.
		</p>
	</div>

	{#if errorMsg}
		<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
			{errorMsg}
		</div>
	{/if}
	{#if successMsg}
		<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
			{successMsg}
		</div>
	{/if}

	<form
		onsubmit={(e) => {
			e.preventDefault();
			loadLoans();
		}}
		class="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
	>
		<div>
			<label for="ln-status" class="block text-xs font-medium text-slate-600">Status</label>
			<select
				id="ln-status"
				bind:value={statusFilter}
				class="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			>
				<option value="">Semua Status</option>
				{#each Object.entries(LoanStatusLabels) as [k, label] (k)}
					<option value={k}>{label}</option>
				{/each}
			</select>
		</div>
		<label class="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
			<input type="checkbox" bind:checked={overdueOnly} class="rounded border-slate-300" />
			<span>Hanya yang Terlambat</span>
		</label>
		<button
			type="submit"
			class="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
		>
			Terapkan Filter
		</button>
	</form>

	<div class="space-y-4">
		{#if loading}
			<p class="text-sm text-slate-500">Memuat data peminjaman...</p>
		{:else if loans.length === 0}
			<div
				class="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
			>
				Tidak ada data peminjaman yang sesuai filter.
			</div>
		{:else}
			{#each loans as loan (loan.id)}
				<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
					<div
						class="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-3"
					>
						<div>
							<div class="flex items-center gap-2">
								<span class="font-semibold text-slate-900">{loan.borrower.name}</span>
								<span class="text-xs text-slate-500">({loan.borrower.email})</span>
								<span
									class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800"
								>
									{LoanStatusLabels[loan.status]}
								</span>
								{#if loan.isOverdue}
									<span
										class="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-800"
									>
										TERLAMBAT
									</span>
								{/if}
							</div>
							<div class="mt-1 text-xs text-slate-600">
								Keperluan: <strong>{loan.purpose}</strong>
								{loan.purposeNote ? ` (${loan.purposeNote})` : ''} · Rencana kembali:
								<strong>{new Date(loan.expectedReturnAt).toLocaleString('id-ID')}</strong>
							</div>
						</div>

						{#if loan.status === 'PENDING_APPROVAL'}
							<div class="flex gap-2">
								<button
									type="button"
									onclick={() => handleApprove(loan.id)}
									class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
								>
									Setujui Peminjaman
								</button>
								<button
									type="button"
									onclick={() => handleReject(loan.id)}
									class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
								>
									Tolak
								</button>
							</div>
						{/if}
					</div>

					<div class="divide-y divide-slate-100">
						{#each loan.items as item (item.id)}
							<div class="py-3 grid grid-cols-1 gap-4 md:grid-cols-3 text-xs">
								<div>
									<div class="font-mono font-bold text-slate-900">
										{item.asset.code} — {item.asset.name}
									</div>
									<div class="mt-1 text-slate-600">
										Status:
										{item.returnedAt
											? `Dikembalikan (${new Date(item.returnedAt).toLocaleString('id-ID')}) - Kondisi: ${item.returnCondition}`
											: 'Masih Dipinjam'}
									</div>
									{#if item.damageNote}
										<div class="mt-1 text-red-700">Catatan kerusakan: {item.damageNote}</div>
									{/if}
								</div>

								<div>
									<div class="font-semibold text-slate-800">Bukti Saat Pinjam (CHECKOUT)</div>
									{#if item.checkoutEvidence}
										{@const ev = item.checkoutEvidence}
										<div class="mt-1 space-y-0.5 text-slate-600">
											<div>
												Risiko:
												<strong>{RiskLevelLabels[ev.riskLevel]}</strong>
												{#if ev.riskReasons && ev.riskReasons.length > 0}
													({ev.riskReasons.join(', ')})
												{/if}
											</div>
											{#if ev.riskReasons?.includes('OFFLINE_CAPTURE') || (ev.offlineDelaySec ?? 0) >= 60}
												<div
													class="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-900"
												>
													<strong>OFFLINE_CAPTURE:</strong> Foto diambil saat offline dan mengantre
													selama
													<strong>{formatOfflineQueueDuration(ev.offlineDelaySec)}</strong> sebelum terunggah.
												</div>
											{/if}
											<div>
												Selisih Jam Saat Unggah (Clock Skew): {ev.clockSkewSec ?? 0} detik · Selisih Mentah:
												{ev.rawClockSkewSec ?? ev.clockSkewSec ?? 0} detik
											</div>
											<div>
												Lokasi:
												{ev.location?.name ?? 'Koordinat GPS'}
												{#if ev.gpsAvailable && ev.latitude !== null && ev.longitude !== null}
													({ev.latitude.toFixed(5)}, {ev.longitude.toFixed(5)} ±{ev.accuracyM ??
														0}m)
												{:else}
													(GPS tidak tersedia)
												{/if}
											</div>
											{#if item.checkoutSignedUrl}
												<a
													href={item.checkoutSignedUrl}
													target="_blank"
													rel="noreferrer"
													class="inline-block text-blue-700 underline"
												>
													Lihat Foto Bukti Pinjam (Signed URL 5m)
												</a>
											{/if}
										</div>
									{/if}
								</div>

								<div>
									<div class="font-semibold text-slate-800">Bukti Saat Kembali (RETURN)</div>
									{#if item.returnEvidence}
										{@const rev = item.returnEvidence}
										<div class="mt-1 space-y-0.5 text-slate-600">
											<div>
												Risiko: <strong>{RiskLevelLabels[rev.riskLevel]}</strong>
												{#if rev.riskReasons && rev.riskReasons.length > 0}
													({rev.riskReasons.join(', ')})
												{/if}
											</div>
											{#if rev.riskReasons?.includes('OFFLINE_CAPTURE') || (rev.offlineDelaySec ?? 0) >= 60}
												<div
													class="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-900"
												>
													<strong>OFFLINE_CAPTURE:</strong> Diambil saat offline, mengantre
													<strong>{formatOfflineQueueDuration(rev.offlineDelaySec)}</strong>.
												</div>
											{/if}
											<div>
												Selisih Jam Saat Unggah: {rev.clockSkewSec ?? 0} detik · Mentah:
												{rev.rawClockSkewSec ?? rev.clockSkewSec ?? 0} detik
											</div>
											{#if item.returnSignedUrl}
												<a
													href={item.returnSignedUrl}
													target="_blank"
													rel="noreferrer"
													class="inline-block text-blue-700 underline"
												>
													Lihat Foto Bukti Kembali (Signed URL 5m)
												</a>
											{/if}
										</div>
									{:else}
										<div class="mt-1 text-slate-400">Belum dikembalikan</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
