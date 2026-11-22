<script lang="ts">
	import { onMount } from 'svelte';

	interface AuditLogItem {
		id: string;
		action: string;
		entityType: string;
		entityId: string;
		before: unknown;
		after: unknown;
		ip: string | null;
		createdAt: string;
		actor: {
			id: string;
			name: string;
			email: string;
			role: string;
		} | null;
	}

	let logs = $state<AuditLogItem[]>([]);
	let loading = $state(true);
	let entityType = $state('');
	let action = $state('');
	let entityId = $state('');
	let page = $state(1);
	let totalPages = $state(1);
	let total = $state(0);

	async function loadLogs() {
		loading = true;
		try {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: '20'
			});
			if (entityType) params.set('entityType', entityType);
			if (action.trim()) params.set('action', action.trim());
			if (entityId.trim()) params.set('entityId', entityId.trim());

			const res = await fetch(`/api/v1/audit-logs?${params.toString()}`);
			const data = await res.json();
			if (res.ok) {
				logs = data.items ?? [];
				totalPages = data.pagination?.totalPages ?? 1;
				total = data.pagination?.total ?? 0;
			}
		} finally {
			loading = false;
		}
	}

	function handleFilter(e: SubmitEvent) {
		e.preventDefault();
		page = 1;
		loadLogs();
	}

	onMount(() => {
		loadLogs();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">Jejak Audit (Audit Log)</h1>
		<p class="mt-1 text-sm text-slate-600">
			Seluruh perubahan data bersifat transaksional dan append-only (dijaga oleh trigger PostgreSQL,
			BR-13).
		</p>
	</div>

	<form
		onsubmit={handleFilter}
		class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:grid-cols-4"
	>
		<div>
			<label for="al-type" class="block text-xs font-medium text-slate-600">Tipe Entitas</label>
			<select
				id="al-type"
				bind:value={entityType}
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			>
				<option value="">Semua Entitas</option>
				<option value="Asset">Asset</option>
				<option value="AssetImport">AssetImport</option>
				<option value="Category">Category</option>
				<option value="Location">Location</option>
				<option value="User">User</option>
				<option value="Session">Session</option>
				<option value="Loan">Loan</option>
			</select>
		</div>
		<div>
			<label for="al-action" class="block text-xs font-medium text-slate-600">Nama Aksi</label>
			<input
				id="al-action"
				type="text"
				bind:value={action}
				placeholder="Mis. ASSET_CREATED"
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			/>
		</div>
		<div>
			<label for="al-id" class="block text-xs font-medium text-slate-600">ID Entitas</label>
			<input
				id="al-id"
				type="text"
				bind:value={entityId}
				placeholder="UUID entitas"
				class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
			/>
		</div>
		<div class="flex items-end">
			<button
				type="submit"
				class="w-full rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
			>
				Filter Log ({total})
			</button>
		</div>
	</form>

	<div class="rounded-xl border border-slate-200 bg-white shadow-xs">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
					<tr>
						<th class="px-4 py-3">Waktu</th>
						<th class="px-4 py-3">Pelaku</th>
						<th class="px-4 py-3">Aksi</th>
						<th class="px-4 py-3">Entitas</th>
						<th class="px-4 py-3">Perubahan (Before / After)</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-200">
					{#if loading}
						<tr>
							<td colspan="5" class="px-4 py-6 text-center text-slate-500">Memuat audit log...</td>
						</tr>
					{:else if logs.length === 0}
						<tr>
							<td colspan="5" class="px-4 py-6 text-center text-slate-500">
								Tidak ada log ditemukan.
							</td>
						</tr>
					{:else}
						{#each logs as log (log.id)}
							<tr class="align-top hover:bg-slate-50">
								<td class="px-4 py-3 whitespace-nowrap text-xs text-slate-600">
									<div>{new Date(log.createdAt).toLocaleString('id-ID')}</div>
									{#if log.ip}
										<div class="font-mono text-slate-400">IP: {log.ip}</div>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs">
									{#if log.actor}
										<div class="font-medium text-slate-900">{log.actor.name}</div>
										<div class="text-slate-500">{log.actor.email}</div>
									{:else}
										<span class="text-slate-400">Sistem</span>
									{/if}
								</td>
								<td class="px-4 py-3">
									<span
										class="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-medium text-slate-800"
									>
										{log.action}
									</span>
								</td>
								<td class="px-4 py-3 text-xs">
									<div class="font-medium text-slate-800">{log.entityType}</div>
									<div class="font-mono text-slate-500">{log.entityId}</div>
								</td>
								<td class="px-4 py-3 font-mono text-xs text-slate-700">
									{#if log.before}
										<div class="text-slate-500">Before: {JSON.stringify(log.before)}</div>
									{/if}
									{#if log.after}
										<div class="text-slate-900">After: {JSON.stringify(log.after)}</div>
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
							loadLogs();
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
							loadLogs();
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
