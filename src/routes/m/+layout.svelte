<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { mobileApi, onMobileUnauthorized } from '$lib/client/api';
	import { getTokenStorage } from '$lib/client/tokenStorage';
	import { RoleLabels } from '$lib/shared/enums';
	import { formatFriendlyErrorMessage } from '$lib/shared/mobile/watermark';

	let { children } = $props();

	interface MobileUser {
		id: string;
		name: string;
		email: string;
		role: 'ADMIN' | 'OFFICER' | 'BORROWER';
		isActive: boolean;
	}

	let currentUser = $state<MobileUser | null>(null);
	let loadingAuth = $state(true);
	let email = $state('');
	let password = $state('');
	let totpCode = $state('');
	let showTotpField = $state(false);
	let loginError = $state('');
	let submitting = $state(false);
	let isOnline = $state(true);

	let unsubscribeUnauthorized: (() => void) | null = null;
	let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

	async function checkSession() {
		loadingAuth = true;
		try {
			const stored = await getTokenStorage().getTokens();
			if (!stored?.accessToken && !stored?.refreshToken) {
				currentUser = null;
				return;
			}
			const res = await mobileApi.get('/api/v1/auth/me');
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
			const res = await mobileApi.login({
				email: email.trim(),
				password,
				...(totpCode.trim() ? { totpCode: totpCode.trim() } : {})
			});
			const data = await res.json();
			if (!res.ok) {
				loginError = formatFriendlyErrorMessage(data, 'Email atau password belum sesuai.');
				if (
					String(data?.error?.message || '')
						.toLowerCase()
						.includes('totp')
				) {
					showTotpField = true;
				}
				return;
			}
			currentUser = data.user;
			password = '';
			totpCode = '';
		} catch {
			loginError = 'Tidak dapat terhubung ke server. Periksa koneksi HP Anda.';
		} finally {
			submitting = false;
		}
	}

	async function handleLogout() {
		await mobileApi.logout();
		currentUser = null;
	}

	onMount(() => {
		isOnline = navigator.onLine;
		const onOnline = () => (isOnline = true);
		const onOffline = () => (isOnline = false);
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);

		unsubscribeUnauthorized = onMobileUnauthorized(() => {
			currentUser = null;
			loginError = 'Sesi Anda telah berakhir. Silakan masuk kembali.';
			if (page.url.pathname !== '/m') {
				goto('/m').catch(() => {});
			}
		});

		// Perbarui access token secara proaktif tiap 12 menit agar sesi tidak habis di tengah pengisian form (TTL token 15 menit)
		keepAliveInterval = setInterval(
			() => {
				if (currentUser && navigator.onLine) {
					mobileApi.refreshSession().catch(() => {});
				}
			},
			12 * 60 * 1000
		);

		checkSession();

		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	});

	onDestroy(() => {
		if (unsubscribeUnauthorized) {
			unsubscribeUnauthorized();
			unsubscribeUnauthorized = null;
		}
		if (keepAliveInterval) {
			clearInterval(keepAliveInterval);
			keepAliveInterval = null;
		}
	});

	const tabs = [
		{ href: '/m', label: 'Beranda' },
		{ href: '/m/scan', label: 'Scan' },
		{ href: '/m/loans', label: 'Pinjaman' },
		{ href: '/m/handovers', label: 'Serah Terima' },
		{ href: '/m/shifts', label: 'Shift' }
	];
</script>

{#if loadingAuth}
	<div
		class="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center bg-slate-50 p-6"
	>
		<div class="text-base font-medium text-slate-700">Memuat Aplikasi Lapangan ITAM...</div>
	</div>
{:else if !currentUser}
	<div class="mx-auto flex min-h-screen max-w-md flex-col justify-center bg-slate-100 p-5">
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
			<div class="text-xs font-bold uppercase tracking-wider text-slate-500">Aplikasi Lapangan</div>
			<h1 class="mt-1 text-2xl font-bold text-slate-900">Masuk ke ITAM</h1>
			<p class="mt-1 text-sm text-slate-600">
				Gunakan akun Peminjam atau Petugas untuk melakukan scan QR, peminjaman, dan pengembalian
				barang.
			</p>

			{#if loginError}
				<div
					class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm font-medium text-red-700"
				>
					{loginError}
				</div>
			{/if}

			<form class="mt-5 space-y-4" onsubmit={handleLogin}>
				<div>
					<label for="m-email" class="block text-sm font-semibold text-slate-800">Email</label>
					<input
						id="m-email"
						type="email"
						required
						autocomplete="email"
						bind:value={email}
						placeholder="nama@itam.local"
						class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base focus:border-slate-900 focus:outline-none"
					/>
				</div>

				<div>
					<label for="m-pass" class="block text-sm font-semibold text-slate-800">Password</label>
					<input
						id="m-pass"
						type="password"
						required
						autocomplete="current-password"
						bind:value={password}
						placeholder="Masukkan password"
						class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base focus:border-slate-900 focus:outline-none"
					/>
				</div>

				{#if showTotpField}
					<div>
						<label for="m-totp" class="block text-sm font-semibold text-slate-800">
							Kode TOTP 6 Angka (Khusus Admin)
						</label>
						<input
							id="m-totp"
							type="text"
							inputmode="numeric"
							maxlength="6"
							bind:value={totpCode}
							placeholder="123456"
							class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3.5 font-mono text-base focus:border-slate-900 focus:outline-none"
						/>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => (showTotpField = true)}
						class="text-xs font-medium text-slate-500 underline"
					>
						Masuk sebagai Admin dengan kode TOTP?
					</button>
				{/if}

				<button
					type="submit"
					disabled={submitting}
					class="mt-2 w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-bold text-white shadow-xs active:bg-slate-800 disabled:opacity-50"
				>
					{submitting ? 'Sedang Masuk...' : 'Masuk Sekarang'}
				</button>
			</form>
		</div>
	</div>
{:else}
	<div class="mx-auto flex min-h-screen max-w-md flex-col bg-slate-100 pb-24">
		<!-- HEADER KOMPAK -->
		<header class="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3 shadow-2xs">
			<div class="flex items-center justify-between gap-2">
				<div>
					<div class="flex items-center gap-2">
						<span class="text-base font-bold text-slate-900">ITAM Lapangan</span>
						<span
							class="rounded-full px-2 py-0.5 text-[11px] font-semibold {isOnline
								? 'bg-emerald-100 text-emerald-800'
								: 'bg-amber-100 text-amber-800'}"
						>
							{isOnline ? 'Online' : 'Offline'}
						</span>
					</div>
					<div class="text-xs text-slate-600">
						{currentUser.name} · <span class="font-medium">{RoleLabels[currentUser.role]}</span>
					</div>
				</div>
				<button
					type="button"
					onclick={handleLogout}
					class="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 active:bg-slate-100"
				>
					Keluar
				</button>
			</div>
		</header>

		<!-- KONTEN UTAMA -->
		<main class="flex-1 p-4">
			{@render children()}
		</main>

		<!-- NAVIGASI BAWAH SATU TANGAN (IBU JARI) -->
		<nav
			class="fixed right-0 bottom-0 left-0 z-30 mx-auto max-w-md border-t border-slate-200 bg-white px-1.5 py-2 shadow-lg"
		>
			<div class="grid grid-cols-5 gap-1">
				{#each tabs as tab (tab.href)}
					{@const active =
						tab.href === '/m' ? page.url.pathname === '/m' : page.url.pathname.startsWith(tab.href)}
					<a
						href={tab.href}
						class="flex flex-col items-center justify-center rounded-xl py-2.5 text-center text-[11px] font-bold transition-colors {active
							? 'bg-slate-900 text-white'
							: 'text-slate-600 active:bg-slate-100'}"
					>
						<span>{tab.label}</span>
					</a>
				{/each}
			</div>
		</nav>
	</div>
{/if}
