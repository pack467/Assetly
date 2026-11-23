<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { RoleLabels } from '$lib/shared/enums';

	let { children } = $props();

	interface AuthUser {
		id: string;
		name: string;
		email: string;
		role: 'ADMIN' | 'OFFICER' | 'BORROWER';
		isActive: boolean;
	}

	let currentUser = $state<AuthUser | null>(null);
	let loadingAuth = $state(true);
	let email = $state('');
	let password = $state('');
	let totpCode = $state('');
	let loginError = $state('');
	let submitting = $state(false);

	async function checkSession() {
		loadingAuth = true;
		try {
			const res = await fetch('/api/v1/auth/me');
			if (res.ok) {
				const data = await res.json();
				currentUser = data.user;
			} else {
				currentUser = null;
			}
		} catch {
			currentUser = null;
		} finally {
			loadingAuth = false;
		}
	}

	async function handleLogin(e: SubmitEvent) {
		e.preventDefault();
		loginError = '';
		submitting = true;
		try {
			const res = await fetch('/api/v1/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email,
					password,
					...(totpCode.trim() ? { totpCode: totpCode.trim() } : {})
				})
			});
			const data = await res.json();
			if (!res.ok) {
				loginError = data?.error?.message || 'Gagal masuk.';
				return;
			}
			if (data.user?.role !== 'ADMIN') {
				loginError = 'Halaman Web Admin hanya untuk pengguna dengan peran ADMIN.';
				await fetch('/api/v1/auth/logout', { method: 'POST' });
				return;
			}
			currentUser = data.user;
			password = '';
			totpCode = '';
		} catch {
			loginError = 'Terjadi kesalahan jaringan.';
		} finally {
			submitting = false;
		}
	}

	async function handleLogout() {
		await fetch('/api/v1/auth/logout', { method: 'POST' });
		currentUser = null;
	}

	onMount(() => {
		checkSession();
	});

	const navItems = [
		{ href: '/admin', label: 'Dashboard' },
		{ href: '/admin/loans', label: 'Peminjaman' },
		{ href: '/admin/shifts', label: 'Laporan Shift' },
		{ href: '/admin/assets', label: 'Barang & QR' },
		{ href: '/admin/categories', label: 'Kategori' },
		{ href: '/admin/locations', label: 'Lokasi' },
		{ href: '/admin/users', label: 'User & Sesi' },
		{ href: '/admin/audit-logs', label: 'Audit Log' }
	];
</script>

{#if loadingAuth}
	<div class="flex min-h-screen items-center justify-center bg-slate-50 p-6">
		<p class="text-sm text-slate-600">Memeriksa sesi login...</p>
	</div>
{:else if !currentUser || currentUser.role !== 'ADMIN'}
	<div class="flex min-h-screen items-center justify-center bg-slate-100 p-4">
		<div class="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
			<h1 class="text-xl font-bold text-slate-900">Login Web Admin ITAM</h1>
			<p class="mt-1 text-sm text-slate-600">
				Masuk menggunakan akun Admin dan kode verifikasi dua langkah (TOTP).
			</p>

			{#if loginError}
				<div class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
					{loginError}
				</div>
			{/if}

			<form class="mt-5 space-y-4" onsubmit={handleLogin}>
				<div>
					<label for="admin-email" class="block text-sm font-medium text-slate-700">Email</label>
					<input
						id="admin-email"
						type="email"
						required
						bind:value={email}
						placeholder="admin@example.com"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
					/>
				</div>
				<div>
					<label for="admin-password" class="block text-sm font-medium text-slate-700">
						Password
					</label>
					<input
						id="admin-password"
						type="password"
						required
						bind:value={password}
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
					/>
				</div>
				<div>
					<label for="admin-totp" class="block text-sm font-medium text-slate-700">
						Kode TOTP 6 Angka (Wajib bila TOTP aktif)
					</label>
					<input
						id="admin-totp"
						type="text"
						inputmode="numeric"
						maxlength="6"
						bind:value={totpCode}
						placeholder="123456"
						class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-900 focus:outline-none"
					/>
				</div>
				<button
					type="submit"
					disabled={submitting}
					class="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Memproses...' : 'Masuk ke Web Admin'}
				</button>
			</form>
		</div>
	</div>
{:else}
	<div class="min-h-screen bg-slate-50">
		<header class="border-b border-slate-200 bg-white print:hidden">
			<div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3">
				<div class="flex items-center gap-6">
					<a href="/admin" class="text-lg font-bold text-slate-900">ITAM Admin</a>
					<nav class="flex flex-wrap gap-1">
						{#each navItems as item (item.href)}
							{@const active =
								item.href === '/admin'
									? page.url.pathname === '/admin'
									: page.url.pathname.startsWith(item.href)}
							<a
								href={item.href}
								class="rounded-lg px-3 py-1.5 text-sm font-medium {active
									? 'bg-slate-900 text-white'
									: 'text-slate-700 hover:bg-slate-100'}"
							>
								{item.label}
							</a>
						{/each}
					</nav>
				</div>
				<div class="flex items-center gap-3">
					<div class="text-right text-xs">
						<div class="font-semibold text-slate-900">{currentUser.name}</div>
						<div class="text-slate-500">
							{RoleLabels[currentUser.role]} · {currentUser.email}
						</div>
					</div>
					<button
						type="button"
						onclick={handleLogout}
						class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
					>
						Keluar
					</button>
				</div>
			</div>
		</header>

		<main class="mx-auto max-w-7xl px-6 py-6">
			{@render children()}
		</main>
	</div>
{/if}
