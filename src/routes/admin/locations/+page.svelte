<script lang="ts">
	import { onMount } from 'svelte';

	interface LocationItem {
		id: string;
		name: string;
		latitude: number | null;
		longitude: number | null;
		radiusM: number;
		isActive: boolean;
		assetCount: number;
	}

	let locations = $state<LocationItem[]>([]);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');

	let editingId = $state<string | null>(null);
	let name = $state('');
	let latitude = $state('');
	let longitude = $state('');
	let radiusM = $state('100');
	let isActive = $state(true);
	let submitting = $state(false);

	async function loadLocations() {
		loading = true;
		try {
			const res = await fetch('/api/v1/locations');
			const data = await res.json();
			if (res.ok) {
				locations = data.items ?? [];
			}
		} finally {
			loading = false;
		}
	}

	function startEdit(loc: LocationItem) {
		editingId = loc.id;
		name = loc.name;
		latitude = loc.latitude !== null ? String(loc.latitude) : '';
		longitude = loc.longitude !== null ? String(loc.longitude) : '';
		radiusM = String(loc.radiusM);
		isActive = loc.isActive;
		errorMsg = '';
		successMsg = '';
	}

	function resetForm() {
		editingId = null;
		name = '';
		latitude = '';
		longitude = '';
		radiusM = '100';
		isActive = true;
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		submitting = true;

		const latVal = latitude.trim() ? parseFloat(latitude.trim()) : null;
		const lngVal = longitude.trim() ? parseFloat(longitude.trim()) : null;
		const radVal = parseInt(radiusM, 10) || 100;

		try {
			const url = editingId ? `/api/v1/locations/${editingId}` : '/api/v1/locations';
			const method = editingId ? 'PATCH' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name,
					latitude: latVal,
					longitude: lngVal,
					radiusM: radVal,
					isActive
				})
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = data?.error?.message || 'Gagal menyimpan lokasi.';
				return;
			}
			successMsg = editingId ? 'Lokasi berhasil diperbarui.' : 'Lokasi baru berhasil dibuat.';
			resetForm();
			await loadLocations();
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		loadLocations();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">Master Lokasi Resmi</h1>
		<p class="mt-1 text-sm text-slate-600">
			Titik lokasi resmi (kantor, ruang seminar, gudang) untuk pilihan lokasi manual dan perhitungan
			jarak GPS.
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

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<form
			onsubmit={handleSubmit}
			class="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
		>
			<h2 class="text-base font-semibold text-slate-900">
				{editingId ? 'Ubah Lokasi' : 'Tambah Lokasi Baru'}
			</h2>
			<div>
				<label for="loc-name" class="block text-sm font-medium text-slate-700">Nama Lokasi</label>
				<input
					id="loc-name"
					type="text"
					required
					bind:value={name}
					placeholder="Mis. Ruang Seminar A"
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label for="loc-lat" class="block text-sm font-medium text-slate-700">
						Latitude (-90..90)
					</label>
					<input
						id="loc-lat"
						type="number"
						step="any"
						min="-90"
						max="90"
						bind:value={latitude}
						placeholder="-6.2000"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					/>
				</div>
				<div>
					<label for="loc-lng" class="block text-sm font-medium text-slate-700">
						Longitude (-180..180)
					</label>
					<input
						id="loc-lng"
						type="number"
						step="any"
						min="-180"
						max="180"
						bind:value={longitude}
						placeholder="106.8166"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					/>
				</div>
			</div>
			<div>
				<label for="loc-radius" class="block text-sm font-medium text-slate-700">
					Radius Toleransi (Meter)
				</label>
				<input
					id="loc-radius"
					type="number"
					min="5"
					max="10000"
					required
					bind:value={radiusM}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<label class="flex items-center gap-2 text-sm text-slate-700">
				<input type="checkbox" bind:checked={isActive} class="rounded border-slate-300" />
				<span>Lokasi Aktif</span>
			</label>
			<div class="flex gap-2">
				<button
					type="submit"
					disabled={submitting}
					class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Menyimpan...' : editingId ? 'Simpan Perubahan' : 'Tambah Lokasi'}
				</button>
				{#if editingId}
					<button
						type="button"
						onclick={resetForm}
						class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
					>
						Batal
					</button>
				{/if}
			</div>
		</form>

		<div class="rounded-xl border border-slate-200 bg-white shadow-xs lg:col-span-2">
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
						<tr>
							<th class="px-4 py-3">Nama Lokasi</th>
							<th class="px-4 py-3">Koordinat</th>
							<th class="px-4 py-3">Radius</th>
							<th class="px-4 py-3">Status</th>
							<th class="px-4 py-3">Barang</th>
							<th class="px-4 py-3 text-right">Aksi</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-200">
						{#if loading}
							<tr>
								<td colspan="6" class="px-4 py-6 text-center text-slate-500">Memuat data...</td>
							</tr>
						{:else if locations.length === 0}
							<tr>
								<td colspan="6" class="px-4 py-6 text-center text-slate-500">Belum ada lokasi.</td>
							</tr>
						{:else}
							{#each locations as loc (loc.id)}
								<tr class="hover:bg-slate-50">
									<td class="px-4 py-3 font-medium text-slate-900">{loc.name}</td>
									<td class="px-4 py-3 font-mono text-xs text-slate-600">
										{loc.latitude !== null && loc.longitude !== null
											? `${loc.latitude}, ${loc.longitude}`
											: 'Belum diatur'}
									</td>
									<td class="px-4 py-3 text-slate-600">{loc.radiusM} m</td>
									<td class="px-4 py-3">
										{#if loc.isActive}
											<span
												class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800"
											>
												Aktif
											</span>
										{:else}
											<span
												class="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700"
											>
												Nonaktif
											</span>
										{/if}
									</td>
									<td class="px-4 py-3 text-slate-600">{loc.assetCount}</td>
									<td class="px-4 py-3 text-right">
										<button
											type="button"
											onclick={() => startEdit(loc)}
											class="text-xs font-medium text-slate-900 underline hover:text-slate-700"
										>
											Ubah
										</button>
									</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		</div>
	</div>
</div>
