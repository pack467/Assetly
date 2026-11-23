<script lang="ts">
	import { onMount } from 'svelte';
	import { mobileApi } from '$lib/client/api';
	import { formatFriendlyErrorMessage } from '$lib/shared/mobile/watermark';

	interface OutstandingLoanItem {
		loanItemId: string;
		loanId: string;
		purpose: string;
		expectedReturnAt: string;
		isOverdue: boolean;
		defaultResponsibleUserId: string;
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
	}

	let currentShift = $state<ShiftRecord | null>(null);
	let outstandingItems = $state<OutstandingLoanItem[]>([]);
	let previousClosedShift = $state<ShiftRecord | null>(null);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');

	let openNote = $state('');
	let closeNote = $state('');
	let reasonsByLoanItemId = $state<Record<string, string>>({});
	let submitting = $state(false);

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
			outstandingItems = data.outstandingItems ?? [];
			previousClosedShift = data.previousClosedShift;

			const initialReasons: Record<string, string> = {};
			for (const item of outstandingItems) {
				initialReasons[item.loanItemId] = reasonsByLoanItemId[item.loanItemId] || '';
			}
			reasonsByLoanItemId = initialReasons;
		} catch {
			errorMsg = 'Gagal memuat status shift.';
		} finally {
			loading = false;
		}
	}

	async function handleOpenShift(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		submitting = true;
		try {
			const res = await mobileApi.post('/api/v1/shifts/open', {
				note: openNote.trim() || null
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = formatFriendlyErrorMessage(data, 'Gagal membuka shift.');
				return;
			}
			successMsg = 'Shift kerja berhasil dibuka.';
			openNote = '';
			await loadShiftState();
		} finally {
			submitting = false;
		}
	}

	async function handleCloseShift(e: SubmitEvent) {
		e.preventDefault();
		if (!currentShift) return;
		errorMsg = '';
		successMsg = '';

		// Validasi lokal awal agar pengguna tahu barang mana yang belum diisi alasannya
		for (const item of outstandingItems) {
			const r = (reasonsByLoanItemId[item.loanItemId] || '').trim();
			if (r.length < 3) {
				errorMsg = `Mohon isi alasan untuk barang ${item.asset.code} (${item.asset.name}) yang masih keluar (minimal 3 karakter, BR-12).`;
				return;
			}
		}

		submitting = true;
		try {
			const res = await mobileApi.post(`/api/v1/shifts/${currentShift.id}/close`, {
				note: closeNote.trim() || null,
				items: outstandingItems.map((item) => ({
					loanItemId: item.loanItemId,
					reason: (reasonsByLoanItemId[item.loanItemId] || '').trim(),
					responsibleUserId: item.defaultResponsibleUserId
				}))
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = formatFriendlyErrorMessage(data, 'Gagal menutup shift.');
				return;
			}
			successMsg =
				outstandingItems.length > 0
					? `Shift berhasil ditutup dengan mencatat ${outstandingItems.length} barang yang masih keluar.`
					: 'Shift berhasil ditutup dengan bersih (semua barang telah kembali).';
			closeNote = '';
			await loadShiftState();
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		loadShiftState();
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

	{#if errorMsg}
		<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
			{errorMsg}
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

				{#if outstandingItems.length === 0}
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
							<strong>{outstandingItems.length} barang</strong> yang masih keluar di database. Anda wajib
							mengisi alasan untuk setiap barang di bawah sebelum menutup shift.
						</div>

						{#each outstandingItems as item (item.loanItemId)}
							<div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
								<div class="flex items-start justify-between gap-2">
									<div>
										<div class="font-mono text-xs font-bold text-slate-700">
											{item.asset.code}
										</div>
										<div class="text-sm font-bold text-slate-900">{item.asset.name}</div>
									</div>
									{#if item.isOverdue}
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
									<label
										for={`reason-${item.loanItemId}`}
										class="block text-xs font-bold text-slate-800"
									>
										Alasan Barang Belum Kembali (Wajib - BR-12)
									</label>
									<input
										id={`reason-${item.loanItemId}`}
										type="text"
										required
										minlength="3"
										bind:value={reasonsByLoanItemId[item.loanItemId]}
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
