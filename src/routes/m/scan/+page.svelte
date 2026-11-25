<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { mobileApi } from '$lib/client/api';
	import {
		findCachedAssetByCodeOrQr,
		getCachedAssetsList,
		saveCachedAssetsList,
		type CachedAssetSummary
	} from '$lib/client/offlineQueue';
	import { AssetStatusLabels, type AssetStatusKey } from '$lib/shared/enums';
	import { formatFriendlyErrorMessage } from '$lib/shared/mobile/watermark';

	interface QuickAsset extends CachedAssetSummary {
		status: AssetStatusKey;
	}

	let manualCode = $state('');
	let errorMsg = $state('');
	let searching = $state(false);
	let isUsingOfflineCache = $state(false);

	let videoEl = $state<HTMLVideoElement | null>(null);
	let cameraActive = $state(false);
	let cameraError = $state('');
	let stream: MediaStream | null = null;
	let scanTimer: ReturnType<typeof setInterval> | null = null;

	let quickAssets = $state<QuickAsset[]>([]);
	let loadingAssets = $state(true);

	async function loadQuickAssets() {
		loadingAssets = true;
		try {
			const res = await mobileApi.get('/api/v1/assets?pageSize=50');
			if (res.ok) {
				const data = await res.json();
				const items = (data.items ?? []) as QuickAsset[];
				quickAssets = items;
				isUsingOfflineCache = false;
				saveCachedAssetsList(items);
				return;
			}
			const cached = getCachedAssetsList() as QuickAsset[];
			if (cached.length > 0) {
				quickAssets = cached;
				isUsingOfflineCache = true;
			}
		} catch {
			const cached = getCachedAssetsList() as QuickAsset[];
			quickAssets = cached;
			isUsingOfflineCache = cached.length > 0;
		} finally {
			loadingAssets = false;
		}
	}

	async function startQrCamera() {
		cameraError = '';
		errorMsg = '';
		if (!navigator.mediaDevices?.getUserMedia) {
			cameraError =
				'Kamera tidak dapat diakses di browser ini. Pastikan membuka lewat http://localhost:5173/m (USB Port Forwarding) dan izinkan akses kamera.';
			return;
		}

		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: { ideal: 'environment' },
					width: { ideal: 1280 },
					height: { ideal: 720 }
				},
				audio: false
			});
			cameraActive = true;

			setTimeout(() => {
				if (videoEl && stream) {
					videoEl.srcObject = stream;
					videoEl.play().catch(() => {});
				}
			}, 50);

			// Gunakan BarcodeDetector native Chrome Android bila tersedia
			const WinWithBarcode = window as unknown as {
				BarcodeDetector?: new (opts: { formats: string[] }) => {
					detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
				};
			};

			if (WinWithBarcode.BarcodeDetector) {
				const detector = new WinWithBarcode.BarcodeDetector({ formats: ['qr_code'] });
				scanTimer = setInterval(async () => {
					if (!videoEl || videoEl.readyState < 2 || searching) return;
					try {
						const barcodes = await detector.detect(videoEl);
						const raw = barcodes[0]?.rawValue?.trim();
						if (raw) {
							await resolveScannedValue(raw);
						}
					} catch {
						// abaikan frame gagal
					}
				}, 450);
			}
		} catch {
			cameraError =
				'Izin kamera belum diberikan atau kamera sedang dipakai aplikasi lain. Anda tetap bisa memasukkan kode barang secara manual di bawah.';
		}
	}

	function stopQrCamera() {
		if (scanTimer) {
			clearInterval(scanTimer);
			scanTimer = null;
		}
		if (stream) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
			stream = null;
		}
		cameraActive = false;
	}

	async function resolveScannedValue(rawValue: string) {
		if (searching) return;
		searching = true;
		errorMsg = '';
		try {
			// 1. Coba cari sebagai qrToken terlebih dahulu
			const resQr = await mobileApi.get(`/api/v1/assets/by-qr/${encodeURIComponent(rawValue)}`);
			if (resQr.ok) {
				const data = await resQr.json();
				stopQrCamera();
				await goto(`/m/assets/${encodeURIComponent(data.asset.code)}`);
				return;
			}

			// 2. Jalur cadangan: cari sebagai kode barang (mis. AST-0001) atau nomor seri
			const resCode = await mobileApi.get(`/api/v1/assets/by-code/${encodeURIComponent(rawValue)}`);
			const dataCode = await resCode.json();
			if (resCode.ok) {
				stopQrCamera();
				await goto(`/m/assets/${encodeURIComponent(dataCode.asset.code)}`);
				return;
			}

			errorMsg = formatFriendlyErrorMessage(
				dataCode,
				`Barang dengan kode atau QR "${rawValue}" tidak ditemukan.`
			);
		} catch {
			// Bagian 10.2 (#3): Saat offline, cari dari cache barang lokal (kode, qrToken, atau nomor seri)
			const cached = findCachedAssetByCodeOrQr(rawValue);
			if (cached) {
				isUsingOfflineCache = true;
				stopQrCamera();
				await goto(`/m/assets/${encodeURIComponent(cached.asset.code)}`);
				return;
			}
			errorMsg = `HP sedang offline dan barang dengan kode/QR "${rawValue}" belum tersimpan di cache lokal HP.`;
		} finally {
			searching = false;
		}
	}

	async function handleManualSearch(e: SubmitEvent) {
		e.preventDefault();
		const q = manualCode.trim();
		if (!q) return;
		await resolveScannedValue(q);
	}

	onMount(() => {
		loadQuickAssets();
	});

	onDestroy(() => {
		stopQrCamera();
	});
</script>

<div class="space-y-5">
	<div>
		<h1 class="text-xl font-bold text-slate-900">Scan QR atau Cari Kode Barang</h1>
		<p class="mt-1 text-xs text-slate-600">
			Arahkan kamera ke stiker QR barang, atau ketik kode barang bila label QR rusak (BR-24).
		</p>
	</div>

	{#if errorMsg}
		<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
			{errorMsg}
		</div>
	{/if}

	<!-- PANEL KAMERA PEMBACA QR -->
	<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
		<div class="flex items-center justify-between">
			<span class="text-sm font-bold text-slate-900">Kamera Pemindai QR</span>
			{#if cameraActive}
				<button
					type="button"
					onclick={stopQrCamera}
					class="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700"
				>
					Matikan Kamera
				</button>
			{/if}
		</div>

		{#if cameraError}
			<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
				{cameraError}
			</div>
		{/if}

		{#if cameraActive}
			<div class="relative overflow-hidden rounded-xl bg-black">
				<video bind:this={videoEl} autoplay playsinline muted class="aspect-4/3 w-full object-cover"
				></video>
				<div
					class="pointer-events-none absolute inset-6 rounded-2xl border-2 border-dashed border-emerald-400/80"
				></div>
			</div>
			<p class="text-center text-xs text-slate-500">
				Arahkan kotak ke QR barang. Sistem akan membaca secara otomatis.
			</p>
		{:else}
			<button
				type="button"
				onclick={startQrCamera}
				class="w-full rounded-xl bg-slate-900 px-4 py-4 text-sm font-bold text-white active:bg-slate-800"
			>
				Buka Kamera Pemindai QR
			</button>
		{/if}
	</div>

	<!-- INPUT KODE MANUAL (BR-24) -->
	<form
		onsubmit={handleManualSearch}
		class="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs"
	>
		<label for="manual-code" class="block text-sm font-bold text-slate-900">
			Input Kode Barang / Nomor Seri Manual
		</label>
		<div class="flex gap-2">
			<input
				id="manual-code"
				type="text"
				bind:value={manualCode}
				placeholder="Mis. AST-0001"
				class="flex-1 rounded-xl border border-slate-300 px-4 py-3.5 font-mono text-base uppercase focus:border-slate-900 focus:outline-none"
			/>
			<button
				type="submit"
				disabled={searching || !manualCode.trim()}
				class="rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-bold text-white active:bg-slate-800 disabled:opacity-50"
			>
				{searching ? '...' : 'Cari'}
			</button>
		</div>
	</form>

	<!-- DAFTAR CEPAT BARANG TERDAFTAR -->
	<div class="space-y-2.5">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="text-xs font-bold uppercase tracking-wider text-slate-500">
				Pilih Cepat dari Daftar Barang
			</div>
			{#if isUsingOfflineCache}
				<span
					class="rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900"
				>
					Cache Offline — Status mungkin tidak terkini
				</span>
			{/if}
		</div>
		{#if isUsingOfflineCache}
			<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
				<strong>Mode Offline:</strong> Menampilkan salinan daftar barang terakhir di HP (status mungkin
				tidak terkini). Keputusan akhir tetap divalidasi oleh server saat sinkronisasi.
			</div>
		{/if}
		{#if loadingAssets}
			<div
				class="rounded-2xl border border-slate-200 bg-white p-4 text-center text-xs text-slate-500"
			>
				Memuat daftar barang...
			</div>
		{:else if quickAssets.length === 0}
			<div
				class="rounded-2xl border border-slate-200 bg-white p-4 text-center text-xs text-slate-500"
			>
				Belum ada barang terdaftar.
			</div>
		{:else}
			{#each quickAssets as item (item.id)}
				<a
					href={`/m/assets/${encodeURIComponent(item.code)}`}
					class="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs active:bg-slate-50"
				>
					<div>
						<div class="font-mono text-xs font-bold text-slate-700">{item.code}</div>
						<div class="text-sm font-bold text-slate-900">{item.name}</div>
						{#if item.serialNumber}
							<div class="text-xs text-slate-500">SN: {item.serialNumber}</div>
						{/if}
					</div>
					<span
						class="rounded-full px-3 py-1 text-xs font-bold {item.status === 'AVAILABLE'
							? 'bg-emerald-100 text-emerald-800'
							: item.status === 'BORROWED'
								? 'bg-blue-100 text-blue-800'
								: 'bg-slate-100 text-slate-700'}"
					>
						{AssetStatusLabels[item.status]}
					</span>
				</a>
			{/each}
		{/if}
	</div>
</div>
