<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { mobileApi, onMobileUnauthorized } from '$lib/client/api';
	import {
		clearAllMobileSessionCaches,
		computeOfflineQueueSummary,
		subscribeOfflineQueue,
		type OfflineQueueSummary
	} from '$lib/client/offlineQueue';
	import { attemptMobileLogout, syncPendingOperations } from '$lib/client/syncManager';
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
	let showLogoutPendingConfirm = $state(false);
	let pendingLogoutCount = $state(0);
	let queueSummary = $state<OfflineQueueSummary>({
		pendingCount: 0,
		syncingCount: 0,
		conflictCount: 0,
		rejectedCount: 0,
		acceptedCount: 0,
		totalCount: 0
	});

	let unsubscribeUnauthorized: (() => void) | null = null;
	let unsubscribeQueue: (() => void) | null = null;
	let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
	let backgroundSyncInterval: ReturnType<typeof setInterval> | null = null;

	async function refreshQueueSummary() {
		queueSummary = await computeOfflineQueueSummary(undefined, currentUser?.id);
	}

	async function checkSession() {
		loadingAuth = true;
		try {
			const resolved = await mobileApi.resolveSessionUser();
			currentUser = resolved.user;
			await refreshQueueSummary();
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
			await refreshQueueSummary();
		} catch {
			loginError = 'Tidak dapat terhubung ke server. Periksa koneksi HP Anda.';
		} finally {
			submitting = false;
		}
	}

	async function handleLogout() {
		const res = await attemptMobileLogout({
			confirmWithPending: false,
			userId: currentUser?.id
		});
		if (res.requiresConfirmation) {
			pendingLogoutCount = res.pendingCount;
			showLogoutPendingConfirm = true;
			return;
		}
		showLogoutPendingConfirm = false;
		currentUser = null;
		await refreshQueueSummary();
	}

	async function confirmForceLogout() {
		await attemptMobileLogout({
			confirmWithPending: true,
			userId: currentUser?.id
		});
		showLogoutPendingConfirm = false;
		currentUser = null;
		await refreshQueueSummary();
	}

	onMount(() => {
		isOnline = navigator.onLine;
		const onOnline = () => {
			isOnline = true;
			// Verifikasi ulang sesi ke server saat sinyal kembali, lalu jalankan sinkronisasi antrean
			mobileApi
				.resolveSessionUser()
				.then((resolved) => {
					currentUser = resolved.user;
					if (currentUser) {
						syncPendingOperations().catch(() => {});
					}
				})
				.catch(() => {});
		};
		const onOffline = () => (isOnline = false);
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);

		unsubscribeQueue = subscribeOfflineQueue(() => {
			refreshQueueSummary();
		});
		refreshQueueSummary();

		unsubscribeUnauthorized = onMobileUnauthorized(() => {
			getTokenStorage()
				.clearCachedProfile?.()
				.catch(() => {});
			clearAllMobileSessionCaches();
			showLogoutPendingConfirm = false;
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

		// Jalankan pengecekan retry antrean offline secara berkala tiap 10 detik saat online
		backgroundSyncInterval = setInterval(() => {
			if (currentUser && navigator.onLine && queueSummary.pendingCount > 0) {
				syncPendingOperations().catch(() => {});
			}
		}, 10_000);

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
		if (unsubscribeQueue) {
			unsubscribeQueue();
			unsubscribeQueue = null;
		}
		if (keepAliveInterval) {
			clearInterval(keepAliveInterval);
			keepAliveInterval = null;
		}
		if (backgroundSyncInterval) {
			clearInterval(backgroundSyncInterval);
			backgroundSyncInterval = null;
		}
	});

	const tabs = [
		{ href: '/m', label: 'Beranda' },
		{ href: '/m/scan', label: 'Scan' },
		{ href: '/m/loans', label: 'Pinjaman' },
		{ href: '/m/handovers', label: 'Serah' },
		{ href: '/m/shifts', label: 'Shift' },
		{ href: '/m/sync', label: 'Sinkron' }
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
						{#if queueSummary.conflictCount + queueSummary.rejectedCount > 0}
							<a
								href="/m/sync"
								class="rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white"
							>
								{queueSummary.conflictCount + queueSummary.rejectedCount} Konflik!
							</a>
						{:else if queueSummary.pendingCount + queueSummary.syncingCount > 0}
							<a
								href="/m/sync"
								class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900"
							>
								{queueSummary.pendingCount + queueSummary.syncingCount} Antre
							</a>
						{/if}
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

			{#if showLogoutPendingConfirm}
				<div
					class="mt-3 space-y-2.5 rounded-xl border-2 border-amber-400 bg-amber-50 p-3.5 text-xs text-amber-950"
				>
					<div class="font-extrabold uppercase tracking-wider text-amber-900">
						⚠ Konfirmasi Keluar — Ada {pendingLogoutCount} Operasi Belum Tersinkron
					</div>
					<p class="leading-relaxed text-amber-900">
						Anda masih memiliki <strong>{pendingLogoutCount} operasi offline (PENDING)</strong> yang
						belum terkirim ke server. Operasi Anda tetap tersimpan aman di HP dan
						<strong>tidak akan dikirim oleh akun lain</strong>, namun baru dapat disinkronkan saat
						Anda masuk kembali ke akun ini.
					</p>
					<div class="flex flex-col gap-2 pt-1">
						<a
							href="/m/sync"
							onclick={() => (showLogoutPendingConfirm = false)}
							class="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-center text-xs font-bold text-white"
						>
							Batal & Buka Layar Sinkronisasi (/m/sync)
						</a>
						<div class="flex gap-2">
							<button
								type="button"
								onclick={confirmForceLogout}
								class="flex-1 rounded-xl bg-red-700 px-3 py-2.5 text-xs font-bold text-white active:bg-red-800"
							>
								Ya, Tetap Keluar Sekarang
							</button>
							<button
								type="button"
								onclick={() => (showLogoutPendingConfirm = false)}
								class="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 active:bg-slate-100"
							>
								Tutup
							</button>
						</div>
					</div>
				</div>
			{/if}
		</header>

		<!-- KONTEN UTAMA -->
		<main class="flex-1 p-4">
			{@render children()}
		</main>

		<!-- NAVIGASI BAWAH SATU TANGAN (IBU JARI) -->
		<nav
			class="fixed right-0 bottom-0 left-0 z-30 mx-auto max-w-md border-t border-slate-200 bg-white px-1.5 py-2 shadow-lg"
		>
			<div class="grid grid-cols-6 gap-1">
				{#each tabs as tab (tab.href)}
					{@const active =
						tab.href === '/m' ? page.url.pathname === '/m' : page.url.pathname.startsWith(tab.href)}
					{@const badgeCount =
						tab.href === '/m/sync'
							? queueSummary.pendingCount +
								queueSummary.syncingCount +
								queueSummary.conflictCount +
								queueSummary.rejectedCount
							: 0}
					{@const hasConflict =
						tab.href === '/m/sync' && queueSummary.conflictCount + queueSummary.rejectedCount > 0}
					<a
						href={tab.href}
						class="relative flex flex-col items-center justify-center rounded-xl py-2.5 text-center text-[11px] font-bold transition-colors {active
							? 'bg-slate-900 text-white'
							: 'text-slate-600 active:bg-slate-100'}"
					>
						<span>{tab.label}</span>
						{#if badgeCount > 0}
							<span
								class="absolute -top-1 right-1 rounded-full px-1.5 py-0.2 text-[9px] font-extrabold text-white {hasConflict
									? 'bg-red-600'
									: 'bg-amber-600'}"
							>
								{badgeCount}
							</span>
						{/if}
					</a>
				{/each}
			</div>
		</nav>
	</div>
{/if}
