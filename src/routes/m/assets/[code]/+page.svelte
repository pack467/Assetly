<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { mobileApi } from '$lib/client/api';
	import { AssetStatusLabels, type AssetStatusKey } from '$lib/shared/enums';
	import {
		computeCompressedDimensions,
		DEFAULT_JPEG_QUALITY,
		drawWatermarkToContext,
		findNearestLocation,
		formatFriendlyErrorMessage,
		formatWatermarkLines,
		type LocationCandidate
	} from '$lib/shared/mobile/watermark';

	interface AssetScanPayload {
		asset: {
			id: string;
			code: string;
			name: string;
			status: AssetStatusKey;
			serialNumber: string | null;
			notes: string | null;
			category: {
				id: string;
				name: string;
				requiresApproval: boolean;
			};
			homeLocation: {
				id: string;
				name: string;
			} | null;
			accessories: Array<{ id: string; name: string; quantity: number }>;
		};
		allowedActions: string[];
		currentHolder: string | null;
		requiresApproval: boolean;
		activeLoanItem: {
			id: string;
			loanId: string;
			borrowerId: string;
			purpose: string;
			expectedReturnAt: string;
			accessoryChecks: Array<{
				id: string;
				name: string;
				quantity: number;
				outOk: boolean;
				returnOk: boolean | null;
			}>;
		} | null;
	}

	let scanData = $state<AssetScanPayload | null>(null);
	let locations = $state<LocationCandidate[]>([]);
	let currentUserName = $state('Pengguna');
	let loading = $state(true);
	let errorMsg = $state('');
	let successBanner = $state('');

	// Mode aktif: 'info' | 'borrow' | 'return'
	let activeMode = $state<'info' | 'borrow' | 'return'>('info');

	// State GPS (diambil sekali di latar belakang saat layar dibuka - Bagian 7.1)
	let gpsLoading = $state(false);
	let gpsAvailable = $state(false);
	let latitude = $state<number | null>(null);
	let longitude = $state<number | null>(null);
	let accuracyM = $state<number | null>(null);
	let gpsMessage = $state('Belum mengambil titik GPS.');

	// State Kamera Bukti + Watermark (Hanya kamera langsung, tanpa galeri - BR-04)
	let videoEl = $state<HTMLVideoElement | null>(null);
	let cameraOpen = $state(false);
	let cameraError = $state('');
	let stream: MediaStream | null = null;
	let capturedDataUrl = $state<string | null>(null);
	let capturedTakenAt = $state<string | null>(null);

	// State Form Pinjam
	let selectedLocationId = $state('');
	let purposeChoice = $state('Seminar');
	let purposeNote = $state('');
	let expectedReturnDate = $state('');
	let borrowChecks = $state<Array<{ name: string; quantity: number; outOk: boolean }>>([]);

	// State Form Kembali
	let returnCondition = $state<'NORMAL' | 'DAMAGED'>('NORMAL');
	let damageNote = $state('');
	let returnChecks = $state<
		Array<{ id?: string; name: string; quantity: number; returnOk: boolean }>
	>([]);

	let submitting = $state(false);

	function getDefaultTomorrowIsoLocal(): string {
		const d = new Date(Date.now() + 24 * 3600 * 1000);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function acquireGpsOnce() {
		if (!navigator.geolocation) {
			gpsAvailable = false;
			gpsMessage =
				'GPS tidak didukung oleh browser ini. Silakan pilih Lokasi Resmi secara manual di bawah (BR-06).';
			return;
		}

		gpsLoading = true;
		gpsMessage = 'Mengambil koordinat GPS...';

		navigator.geolocation.getCurrentPosition(
			(pos) => {
				gpsLoading = false;
				gpsAvailable = true;
				latitude = pos.coords.latitude;
				longitude = pos.coords.longitude;
				accuracyM = pos.coords.accuracy;
				gpsMessage = `GPS Terkunci: ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracyM)} m)`;

				if (locations.length > 0 && latitude !== null && longitude !== null) {
					const nearest = findNearestLocation(latitude, longitude, locations);
					if (nearest && !selectedLocationId) {
						selectedLocationId = nearest.location.id;
					}
				}
			},
			() => {
				gpsLoading = false;
				gpsAvailable = false;
				latitude = null;
				longitude = null;
				accuracyM = null;
				gpsMessage =
					'Sinyal GPS tidak terbaca / ditolak. Pekerjaan TIDAK diblokir — silakan pilih Lokasi Resmi secara manual di bawah (BR-06).';
			},
			{
				enableHighAccuracy: true,
				timeout: 8000,
				maximumAge: 30000
			}
		);
	}

	async function loadAssetAndMeta() {
		loading = true;
		errorMsg = '';
		try {
			const codeParam = page.params.code ?? '';
			const [assetRes, locRes, meRes] = await Promise.all([
				mobileApi.get(`/api/v1/assets/by-code/${encodeURIComponent(codeParam)}`),
				mobileApi.get('/api/v1/locations?onlyActive=true'),
				mobileApi.get('/api/v1/auth/me')
			]);

			if (meRes.ok) {
				const meData = await meRes.json();
				currentUserName = meData.user?.name || 'Pengguna';
			}

			if (locRes.ok) {
				const locData = await locRes.json();
				locations = locData.items ?? [];
			}

			const data = await assetRes.json();
			if (!assetRes.ok) {
				errorMsg = formatFriendlyErrorMessage(data, 'Barang tidak ditemukan.');
				return;
			}

			scanData = data;
			expectedReturnDate = getDefaultTomorrowIsoLocal();

			if (data.asset.homeLocation?.id) {
				selectedLocationId = data.asset.homeLocation.id;
			} else if (locations.length > 0) {
				selectedLocationId = locations[0].id;
			}

			borrowChecks = (data.asset.accessories ?? []).map(
				(a: { name: string; quantity: number }) => ({
					name: a.name,
					quantity: a.quantity,
					outOk: true
				})
			);

			if (data.activeLoanItem?.accessoryChecks?.length) {
				returnChecks = data.activeLoanItem.accessoryChecks.map(
					(c: { id: string; name: string; quantity: number }) => ({
						id: c.id,
						name: c.name,
						quantity: c.quantity,
						returnOk: true
					})
				);
			} else {
				returnChecks = (data.asset.accessories ?? []).map(
					(a: { name: string; quantity: number }) => ({
						name: a.name,
						quantity: a.quantity,
						returnOk: true
					})
				);
			}

			const requestedMode = page.url.searchParams.get('mode');
			if (requestedMode === 'return' && data.allowedActions.includes('RETURN')) {
				activeMode = 'return';
			}
		} catch {
			errorMsg = 'Gagal memuat informasi barang. Periksa koneksi Anda.';
		} finally {
			loading = false;
		}
	}

	async function openEvidenceCamera() {
		cameraError = '';
		capturedDataUrl = null;
		capturedTakenAt = null;

		if (!navigator.mediaDevices?.getUserMedia) {
			cameraError =
				'Kamera tidak dapat diakses. Pastikan membuka halaman lewat http://localhost:5173/m (USB Port Forwarding) dan izinkan akses kamera.';
			return;
		}

		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: { ideal: 'environment' },
					width: { ideal: 1280 },
					height: { ideal: 960 }
				},
				audio: false
			});
			cameraOpen = true;

			setTimeout(() => {
				if (videoEl && stream) {
					videoEl.srcObject = stream;
					videoEl.play().catch(() => {});
				}
			}, 50);
		} catch {
			cameraError =
				'Izin kamera ditolak atau kamera tidak ditemukan. Berikan izin kamera di pengaturan browser Chrome HP Anda.';
		}
	}

	function stopCameraStream() {
		if (stream) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
			stream = null;
		}
		cameraOpen = false;
	}

	function capturePhotoWithWatermark() {
		if (!videoEl || !scanData) return;
		const srcW = videoEl.videoWidth || 1280;
		const srcH = videoEl.videoHeight || 960;
		const { width, height } = computeCompressedDimensions(srcW, srcH, 1280);

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		ctx.drawImage(videoEl, 0, 0, width, height);

		const now = new Date();
		const selectedLocName =
			locations.find((l) => l.id === selectedLocationId)?.name ??
			scanData.asset.homeLocation?.name ??
			'Lokasi belum dipilih';

		const lines = formatWatermarkLines({
			actionLabel: activeMode === 'return' ? 'KEMBALI' : 'PINJAM',
			assetName: scanData.asset.name,
			assetCode: scanData.asset.code,
			userName: currentUserName,
			takenAt: now,
			gpsAvailable,
			latitude,
			longitude,
			accuracyM,
			locationName: selectedLocName
		});

		drawWatermarkToContext(ctx, width, height, lines);

		capturedDataUrl = canvas.toDataURL('image/jpeg', DEFAULT_JPEG_QUALITY);
		capturedTakenAt = now.toISOString();
		stopCameraStream();
	}

	async function handleBorrowSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!scanData) return;
		errorMsg = '';

		if (!capturedDataUrl || !capturedTakenAt) {
			errorMsg = 'Silakan ambil foto bukti kondisi barang dari kamera terlebih dahulu.';
			return;
		}

		if (!gpsAvailable && !selectedLocationId) {
			errorMsg = 'Karena GPS tidak tersedia, Anda wajib memilih Lokasi Resmi dari daftar (BR-06).';
			return;
		}

		submitting = true;
		try {
			// 1. Unggah Evidence CHECKOUT melalui mobileApi (otomatis refresh bila token kedaluwarsa di tengah pengisian form)
			const evRes = await mobileApi.post('/api/v1/evidence', {
				purpose: 'CHECKOUT',
				captureSource: 'CAMERA',
				takenAtDevice: capturedTakenAt,
				gpsAvailable,
				latitude: gpsAvailable ? latitude : null,
				longitude: gpsAvailable ? longitude : null,
				accuracyM: gpsAvailable ? accuracyM : null,
				isMockLocation: false,
				locationId: selectedLocationId || null,
				imageBase64: capturedDataUrl,
				mimeType: 'image/jpeg'
			});
			const evData = await evRes.json();
			if (!evRes.ok) {
				errorMsg = formatFriendlyErrorMessage(evData, 'Gagal mengunggah foto bukti.');
				return;
			}

			// 2. Buat Peminjaman
			const loanRes = await mobileApi.post('/api/v1/loans', {
				purpose: purposeChoice,
				purposeNote: purposeNote.trim() || null,
				expectedReturnAt: new Date(expectedReturnDate).toISOString(),
				clientOpId: crypto.randomUUID(),
				items: [
					{
						assetId: scanData.asset.id,
						checkoutEvidenceId: evData.evidence.id,
						accessoryChecks: borrowChecks
					}
				]
			});
			const loanData = await loanRes.json();
			if (!loanRes.ok) {
				errorMsg = formatFriendlyErrorMessage(loanData, 'Gagal menyimpan peminjaman.');
				return;
			}

			successBanner =
				loanData.loan.status === 'PENDING_APPROVAL'
					? `Permintaan peminjaman ${scanData.asset.code} berhasil dikirim dan menunggu persetujuan Admin.`
					: `Peminjaman ${scanData.asset.code} (${scanData.asset.name}) berhasil dicatat!`;
			activeMode = 'info';
			capturedDataUrl = null;
			await loadAssetAndMeta();
		} catch {
			errorMsg = 'Terjadi gangguan jaringan saat mengirim peminjaman.';
		} finally {
			submitting = false;
		}
	}

	async function handleReturnSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!scanData?.activeLoanItem) return;
		errorMsg = '';

		if (!capturedDataUrl || !capturedTakenAt) {
			errorMsg = 'Silakan ambil foto bukti pengembalian barang dari kamera terlebih dahulu.';
			return;
		}

		if (returnCondition === 'DAMAGED' && damageNote.trim().length < 3) {
			errorMsg =
				'Karena kondisi barang dipilih Rusak, mohon tulis catatan kerusakan minimal 3 karakter (BR-09).';
			return;
		}

		if (!gpsAvailable && !selectedLocationId) {
			errorMsg = 'Karena GPS tidak tersedia, Anda wajib memilih Lokasi Resmi dari daftar (BR-06).';
			return;
		}

		submitting = true;
		try {
			// 1. Unggah Evidence RETURN melalui mobileApi (otomatis refresh bila token kedaluwarsa di tengah pengisian form)
			const evRes = await mobileApi.post('/api/v1/evidence', {
				purpose: 'RETURN',
				captureSource: 'CAMERA',
				takenAtDevice: capturedTakenAt,
				gpsAvailable,
				latitude: gpsAvailable ? latitude : null,
				longitude: gpsAvailable ? longitude : null,
				accuracyM: gpsAvailable ? accuracyM : null,
				isMockLocation: false,
				locationId: selectedLocationId || null,
				imageBase64: capturedDataUrl,
				mimeType: 'image/jpeg'
			});
			const evData = await evRes.json();
			if (!evRes.ok) {
				errorMsg = formatFriendlyErrorMessage(evData, 'Gagal mengunggah foto bukti pengembalian.');
				return;
			}

			// 2. Proses Pengembalian
			const retRes = await mobileApi.post(
				`/api/v1/loan-items/${scanData.activeLoanItem.id}/return`,
				{
					returnCondition,
					evidenceId: evData.evidence.id,
					damageNote: returnCondition === 'DAMAGED' ? damageNote.trim() : null,
					accessoryChecks: returnChecks.map((c) => ({
						id: c.id,
						name: c.name,
						returnOk: c.returnOk
					})),
					clientOpId: crypto.randomUUID()
				}
			);
			const retData = await retRes.json();
			if (!retRes.ok) {
				errorMsg = formatFriendlyErrorMessage(retData, 'Gagal memproses pengembalian barang.');
				return;
			}

			successBanner = `Barang ${scanData.asset.code} berhasil dikembalikan (${returnCondition === 'DAMAGED' ? 'Dilaporkan Rusak' : 'Kondisi Normal'}).`;
			activeMode = 'info';
			capturedDataUrl = null;
			await loadAssetAndMeta();
		} catch {
			errorMsg = 'Terjadi gangguan jaringan saat mengirim pengembalian.';
		} finally {
			submitting = false;
		}
	}

	onMount(async () => {
		acquireGpsOnce();
		await loadAssetAndMeta();
	});

	onDestroy(() => {
		stopCameraStream();
	});
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<a href="/m/scan" class="text-xs font-bold text-slate-700 underline">
			← Kembali ke Scan / Cari
		</a>
		<button
			type="button"
			onclick={acquireGpsOnce}
			class="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700"
		>
			{gpsLoading ? 'Mencari GPS...' : 'Segarkan GPS'}
		</button>
	</div>

	{#if successBanner}
		<div
			class="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-bold text-emerald-900"
		>
			{successBanner}
			<div class="mt-3 flex gap-2">
				<a href="/m/loans" class="rounded-xl bg-emerald-800 px-4 py-2 text-xs font-bold text-white">
					Lihat Pinjaman Saya
				</a>
				<a
					href="/m/scan"
					class="rounded-xl border border-emerald-700 bg-white px-4 py-2 text-xs font-bold text-emerald-900"
				>
					Scan Barang Lain
				</a>
			</div>
		</div>
	{/if}

	{#if errorMsg}
		<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
			{errorMsg}
		</div>
	{/if}

	{#if loading}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			Memuat informasi barang...
		</div>
	{:else if scanData}
		<!-- KARTU INFO BARANG (Bagian 7.1 & 8.1) -->
		<div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
			<div class="flex items-start justify-between gap-2">
				<div>
					<div class="font-mono text-sm font-extrabold text-slate-600">
						{scanData.asset.code}
					</div>
					<h1 class="text-xl font-bold text-slate-900">{scanData.asset.name}</h1>
				</div>
				<span
					class="rounded-full px-3 py-1 text-xs font-bold {scanData.asset.status === 'AVAILABLE'
						? 'bg-emerald-100 text-emerald-800'
						: scanData.asset.status === 'BORROWED'
							? 'bg-blue-100 text-blue-800'
							: 'bg-amber-100 text-amber-900'}"
				>
					{AssetStatusLabels[scanData.asset.status]}
				</span>
			</div>

			<div class="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
				<div>
					<span class="text-slate-500">Kategori:</span>
					<div class="font-bold text-slate-900">{scanData.asset.category.name}</div>
				</div>
				<div>
					<span class="text-slate-500">Lokasi Asal:</span>
					<div class="font-bold text-slate-900">
						{scanData.asset.homeLocation?.name || '-'}
					</div>
				</div>
				{#if scanData.asset.serialNumber}
					<div class="col-span-2">
						<span class="text-slate-500">Nomor Seri:</span>
						<span class="font-mono font-semibold text-slate-900">
							{scanData.asset.serialNumber}
						</span>
					</div>
				{/if}
			</div>

			{#if scanData.requiresApproval && scanData.asset.status === 'AVAILABLE'}
				<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
					<strong>Perlu Persetujuan Admin:</strong> Kategori barang ini membutuhkan persetujuan Admin
					setelah Anda mengirim form pinjam (BR-08).
				</div>
			{/if}

			<!-- STATUS GPS SAAT INI -->
			<div
				class="rounded-xl border p-3 text-xs {gpsAvailable
					? 'border-emerald-200 bg-emerald-50 text-emerald-900'
					: 'border-amber-200 bg-amber-50 text-amber-900'}"
			>
				{gpsMessage}
			</div>

			<!-- TOMBOL AKSI SESUAI allowedActions (Bagian 7.1 Langkah 2 & 8.1) -->
			{#if activeMode === 'info'}
				{#if scanData.allowedActions.includes('BORROW')}
					<button
						type="button"
						onclick={() => {
							activeMode = 'borrow';
							openEvidenceCamera();
						}}
						class="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-extrabold text-white shadow-xs active:bg-slate-800"
					>
						PINJAM BARANG INI
					</button>
				{:else if scanData.allowedActions.includes('RETURN') && scanData.activeLoanItem}
					<div class="rounded-xl bg-blue-50 p-3 text-xs text-blue-900">
						Barang ini tercatat sedang dipinjam oleh
						<strong>{scanData.currentHolder || 'Anda'}</strong> (Keperluan:
						{scanData.activeLoanItem.purpose}).
					</div>
					<button
						type="button"
						onclick={() => {
							activeMode = 'return';
							openEvidenceCamera();
						}}
						class="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-extrabold text-white shadow-xs active:bg-slate-800"
					>
						KEMBALIKAN BARANG INI
					</button>
				{:else}
					<!-- BERHENTI DI SINI BILA TIDAK BOLEH DIPINJAM (BR-01, BR-10, Bagian 8.1) -->
					<div class="rounded-xl border border-slate-300 bg-slate-100 p-4 text-sm text-slate-800">
						<div class="font-bold text-slate-900">Barang Tidak Dapat Dipinjam Saat Ini</div>
						<p class="mt-1 text-xs text-slate-600">
							{#if scanData.asset.status === 'BORROWED'}
								Barang ini sedang dipinjam oleh
								<strong>{scanData.currentHolder || 'pengguna lain'}</strong> dan hanya dapat dikembalikan
								oleh peminjam tersebut atau Petugas.
							{:else if scanData.asset.status === 'PENDING_APPROVAL'}
								Barang ini sedang menunggu persetujuan peminjaman dari Admin.
							{:else if scanData.asset.status === 'DAMAGED'}
								Barang ini berstatus <strong>Rusak</strong> dan menunggu tindak lanjut perbaikan Admin
								(BR-10).
							{:else if scanData.asset.status === 'IN_MAINTENANCE'}
								Barang ini sedang <strong>Dalam Perbaikan</strong> dan tidak dapat dipinjam (BR-10).
							{:else if scanData.asset.status === 'LOST'}
								Barang ini tercatat <strong>Hilang</strong> (BR-10).
							{:else if scanData.asset.status === 'RETIRED'}
								Barang ini sudah <strong>Afkir (Tidak Aktif)</strong> (BR-10).
							{/if}
						</p>
					</div>
				{/if}
			{/if}
		</div>

		<!-- KAMERA BUKTI + WATERMARK CANVAS & FORM (PINJAM ATAU KEMBALI) -->
		{#if activeMode === 'borrow' || activeMode === 'return'}
			<div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
				<div class="flex items-center justify-between">
					<h2 class="text-base font-bold text-slate-900">
						{activeMode === 'borrow'
							? '1. Foto Bukti & Form Peminjaman'
							: '1. Foto Bukti & Form Pengembalian'}
					</h2>
					<button
						type="button"
						onclick={() => {
							stopCameraStream();
							activeMode = 'info';
						}}
						class="text-xs font-semibold text-slate-500 underline"
					>
						Batal
					</button>
				</div>

				<!-- PILIHAN LOKASI RESMI (Digunakan untuk Watermark & Wajib bila GPS Gagal - BR-06) -->
				<div>
					<label for="loc-select" class="block text-sm font-bold text-slate-800">
						Lokasi Resmi {gpsAvailable
							? '(Otomatis / Sesuaikan)'
							: '(Wajib Dipilih Manual - BR-06)'}
					</label>
					<select
						id="loc-select"
						required={!gpsAvailable}
						bind:value={selectedLocationId}
						class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base"
					>
						<option value="">-- Pilih Lokasi Resmi --</option>
						{#each locations as loc (loc.id)}
							<option value={loc.id}>{loc.name}</option>
						{/each}
					</select>
				</div>

				<!-- AREA KAMERA BUKTI LANGSUNG (TANPA TOMBOL GALERI - BR-04) -->
				<div class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
					<div class="text-xs font-bold uppercase tracking-wider text-slate-600">
						Kamera Bukti Kondisi Barang (Hanya Kamera Langsung)
					</div>

					{#if cameraError}
						<div class="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
							{cameraError}
						</div>
					{/if}

					{#if capturedDataUrl}
						<div class="space-y-2">
							<img
								src={capturedDataUrl}
								alt="Hasil foto bukti ber-watermark"
								class="w-full rounded-xl border border-slate-300"
							/>
							<button
								type="button"
								onclick={openEvidenceCamera}
								class="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 active:bg-slate-100"
							>
								Foto Ulang dari Kamera
							</button>
						</div>
					{:else if cameraOpen}
						<div class="space-y-2">
							<div class="overflow-hidden rounded-xl bg-black">
								<video
									bind:this={videoEl}
									autoplay
									playsinline
									muted
									class="aspect-4/3 w-full object-cover"
								></video>
							</div>
							<button
								type="button"
								onclick={capturePhotoWithWatermark}
								class="w-full rounded-xl bg-emerald-600 px-5 py-4 text-base font-extrabold text-white shadow-xs active:bg-emerald-700"
							>
								AMBIL FOTO & TEMPEL WATERMARK
							</button>
						</div>
					{:else}
						<button
							type="button"
							onclick={openEvidenceCamera}
							class="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-bold text-white"
						>
							Buka Kamera Bukti
						</button>
					{/if}
				</div>

				<!-- FORM PINJAM -->
				{#if activeMode === 'borrow'}
					<form onsubmit={handleBorrowSubmit} class="space-y-4">
						<div>
							<span class="block text-sm font-bold text-slate-800">Keperluan Peminjaman</span>
							<div class="mt-2 grid grid-cols-2 gap-2">
								{#each ['Seminar', 'Meeting', 'Pelatihan', 'Lainnya'] as opt (opt)}
									<button
										type="button"
										onclick={() => (purposeChoice = opt)}
										class="rounded-xl border px-3 py-3 text-sm font-bold {purposeChoice === opt
											? 'border-slate-900 bg-slate-900 text-white'
											: 'border-slate-300 bg-white text-slate-800'}"
									>
										{opt}
									</button>
								{/each}
							</div>
						</div>

						<div>
							<label for="p-note" class="block text-sm font-bold text-slate-800">
								Keterangan Tambahan (Opsional)
							</label>
							<input
								id="p-note"
								type="text"
								bind:value={purposeNote}
								placeholder="Mis. Ruang Seminar A Gedung Utama"
								class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base"
							/>
						</div>

						<div>
							<label for="p-ret" class="block text-sm font-bold text-slate-800">
								Rencana Tanggal & Jam Kembali
							</label>
							<input
								id="p-ret"
								type="datetime-local"
								required
								bind:value={expectedReturnDate}
								class="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 text-base"
							/>
						</div>

						{#if borrowChecks.length > 0}
							<div class="space-y-2 rounded-xl border border-slate-200 p-3.5">
								<div class="text-sm font-bold text-slate-800">Checklist Kelengkapan</div>
								{#each borrowChecks as chk, idx (idx)}
									<label class="flex items-center gap-3 py-1 text-sm text-slate-800">
										<input
											type="checkbox"
											bind:checked={chk.outOk}
											class="h-5 w-5 rounded border-slate-300"
										/>
										<span>{chk.name} ({chk.quantity}x)</span>
									</label>
								{/each}
							</div>
						{/if}

						<button
							type="submit"
							disabled={submitting || !capturedDataUrl}
							class="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-extrabold text-white shadow-xs active:bg-slate-800 disabled:opacity-50"
						>
							{submitting ? 'Mengirim Peminjaman...' : 'KIRIM PEMINJAMAN'}
						</button>
					</form>
				{:else}
					<!-- FORM KEMBALI (3 Ketukan untuk kasus normal - Bagian 7.3) -->
					<form onsubmit={handleReturnSubmit} class="space-y-4">
						<div>
							<span class="block text-sm font-bold text-slate-800">
								Kondisi Barang Saat Dikembalikan (BR-09)
							</span>
							<div class="mt-2 grid grid-cols-2 gap-2">
								<button
									type="button"
									onclick={() => (returnCondition = 'NORMAL')}
									class="rounded-xl border px-3 py-3.5 text-sm font-bold {returnCondition ===
									'NORMAL'
										? 'border-emerald-700 bg-emerald-700 text-white'
										: 'border-slate-300 bg-white text-slate-800'}"
								>
									Normal (Baik)
								</button>
								<button
									type="button"
									onclick={() => (returnCondition = 'DAMAGED')}
									class="rounded-xl border px-3 py-3.5 text-sm font-bold {returnCondition ===
									'DAMAGED'
										? 'border-red-700 bg-red-700 text-white'
										: 'border-slate-300 bg-white text-slate-800'}"
								>
									Rusak / Bermasalah
								</button>
							</div>
						</div>

						{#if returnCondition === 'DAMAGED'}
							<div>
								<label for="dmg-note" class="block text-sm font-bold text-red-800">
									Catatan Detail Kerusakan (Wajib - BR-09)
								</label>
								<textarea
									id="dmg-note"
									rows="3"
									required
									minlength="3"
									bind:value={damageNote}
									placeholder="Jelaskan bagian yang rusak atau kendala barang..."
									class="mt-1.5 w-full rounded-xl border border-red-300 px-4 py-3 text-base"
								></textarea>
							</div>
						{/if}

						{#if returnChecks.length > 0}
							<div class="space-y-2 rounded-xl border border-slate-200 p-3.5">
								<div class="text-sm font-bold text-slate-800">Checklist Kelengkapan Kembali</div>
								{#each returnChecks as chk, idx (idx)}
									<label class="flex items-center gap-3 py-1 text-sm text-slate-800">
										<input
											type="checkbox"
											bind:checked={chk.returnOk}
											class="h-5 w-5 rounded border-slate-300"
										/>
										<span>{chk.name} ({chk.quantity}x) kembali lengkap</span>
									</label>
								{/each}
							</div>
						{/if}

						<button
							type="submit"
							disabled={submitting || !capturedDataUrl}
							class="w-full rounded-xl bg-slate-900 px-5 py-4 text-base font-extrabold text-white shadow-xs active:bg-slate-800 disabled:opacity-50"
						>
							{submitting ? 'Memproses Pengembalian...' : 'KIRIM PENGEMBALIAN'}
						</button>
					</form>
				{/if}
			</div>
		{/if}
	{/if}
</div>
