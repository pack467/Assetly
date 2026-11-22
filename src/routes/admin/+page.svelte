<script lang="ts">
	import { onMount } from 'svelte';
	import { AssetStatusLabels, type AssetStatusKey } from '$lib/shared/enums';

	let totalAssets = $state(0);
	let statusCounts = $state<Record<string, number>>({});
	let categoryCount = $state(0);
	let locationCount = $state(0);
	let userCount = $state(0);
	let loading = $state(true);

	async function loadOverview() {
		loading = true;
		try {
			const [assetsRes, catRes, locRes, userRes] = await Promise.all([
				fetch('/api/v1/assets?pageSize=100'),
				fetch('/api/v1/categories'),
				fetch('/api/v1/locations'),
				fetch('/api/v1/users?pageSize=1')
			]);

			if (assetsRes.ok) {
				const data = await assetsRes.json();
				totalAssets = data.pagination?.total ?? 0;
				const counts: Record<string, number> = {};
				for (const item of data.items ?? []) {
					counts[item.status] = (counts[item.status] ?? 0) + 1;
				}
				statusCounts = counts;
			}
			if (catRes.ok) {
				const data = await catRes.json();
				categoryCount = data.items?.length ?? 0;
			}
			if (locRes.ok) {
				const data = await locRes.json();
				locationCount = data.items?.length ?? 0;
			}
			if (userRes.ok) {
				const data = await userRes.json();
				userCount = data.pagination?.total ?? 0;
			}
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadOverview();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">Dashboard Master Data</h1>
		<p class="mt-1 text-sm text-slate-600">
			Ringkasan inventaris barang IT, kategori, lokasi resmi, pengguna, dan jejak audit (M1).
		</p>
	</div>

	{#if loading}
		<p class="text-sm text-slate-500">Memuat ringkasan...</p>
	{:else}
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<a
				href="/admin/assets"
				class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs hover:border-slate-300"
			>
				<div class="text-xs font-medium uppercase text-slate-500">Total Barang</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">{totalAssets}</div>
				<div class="mt-2 text-xs text-slate-600">Kelola barang, impor CSV & cetak QR →</div>
			</a>
			<a
				href="/admin/categories"
				class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs hover:border-slate-300"
			>
				<div class="text-xs font-medium uppercase text-slate-500">Kategori Barang</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">{categoryCount}</div>
				<div class="mt-2 text-xs text-slate-600">Atur persetujuan & interval servis →</div>
			</a>
			<a
				href="/admin/locations"
				class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs hover:border-slate-300"
			>
				<div class="text-xs font-medium uppercase text-slate-500">Lokasi Resmi</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">{locationCount}</div>
				<div class="mt-2 text-xs text-slate-600">Titik koordinat & radius GPS →</div>
			</a>
			<a
				href="/admin/users"
				class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs hover:border-slate-300"
			>
				<div class="text-xs font-medium uppercase text-slate-500">Pengguna Terdaftar</div>
				<div class="mt-2 text-3xl font-bold text-slate-900">{userCount}</div>
				<div class="mt-2 text-xs text-slate-600">Kelola peran, TOTP & cabut sesi →</div>
			</a>
		</div>

		<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
			<h2 class="text-base font-semibold text-slate-900">Sebaran Status Barang</h2>
			<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
				{#each Object.entries(AssetStatusLabels) as [statusKey, label] (statusKey)}
					<div class="rounded-lg border border-slate-100 bg-slate-50 p-3">
						<div class="text-xs text-slate-500">{label}</div>
						<div class="mt-1 text-xl font-bold text-slate-900">
							{statusCounts[statusKey as AssetStatusKey] ?? 0}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
