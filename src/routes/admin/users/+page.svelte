<script lang="ts">
	import { onMount } from 'svelte';
	import { RoleLabels } from '$lib/shared/enums';

	interface UserItem {
		id: string;
		name: string;
		email: string;
		role: 'ADMIN' | 'OFFICER' | 'BORROWER';
		isActive: boolean;
		hasTotp: boolean;
		activeSessionCount: number;
		createdAt: string;
	}

	interface SessionItem {
		id: string;
		deviceInfo: string | null;
		createdAt: string;
		expiresAt: string;
		revokedAt: string | null;
	}

	let users = $state<UserItem[]>([]);
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');
	let totpSetupInfo = $state<{ secret: string; uri: string; email: string } | null>(null);

	let editingId = $state<string | null>(null);
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let role = $state<'ADMIN' | 'OFFICER' | 'BORROWER'>('BORROWER');
	let isActive = $state(true);
	let regenerateTotp = $state(false);
	let submitting = $state(false);

	let selectedUserForSessions = $state<UserItem | null>(null);
	let sessions = $state<SessionItem[]>([]);
	let loadingSessions = $state(false);

	async function loadUsers() {
		loading = true;
		try {
			const res = await fetch('/api/v1/users?pageSize=100');
			const data = await res.json();
			if (res.ok) {
				users = data.items ?? [];
			}
		} finally {
			loading = false;
		}
	}

	function startEdit(u: UserItem) {
		editingId = u.id;
		name = u.name;
		email = u.email;
		password = '';
		role = u.role;
		isActive = u.isActive;
		regenerateTotp = false;
		errorMsg = '';
		successMsg = '';
	}

	function resetForm() {
		editingId = null;
		name = '';
		email = '';
		password = '';
		role = 'BORROWER';
		isActive = true;
		regenerateTotp = false;
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		totpSetupInfo = null;
		submitting = true;

		try {
			if (!editingId) {
				const res = await fetch('/api/v1/users', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name, email, password, role, isActive })
				});
				const data = await res.json();
				if (!res.ok) {
					errorMsg = data?.error?.message || 'Gagal membuat pengguna.';
					return;
				}
				successMsg = `Pengguna ${data.user.name} berhasil dibuat.`;
				if (data.totpSetup) {
					totpSetupInfo = { ...data.totpSetup, email: data.user.email };
				}
			} else {
				const res = await fetch(`/api/v1/users/${editingId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name,
						role,
						isActive,
						...(password.trim() ? { password } : {}),
						...(regenerateTotp ? { regenerateTotp: true } : {})
					})
				});
				const data = await res.json();
				if (!res.ok) {
					errorMsg = data?.error?.message || 'Gagal memperbarui pengguna.';
					return;
				}
				successMsg = `Pengguna ${data.user.name} berhasil diperbarui.`;
				if (data.totpSetup) {
					totpSetupInfo = { ...data.totpSetup, email: data.user.email };
				}
			}
			resetForm();
			await loadUsers();
		} finally {
			submitting = false;
		}
	}

	async function openSessions(u: UserItem) {
		selectedUserForSessions = u;
		loadingSessions = true;
		try {
			const res = await fetch(`/api/v1/users/${u.id}/sessions`);
			const data = await res.json();
			if (res.ok) {
				sessions = data.items ?? [];
			}
		} finally {
			loadingSessions = false;
		}
	}

	async function revokeSession(sessionId: string) {
		errorMsg = '';
		const res = await fetch(`/api/v1/admin/sessions/${sessionId}/revoke`, {
			method: 'POST'
		});
		const data = await res.json();
		if (!res.ok) {
			errorMsg = data?.error?.message || 'Gagal mencabut sesi.';
			return;
		}
		successMsg = 'Sesi login berhasil dicabut dan berlaku segera.';
		if (selectedUserForSessions) {
			await openSessions(selectedUserForSessions);
		}
		await loadUsers();
	}

	onMount(() => {
		loadUsers();
	});
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-slate-900">Kelola Pengguna, TOTP Admin, & Sesi</h1>
		<p class="mt-1 text-sm text-slate-600">
			Pengguna tidak boleh dinonaktifkan selama masih memegang barang aktif (BR-16). Akun Admin
			wajib TOTP (BR-19).
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

	{#if totpSetupInfo}
		<div class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
			<div class="font-bold">Kunci TOTP (2FA) untuk Admin ({totpSetupInfo.email})</div>
			<p class="mt-1 text-xs">
				Simpan secret ini di aplikasi autentikator (Google Authenticator / Authy). Secret hanya
				ditampilkan saat dibuat/direset:
			</p>
			<div class="mt-2 rounded bg-white p-2 font-mono text-xs select-all">
				Secret Base32: <strong>{totpSetupInfo.secret}</strong>
			</div>
			<div class="mt-1 rounded bg-white p-2 font-mono text-xs break-all select-all">
				URI: {totpSetupInfo.uri}
			</div>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<form
			onsubmit={handleSubmit}
			class="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
		>
			<h2 class="text-base font-semibold text-slate-900">
				{editingId ? 'Ubah Pengguna' : 'Buat Pengguna Baru'}
			</h2>
			<div>
				<label for="u-name" class="block text-sm font-medium text-slate-700">Nama Lengkap</label>
				<input
					id="u-name"
					type="text"
					required
					bind:value={name}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="u-email" class="block text-sm font-medium text-slate-700">Email</label>
				<input
					id="u-email"
					type="email"
					required
					disabled={Boolean(editingId)}
					bind:value={email}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
				/>
			</div>
			<div>
				<label for="u-pass" class="block text-sm font-medium text-slate-700">
					{editingId ? 'Password Baru (Kosongkan bila tidak diubah)' : 'Password (Min. 8 karakter)'}
				</label>
				<input
					id="u-pass"
					type="password"
					required={!editingId}
					minlength="8"
					bind:value={password}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label for="u-role" class="block text-sm font-medium text-slate-700">Peran (Role)</label>
				<select
					id="u-role"
					bind:value={role}
					class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
				>
					<option value="BORROWER">Peminjam (BORROWER)</option>
					<option value="OFFICER">Petugas (OFFICER)</option>
					<option value="ADMIN">Admin (ADMIN - Wajib TOTP)</option>
				</select>
			</div>
			<label class="flex items-center gap-2 text-sm text-slate-700">
				<input type="checkbox" bind:checked={isActive} class="rounded border-slate-300" />
				<span>Akun Aktif</span>
			</label>
			{#if editingId && role === 'ADMIN'}
				<label class="flex items-center gap-2 text-sm text-amber-800">
					<input type="checkbox" bind:checked={regenerateTotp} class="rounded border-amber-400" />
					<span>Putar ulang (reset) secret TOTP Admin</span>
				</label>
			{/if}
			<div class="flex gap-2">
				<button
					type="submit"
					disabled={submitting}
					class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Menyimpan...' : editingId ? 'Simpan Perubahan' : 'Tambah Pengguna'}
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

		<div class="space-y-6 lg:col-span-2">
			<div class="rounded-xl border border-slate-200 bg-white shadow-xs">
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
							<tr>
								<th class="px-4 py-3">Nama & Email</th>
								<th class="px-4 py-3">Peran</th>
								<th class="px-4 py-3">Status</th>
								<th class="px-4 py-3">TOTP</th>
								<th class="px-4 py-3">Sesi Aktif</th>
								<th class="px-4 py-3 text-right">Aksi</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-200">
							{#if loading}
								<tr>
									<td colspan="6" class="px-4 py-6 text-center text-slate-500">Memuat data...</td>
								</tr>
							{:else}
								{#each users as u (u.id)}
									<tr class="hover:bg-slate-50">
										<td class="px-4 py-3">
											<div class="font-medium text-slate-900">{u.name}</div>
											<div class="text-xs text-slate-500">{u.email}</div>
										</td>
										<td class="px-4 py-3 text-slate-700">{RoleLabels[u.role]}</td>
										<td class="px-4 py-3">
											{#if u.isActive}
												<span
													class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800"
												>
													Aktif
												</span>
											{:else}
												<span
													class="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800"
												>
													Nonaktif
												</span>
											{/if}
										</td>
										<td class="px-4 py-3 text-xs text-slate-600">
											{u.hasTotp ? 'Aktif' : '-'}
										</td>
										<td class="px-4 py-3 text-slate-700">{u.activeSessionCount}</td>
										<td class="px-4 py-3 text-right space-x-3">
											<button
												type="button"
												onclick={() => openSessions(u)}
												class="text-xs font-medium text-blue-700 underline hover:text-blue-900"
											>
												Sesi ({u.activeSessionCount})
											</button>
											<button
												type="button"
												onclick={() => startEdit(u)}
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

			{#if selectedUserForSessions}
				<div class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
					<div class="flex items-center justify-between">
						<h3 class="text-base font-semibold text-slate-900">
							Daftar Sesi Login: {selectedUserForSessions.name}
						</h3>
						<button
							type="button"
							onclick={() => (selectedUserForSessions = null)}
							class="text-xs text-slate-500 hover:text-slate-800"
						>
							Tutup
						</button>
					</div>
					{#if loadingSessions}
						<p class="mt-3 text-sm text-slate-500">Memuat sesi...</p>
					{:else if sessions.length === 0}
						<p class="mt-3 text-sm text-slate-500">Belum ada riwayat sesi.</p>
					{:else}
						<div class="mt-3 divide-y divide-slate-200">
							{#each sessions as s (s.id)}
								<div class="flex items-center justify-between py-2.5 text-xs">
									<div>
										<div class="font-medium text-slate-800">
											{s.deviceInfo || 'Perangkat tidak diketahui'}
										</div>
										<div class="text-slate-500">
											Dibuat: {new Date(s.createdAt).toLocaleString('id-ID')} · Kedaluwarsa:
											{new Date(s.expiresAt).toLocaleString('id-ID')}
										</div>
									</div>
									<div>
										{#if s.revokedAt}
											<span class="rounded bg-slate-100 px-2 py-1 text-slate-600">
												Dicabut ({new Date(s.revokedAt).toLocaleString('id-ID')})
											</span>
										{:else}
											<button
												type="button"
												onclick={() => revokeSession(s.id)}
												class="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700"
											>
												Cabut Sesi
											</button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>
