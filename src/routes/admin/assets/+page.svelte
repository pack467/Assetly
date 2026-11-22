<script lang="ts">
	import { onMount } from 'svelte';
	import { AssetStatusLabels, type AssetStatusKey } from '$lib/shared/enums';

	interface CategoryOption {
		id: string;
		name: string;
		requiresApproval: boolean;
	}

	interface LocationOption {
		id: string;
		name: string;
	}

	interface AccessoryItem {
		id?: string;
		name: string;
		quantity: number;
	}

	interface AssetItem {
		id: string;
		code: string;
		qrToken: string;
		name: string;
		status: AssetStatusKey;
		serialNumber: string | null;
		purchasedAt: string | null;
		notes: string | null;
		version: number;
		category: CategoryOption;
		homeLocation: LocationOption | null;
		accessories: AccessoryItem[];
		currentHolder: string | null;
	}

	interface CsvPreviewRow {
		rowNumber: number;
		name: string;
		category: string;
		serialNumber: string | null;
		homeLocation: string | null;
		purchasedAt: string | null;
		notes: string | null;
		status: 'VALID' | 'DUPLICATE_SKIPPED' | 'ERROR';
		reason?: string;
	}

	interface CsvPreviewResult {
		mode: 'preview' | 'commit';
		totalRows: number;
		validCount: number;
		skippedDuplicateCount: number;
		failedCount: number;
		createdCount: number;
		previewRows: CsvPreviewRow[];
		errors: { rowNumber: number; reason: string; raw: string }[];
	}

	interface QrLabelData {
		asset: {
			id: string;
			code: string;
			name: string;
			qrToken: string;
			categoryName: string;
			locationName: string | null;
		};
		qrSvg: string;
	}

	let assets = $state<AssetItem[]>([]);
	let categories = $state<CategoryOption[]>([]);
	let locations = $state<LocationOption[]>([]);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');

	// Filter & pencarian manual
	let filterSearch = $state('');
	let filterStatus = $state('');
	let filterCategoryId = $state('');
	let filterLocationId = $state('');
	let page = $state(1);
	let totalPages = $state(1);
	let total = $state(0);

	// Form tambah/ubah barang
	let showAssetForm = $state(false);
	let editingAsset = $state<AssetItem | null>(null);
	let formName = $state('');
	let formCode = $state('');
	let formCategoryId = $state('');
	let formLocationId = $state('');
	let formSerial = $state('');
	let formPurchasedAt = $state('');
	let formNotes = $state('');
	let formAccessories = $state<AccessoryItem[]>([]);
	let submittingAsset = $state(false);

	// Modal status khusus (LOST / RETIRED / AVAILABLE)
	let statusTargetAsset = $state<AssetItem | null>(null);
	let nextSpecialStatus = $state<'AVAILABLE' | 'LOST' | 'RETIRED'>('LOST');
	let statusNote = $state('');

	// Panel Impor CSV
	let showImportPanel = $state(false);
	let csvText = $state('');
	let csvPreview = $state<CsvPreviewResult | null>(null);
	let importingCsv = $state(false);

	// Panel Cetak QR
	let qrLabel = $state<QrLabelData | null>(null);
	let rotateQrOnReprint = $state(false);

	async function loadMasterOptions() {
		const [catRes, locRes] = await Promise.all([
			fetch('/api/v1/categories'),
			fetch('/api/v1/locations')
		]);
		if (catRes.ok) {
			const d = await catRes.json();
			categories = d.items ?? [];
			if (!formCategoryId && categories.length > 0) {
				formCategoryId = categories[0].id;
			}
		}
		if (locRes.ok) {
			const d = await locRes.json();
			locations = d.items ?? [];
		}
	}

	async function loadAssets() {
		loading = true;
		try {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: '20'
			});
			if (filterSearch.trim()) params.set('search', filterSearch.trim());
			if (filterStatus) params.set('status', filterStatus);
			if (filterCategoryId) params.set('categoryId', filterCategoryId);
			if (filterLocationId) params.set('homeLocationId', filterLocationId);

			const res = await fetch(`/api/v1/assets?${params.toString()}`);
			const data = await res.json();
			if (res.ok) {
				assets = data.items ?? [];
				totalPages = data.pagination?.totalPages ?? 1;
				total = data.pagination?.total ?? 0;
			}
		} finally {
			loading = false;
		}
	}

	function openCreateForm() {
		editingAsset = null;
		formName = '';
		formCode = '';
		formCategoryId = categories[0]?.id ?? '';
		formLocationId = '';
		formSerial = '';
		formPurchasedAt = '';
		formNotes = '';
		formAccessories = [];
		showAssetForm = true;
		errorMsg = '';
		successMsg = '';
	}

	function openEditForm(item: AssetItem) {
		editingAsset = item;
		formName = item.name;
		formCode = item.code;
		formCategoryId = item.category.id;
		formLocationId = item.homeLocation?.id ?? '';
		formSerial = item.serialNumber ?? '';
		formPurchasedAt = item.purchasedAt ? item.purchasedAt.slice(0, 10) : '';
		formNotes = item.notes ?? '';
		formAccessories = item.accessories.map((a) => ({ name: a.name, quantity: a.quantity }));
		showAssetForm = true;
		errorMsg = '';
		successMsg = '';
	}

	function addAccessoryRow() {
		formAccessories = [...formAccessories, { name: '', quantity: 1 }];
	}

	function removeAccessoryRow(index: number) {
		formAccessories = formAccessories.filter((_, i) => i !== index);
	}

	async function handleSaveAsset(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		submittingAsset = true;

		const cleanAccessories = formAccessories
			.filter((a) => a.name.trim().length > 0)
			.map((a) => ({ name: a.name.trim(), quantity: Math.max(1, Number(a.quantity) || 1) }));

		try {
			if (!editingAsset) {
				const res = await fetch('/api/v1/assets', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: formName,
						...(formCode.trim() ? { code: formCode.trim() } : {}),
						categoryId: formCategoryId,
						homeLocationId: formLocationId || null,
						serialNumber: formSerial.trim() || null,
						purchasedAt: formPurchasedAt || null,
						notes: formNotes.trim() || null,
						accessories: cleanAccessories
					})
				});
				const data = await res.json();
				if (!res.ok) {
					errorMsg = data?.error?.message || 'Gagal menambah barang.';
					return;
				}
				successMsg = `Barang ${data.asset.code} (${data.asset.name}) berhasil dibuat.`;
			} else {
				const res = await fetch(`/api/v1/assets/${editingAsset.id}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: formName,
						categoryId: formCategoryId,
						homeLocationId: formLocationId || null,
						serialNumber: formSerial.trim() || null,
						purchasedAt: formPurchasedAt || null,
						notes: formNotes.trim() || null,
						accessories: cleanAccessories,
						version: editingAsset.version
					})
				});
				const data = await res.json();
				if (!res.ok) {
					errorMsg = data?.error?.message || 'Gagal mengubah barang.';
					return;
				}
				successMsg = `Barang ${data.asset.code} berhasil diperbarui.`;
			}
			showAssetForm = false;
			await loadAssets();
		} finally {
			submittingAsset = false;
		}
	}

	async function handleReprintQr(assetId: string, rotate = false) {
		errorMsg = '';
		const res = await fetch(`/api/v1/assets/${assetId}/qr/reprint`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				rotateToken: rotate,
				reason: rotate ? 'Rotasi & cetak ulang QR oleh Admin' : 'Cetak label QR di Web Admin'
			})
		});
		const data = await res.json();
		if (!res.ok) {
			errorMsg = data?.error?.message || 'Gagal menyiapkan label QR.';
			return;
		}
		qrLabel = data;
		rotateQrOnReprint = false;
		if (rotate) {
			await loadAssets();
		}
	}

	async function handleSpecialStatusSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!statusTargetAsset) return;
		errorMsg = '';
		successMsg = '';

		const res = await fetch(`/api/v1/assets/${statusTargetAsset.id}/status`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				status: nextSpecialStatus,
				note: statusNote
			})
		});
		const data = await res.json();
		if (!res.ok) {
			errorMsg = data?.error?.message || 'Gagal mengubah status barang.';
			return;
		}
		successMsg = `Status barang ${statusTargetAsset.code} diubah menjadi ${AssetStatusLabels[nextSpecialStatus]}.`;
		statusTargetAsset = null;
		statusNote = '';
		await loadAssets();
	}

	function handleCsvFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			csvText = String(reader.result ?? '');
			csvPreview = null;
		};
		reader.readAsText(file);
	}

	async function runCsvImport(mode: 'preview' | 'commit') {
		errorMsg = '';
		successMsg = '';
		importingCsv = true;
		try {
			const res = await fetch('/api/v1/assets/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ csvText, mode })
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = data?.error?.message || 'Gagal memproses CSV.';
				return;
			}
			csvPreview = data;
			if (mode === 'commit') {
				successMsg = `Impor selesai: ${data.createdCount} barang ditambahkan, ${data.skippedDuplicateCount} duplikat dilewati.`;
				await loadAssets();
			}
		} finally {
			importingCsv = false;
		}
	}

	onMount(async () => {
		await loadMasterOptions();
		await loadAssets();
	});
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-4 print:hidden">
		<div>
			<h1 class="text-2xl font-bold text-slate-900">Master Barang, Impor CSV, & Cetak QR</h1>
			<p class="mt-1 text-sm text-slate-600">
				Kode barang (`AST-xxxx`) dan `qrToken` acak dibuat otomatis (BR-23). Pencarian manual dan
				cetak ulang QR tercatat di Audit Log (BR-24).
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				onclick={() => {
					showImportPanel = !showImportPanel;
					csvPreview = null;
				}}
				class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100"
			>
				{showImportPanel ? 'Tutup Impor CSV' : 'Impor CSV'}
			</button>
			<button
				type="button"
				onclick={openCreateForm}
				class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
			>
				+ Tambah Barang
			</button>
		</div>
	</div>

	{#if errorMsg}
		<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 print:hidden">
			{errorMsg}
		</div>
	{/if}
	{#if successMsg}
		<div
			class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 print:hidden"
		>
			{successMsg}
		</div>
	{/if}

	<!-- PANEL CETAK LABEL QR -->
	{#if qrLabel}
		<div class="rounded-xl border border-slate-300 bg-white p-6 shadow-sm">
			<div class="mb-4 flex items-center justify-between print:hidden">
				<h2 class="text-base font-bold text-slate-900">
					Pratinjau Cetak Label QR ({qrLabel.asset.code})
				</h2>
				<div class="flex items-center gap-3">
					<label class="flex items-center gap-1.5 text-xs text-slate-700">
						<input
							type="checkbox"
							bind:checked={rotateQrOnReprint}
							class="rounded border-slate-300"
						/>
						<span>Ganti token QR baru (bila label lama hilang)</span>
					</label>
					{#if rotateQrOnReprint}
						<button
							type="button"
							onclick={() => qrLabel && handleReprintQr(qrLabel.asset.id, true)}
							class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
						>
							Putar Ulang Token QR
						</button>
					{/if}
					<button
						type="button"
						onclick={() => window.print()}
						class="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
					>
						Cetak Label
					</button>
					<button
						type="button"
						onclick={() => (qrLabel = null)}
						class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
					>
						Tutup
					</button>
				</div>
			</div>

			<div
				class="inline-flex items-center gap-4 rounded-lg border-2 border-dashed border-slate-400 p-4"
			>
				<div class="h-36 w-36 shrink-0">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html qrLabel.qrSvg}
				</div>
				<div class="space-y-1">
					<div class="text-xs font-semibold uppercase tracking-wider text-slate-500">
						Inventaris ITAM
					</div>
					<div class="font-mono text-xl font-bold text-slate-900">{qrLabel.asset.code}</div>
					<div class="text-sm font-medium text-slate-800">{qrLabel.asset.name}</div>
					<div class="text-xs text-slate-500">
						{qrLabel.asset.categoryName}
						{qrLabel.asset.locationName ? ` · ${qrLabel.asset.locationName}` : ''}
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- PANEL IMPOR CSV DENGAN PRATINJAU (Bagian 18) -->
	{#if showImportPanel}
		<div class="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs print:hidden">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h2 class="text-base font-semibold text-slate-900">
						Impor Daftar Barang dari CSV (Dengan Pratinjau & Idempotensi Nomor Seri)
					</h2>
					<p class="text-xs text-slate-600">
						Kolom minimal: <code>name,category,serialNumber,homeLocation,purchasedAt,notes</code>
					</p>
				</div>
				<a
					href="/api/v1/assets/import"
					download="templat-impor-barang-itam.csv"
					class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
				>
					Unduh Templat CSV
				</a>
			</div>

			<div>
				<label for="csv-file" class="block text-xs font-medium text-slate-700">
					Pilih Berkas CSV atau Tempel Isi CSV di Bawah
				</label>
				<input
					id="csv-file"
					type="file"
					accept=".csv,text/csv"
					onchange={handleCsvFileChange}
					class="mt-1 block text-xs text-slate-600"
				/>
				<textarea
					rows="5"
					bind:value={csvText}
					placeholder="name,category,serialNumber,homeLocation,purchasedAt,notes&#10;Laptop Dell 5420,Laptop,SN-001,Ruang Seminar A,2026-01-10,Lengkap"
					class="mt-2 w-full rounded-lg border border-slate-300 p-3 font-mono text-xs"
				></textarea>
			</div>

			<div class="flex gap-3">
				<button
					type="button"
					disabled={importingCsv || !csvText.trim()}
					onclick={() => runCsvImport('preview')}
					class="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{importingCsv ? 'Memproses...' : '1. Tampilkan Pratinjau'}
				</button>
				{#if csvPreview && csvPreview.validCount > 0 && csvPreview.mode === 'preview'}
					<button
						type="button"
						disabled={importingCsv}
						onclick={() => runCsvImport('commit')}
						class="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
					>
						2. Konfirmasi & Simpan ({csvPreview.validCount} Barang Valid)
					</button>
				{/if}
			</div>

			{#if csvPreview}
				<div class="space-y-3 border-t border-slate-200 pt-4">
					<div class="flex flex-wrap gap-4 text-xs">
						<span class="font-medium text-slate-700">Total Baris: {csvPreview.totalRows}</span>
						<span class="font-semibold text-emerald-700">Valid: {csvPreview.validCount}</span>
						<span class="font-semibold text-amber-700">
							Duplikat Nomor Seri (Dilewati): {csvPreview.skippedDuplicateCount}
						</span>
						<span class="font-semibold text-red-700">Gagal: {csvPreview.failedCount}</span>
					</div>

					<div class="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
						<table class="w-full text-left text-xs">
							<thead class="bg-slate-50 uppercase text-slate-500">
								<tr>
									<th class="px-3 py-2">Baris</th>
									<th class="px-3 py-2">Nama</th>
									<th class="px-3 py-2">Kategori</th>
									<th class="px-3 py-2">No. Seri</th>
									<th class="px-3 py-2">Lokasi</th>
									<th class="px-3 py-2">Status</th>
									<th class="px-3 py-2">Keterangan</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-slate-200">
								{#each csvPreview.previewRows as row (row.rowNumber)}
									<tr>
										<td class="px-3 py-2 font-mono">{row.rowNumber}</td>
										<td class="px-3 py-2 font-medium">{row.name}</td>
										<td class="px-3 py-2">{row.category}</td>
										<td class="px-3 py-2 font-mono">{row.serialNumber || '-'}</td>
										<td class="px-3 py-2">{row.homeLocation || '-'}</td>
										<td class="px-3 py-2">
											{#if row.status === 'VALID'}
												<span class="rounded bg-emerald-100 px-2 py-0.5 text-emerald-800">
													Siap Impor
												</span>
											{:else if row.status === 'DUPLICATE_SKIPPED'}
												<span class="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
													Duplikat (Skip)
												</span>
											{:else}
												<span class="rounded bg-red-100 px-2 py-0.5 text-red-800">Gagal</span>
											{/if}
										</td>
										<td class="px-3 py-2 text-slate-600">{row.reason || 'OK'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- FORM TAMBAH / UBAH BARANG -->
	{#if showAssetForm}
		<form
			onsubmit={handleSaveAsset}
			class="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs print:hidden"
		>
			<div class="flex items-center justify-between">
				<h2 class="text-base font-semibold text-slate-900">
					{editingAsset ? `Ubah Barang (${editingAsset.code})` : 'Tambah Barang Baru'}
				</h2>
				<button
					type="button"
					onclick={() => (showAssetForm = false)}
					class="text-xs text-slate-500 hover:text-slate-800"
				>
					Tutup
				</button>
			</div>

			<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
				<div>
					<label for="a-name" class="block text-xs font-medium text-slate-700">Nama Barang</label>
					<input
						id="a-name"
						type="text"
						required
						bind:value={formName}
						placeholder="Laptop Dell Latitude 5420"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					/>
				</div>
				<div>
					<label for="a-cat" class="block text-xs font-medium text-slate-700">Kategori</label>
					<select
						id="a-cat"
						required
						bind:value={formCategoryId}
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					>
						{#each categories as cat (cat.id)}
							<option value={cat.id}>{cat.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="a-loc" class="block text-xs font-medium text-slate-700">Lokasi Awal</label>
					<select
						id="a-loc"
						bind:value={formLocationId}
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					>
						<option value="">-- Tanpa Lokasi Awal --</option>
						{#each locations as loc (loc.id)}
							<option value={loc.id}>{loc.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="a-sn" class="block text-xs font-medium text-slate-700">
						Nomor Seri (Opsional)
					</label>
					<input
						id="a-sn"
						type="text"
						bind:value={formSerial}
						placeholder="SN-123456"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					/>
				</div>
				<div>
					<label for="a-date" class="block text-xs font-medium text-slate-700">
						Tanggal Beli (Opsional)
					</label>
					<input
						id="a-date"
						type="date"
						bind:value={formPurchasedAt}
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					/>
				</div>
				{#if !editingAsset}
					<div>
						<label for="a-code" class="block text-xs font-medium text-slate-700">
							Kode Manual (Kosongkan untuk otomatis AST-xxxx)
						</label>
						<input
							id="a-code"
							type="text"
							bind:value={formCode}
							placeholder="Otomatis: AST-0001"
							class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
						/>
					</div>
				{/if}
			</div>

			<div>
				<label for="a-notes" class="block text-xs font-medium text-slate-700">Catatan</label>
				<input
					id="a-notes"
					type="text"
					bind:value={formNotes}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>

			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<span class="text-xs font-medium text-slate-700">
						Kelengkapan Standar Barang (Charger, Kabel, Tas, dll.)
					</span>
					<button
						type="button"
						onclick={addAccessoryRow}
						class="text-xs font-medium text-slate-900 underline"
					>
						+ Tambah Kelengkapan
					</button>
				</div>
				{#each formAccessories as acc, idx (idx)}
					<div class="flex items-center gap-2">
						<input
							type="text"
							bind:value={acc.name}
							placeholder="Nama kelengkapan (mis. Charger 65W)"
							class="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
						/>
						<input
							type="number"
							min="1"
							bind:value={acc.quantity}
							class="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
						/>
						<button
							type="button"
							onclick={() => removeAccessoryRow(idx)}
							class="text-xs text-red-600 hover:underline"
						>
							Hapus
						</button>
					</div>
				{/each}
			</div>

			<div class="flex gap-2">
				<button
					type="submit"
					disabled={submittingAsset}
					class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{submittingAsset ? 'Menyimpan...' : editingAsset ? 'Simpan Perubahan' : 'Buat Barang'}
				</button>
				<button
					type="button"
					onclick={() => (showAssetForm = false)}
					class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
				>
					Batal
				</button>
			</div>
		</form>
	{/if}

	<!-- MODAL UBAH STATUS KHUSUS (BR-11) -->
	{#if statusTargetAsset}
		<form
			onsubmit={handleSpecialStatusSubmit}
			class="space-y-4 rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-xs print:hidden"
		>
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-bold text-amber-950">
					Ubah Status Khusus Barang: {statusTargetAsset.code} ({statusTargetAsset.name})
				</h3>
				<button
					type="button"
					onclick={() => (statusTargetAsset = null)}
					class="text-xs text-amber-900 underline"
				>
					Batal
				</button>
			</div>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="st-next" class="block text-xs font-medium text-amber-950">Status Baru</label>
					<select
						id="st-next"
						bind:value={nextSpecialStatus}
						class="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
					>
						<option value="LOST">Hilang (LOST)</option>
						<option value="RETIRED">Afkir / Tidak Layak Pakai (RETIRED)</option>
						<option value="AVAILABLE">Tersedia Kembali (AVAILABLE)</option>
					</select>
				</div>
				<div>
					<label for="st-note" class="block text-xs font-medium text-amber-950">
						Catatan Alasan (Wajib, tercatat di Audit Log)
					</label>
					<input
						id="st-note"
						type="text"
						required
						minlength="3"
						bind:value={statusNote}
						placeholder="Jelaskan hasil penelusuran atau keputusan..."
						class="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
					/>
				</div>
			</div>
			<button
				type="submit"
				class="rounded-lg bg-amber-900 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-950"
			>
				Simpan Status Baru
			</button>
		</form>
	{/if}

	<!-- FILTER & PENCARIAN MANUAL -->
	<form
		onsubmit={(e) => {
			e.preventDefault();
			page = 1;
			loadAssets();
		}}
		class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:grid-cols-5 print:hidden"
	>
		<div class="sm:col-span-2">
			<label for="f-search" class="block text-xs font-medium text-slate-600">
				Pencarian Manual (Kode AST-xxxx, Nama, Nomor Seri)
			</label>
			<input
				id="f-search"
				type="text"
				bind:value={filterSearch}
				placeholder="Ketik kode AST-0001, nomor seri, atau nama barang..."
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			/>
		</div>
		<div>
			<label for="f-status" class="block text-xs font-medium text-slate-600">Status</label>
			<select
				id="f-status"
				bind:value={filterStatus}
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			>
				<option value="">Semua Status</option>
				{#each Object.entries(AssetStatusLabels) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="f-cat" class="block text-xs font-medium text-slate-600">Kategori</label>
			<select
				id="f-cat"
				bind:value={filterCategoryId}
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			>
				<option value="">Semua Kategori</option>
				{#each categories as cat (cat.id)}
					<option value={cat.id}>{cat.name}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-end">
			<button
				type="submit"
				class="w-full rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
			>
				Cari ({total})
			</button>
		</div>
	</form>

	<!-- TABEL DAFTAR BARANG -->
	<div class="rounded-xl border border-slate-200 bg-white shadow-xs print:hidden">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
					<tr>
						<th class="px-4 py-3">Kode</th>
						<th class="px-4 py-3">Nama & No. Seri</th>
						<th class="px-4 py-3">Kategori & Lokasi</th>
						<th class="px-4 py-3">Status</th>
						<th class="px-4 py-3">Kelengkapan</th>
						<th class="px-4 py-3 text-right">Aksi</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-200">
					{#if loading}
						<tr>
							<td colspan="6" class="px-4 py-6 text-center text-slate-500">Memuat barang...</td>
						</tr>
					{:else if assets.length === 0}
						<tr>
							<td colspan="6" class="px-4 py-6 text-center text-slate-500">
								Belum ada data barang yang sesuai filter.
							</td>
						</tr>
					{:else}
						{#each assets as item (item.id)}
							<tr class="hover:bg-slate-50">
								<td class="px-4 py-3 font-mono font-bold text-slate-900">{item.code}</td>
								<td class="px-4 py-3">
									<div class="font-medium text-slate-900">{item.name}</div>
									{#if item.serialNumber}
										<div class="font-mono text-xs text-slate-500">SN: {item.serialNumber}</div>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs text-slate-600">
									<div class="font-medium text-slate-800">{item.category.name}</div>
									<div>{item.homeLocation?.name || '-'}</div>
								</td>
								<td class="px-4 py-3">
									<span
										class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800"
									>
										{AssetStatusLabels[item.status]}
									</span>
									{#if item.currentHolder}
										<div class="mt-1 text-xs text-slate-500">Oleh: {item.currentHolder}</div>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs text-slate-600">
									{#if item.accessories.length === 0}
										-
									{:else}
										{item.accessories.map((a) => `${a.name} (${a.quantity})`).join(', ')}
									{/if}
								</td>
								<td class="px-4 py-3 text-right space-x-2 whitespace-nowrap">
									<button
										type="button"
										onclick={() => handleReprintQr(item.id, false)}
										class="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
									>
										Cetak QR
									</button>
									<button
										type="button"
										onclick={() => openEditForm(item)}
										class="text-xs font-medium text-slate-900 underline"
									>
										Ubah
									</button>
									{#if item.status !== 'RETIRED'}
										<button
											type="button"
											onclick={() => {
												statusTargetAsset = item;
												nextSpecialStatus = item.status === 'LOST' ? 'AVAILABLE' : 'LOST';
												statusNote = '';
											}}
											class="text-xs font-medium text-amber-800 underline"
										>
											Status
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
		{#if totalPages > 1}
			<div class="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs">
				<span>Halaman {page} dari {totalPages}</span>
				<div class="flex gap-2">
					<button
						type="button"
						disabled={page <= 1}
						onclick={() => {
							page -= 1;
							loadAssets();
						}}
						class="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
					>
						Sebelumnya
					</button>
					<button
						type="button"
						disabled={page >= totalPages}
						onclick={() => {
							page += 1;
							loadAssets();
						}}
						class="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
					>
						Berikutnya
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>
