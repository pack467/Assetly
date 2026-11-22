<script lang="ts">
	import { onMount } from 'svelte';

	interface CategoryItem {
		id: string;
		name: string;
		requiresApproval: boolean;
		maintenanceIntervalDays: number | null;
		assetCount: number;
	}

	let categories = $state<CategoryItem[]>([]);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');

	let editingId = $state<string | null>(null);
	let name = $state('');
	let requiresApproval = $state(false);
	let maintenanceIntervalDays = $state<string>('');
	let submitting = $state(false);

	async function loadCategories() {
		loading = true;
		try {
			const res = await fetch('/api/v1/categories');
			const data = await res.json();
			if (res.ok) {
				categories = data.items ?? [];
			}
		} finally {
			loading = false;
		}
	}

	function startEdit(cat: CategoryItem) {
		editingId = cat.id;
		name = cat.name;
		requiresApproval = cat.requiresApproval;
		maintenanceIntervalDays =
			cat.maintenanceIntervalDays !== null ? String(cat.maintenanceIntervalDays) : '';
		errorMsg = '';
		successMsg = '';
	}

	function resetForm() {
		editingId = null;
		name = '';
		requiresApproval = false;
		maintenanceIntervalDays = '';
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		submitting = true;

		const intervalVal = maintenanceIntervalDays.trim()
			? parseInt(maintenanceIntervalDays.trim(), 10)
			: null;

		try {
			const url = editingId ? `/api/v1/categories/${editingId}` : '/api/v1/categories';
			const method = editingId ? 'PATCH' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name,
					requiresApproval,
					maintenanceIntervalDays: intervalVal
				})
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = data?.error?.message || 'Gagal menyimpan kategori.';
				return;
			}
			successMsg = editingId ? 'Kategori berhasil diperbarui.' : 'Kategori baru berhasil dibuat.';
			resetForm();
			await loadCategories();
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		loadCategories();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">Master Kategori Barang</h1>
		<p class="mt-1 text-sm text-slate-600">
			Atur apakah peminjaman barang pada kategori tertentu memerlukan persetujuan Admin (BR-08)
			serta interval servis berkala.
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
				{editingId ? 'Ubah Kategori' : 'Tambah Kategori Baru'}
			</h2>
			<div>
				<label for="cat-name" class="block text-sm font-medium text-slate-700">Nama Kategori</label>
				<input
					id="cat-name"
					type="text"
					required
					bind:value={name}
					placeholder="Mis. Laptop, Proyektor, Kamera"
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="cat-interval" class="block text-sm font-medium text-slate-700">
					Interval Servis Berkala (Hari, opsional)
				</label>
				<input
					id="cat-interval"
					type="number"
					min="1"
					max="3650"
					bind:value={maintenanceIntervalDays}
					placeholder="Mis. 180"
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<label class="flex items-center gap-2 text-sm text-slate-700">
				<input type="checkbox" bind:checked={requiresApproval} class="rounded border-slate-300" />
				<span>Wajib persetujuan Admin saat dipinjam (BR-08)</span>
			</label>
			<div class="flex gap-2">
				<button
					type="submit"
					disabled={submitting}
					class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Menyimpan...' : editingId ? 'Simpan Perubahan' : 'Tambah Kategori'}
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
							<th class="px-4 py-3">Nama Kategori</th>
							<th class="px-4 py-3">Persetujuan Admin</th>
							<th class="px-4 py-3">Servis Berkala</th>
							<th class="px-4 py-3">Jumlah Barang</th>
							<th class="px-4 py-3 text-right">Aksi</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-200">
						{#if loading}
							<tr>
								<td colspan="5" class="px-4 py-6 text-center text-slate-500">Memuat data...</td>
							</tr>
						{:else if categories.length === 0}
							<tr>
								<td colspan="5" class="px-4 py-6 text-center text-slate-500">
									Belum ada kategori.
								</td>
							</tr>
						{:else}
							{#each categories as cat (cat.id)}
								<tr class="hover:bg-slate-50">
									<td class="px-4 py-3 font-medium text-slate-900">{cat.name}</td>
									<td class="px-4 py-3">
										{#if cat.requiresApproval}
											<span
												class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800"
											>
												Ya (Wajib)
											</span>
										{:else}
											<span
												class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700"
											>
												Tidak
											</span>
										{/if}
									</td>
									<td class="px-4 py-3 text-slate-600">
										{cat.maintenanceIntervalDays ? `${cat.maintenanceIntervalDays} hari` : '-'}
									</td>
									<td class="px-4 py-3 text-slate-600">{cat.assetCount}</td>
									<td class="px-4 py-3 text-right">
										<button
											type="button"
											onclick={() => startEdit(cat)}
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
