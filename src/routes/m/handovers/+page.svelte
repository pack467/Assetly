<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { mobileApi } from '$lib/client/api';
	import { getOfflineQueueStorage } from '$lib/client/offlineQueue';
	import { enqueueOfflineOperation, syncPendingOperations } from '$lib/client/syncManager';
	import { RoleLabels } from '$lib/shared/enums';
	import {
		computeCompressedDimensions,
		DEFAULT_JPEG_QUALITY,
		drawWatermarkToContext,
		findNearestLocation,
		formatFriendlyErrorMessage,
		formatWatermarkLines,
		type LocationCandidate
	} from '$lib/shared/mobile/watermark';

	interface Participant {
		id: string;
		name: string;
		email?: string;
		role: string;
	}

	interface ActiveLoanOption {
		id: string;
		purpose: string;
		borrower: { id: string; name: string; email: string };
		items: Array<{
			id: string;
			returnedAt: string | null;
			asset: { id: string; code: string; name: string };
		}>;
	}

	interface HandoverRecord {
		id: string;
		loanId: string;
		giverId: string;
		receiverId: string;
		giverConfirmedAt: string | null;
		receiverConfirmedAt: string | null;
		documentNo: string | null;
		createdAt: string;
		isConfirmed: boolean;
		isOverdueConfirmation: boolean;
		evidenceSignedUrl: string | null;
		giver: Participant;
		receiver: Participant;
		loan: {
			id: string;
			purpose: string;
			items: Array<{
				id: string;
				asset: { id: string; code: string; name: string };
			}>;
		};
	}

	let handovers = $state<HandoverRecord[]>([]);
	let participants = $state<Participant[]>([]);
	let activeLoans = $state<ActiveLoanOption[]>([]);
	let locations = $state<LocationCandidate[]>([]);
	let currentUserId = $state('');
	let currentUserName = $state('Pengguna');
	let loading = $state(true);
	let errorMsg = $state('');
	let successMsg = $state('');
	let queuedMsg = $state('');

	// Form buat serah terima baru
	let showCreateForm = $state(false);
	let selectedLoanId = $state('');
	let selectedReceiverId = $state('');
	let selectedLocationId = $state('');
	let submitting = $state(false);

	// State GPS untuk foto bukti serah terima (Bagian 7.1 & 7.2)
	let gpsLoading = $state(false);
	let gpsAvailable = $state(false);
	let latitude = $state<number | null>(null);
	let longitude = $state<number | null>(null);
	let accuracyM = $state<number | null>(null);
	let gpsMessage = $state('Belum mengambil titik GPS.');

	// Kamera bukti serah terima (opsional, hanya kamera langsung - BR-04)
	let videoEl = $state<HTMLVideoElement | null>(null);
	let cameraOpen = $state(false);
	let cameraError = $state('');
	let stream: MediaStream | null = null;
	let capturedDataUrl = $state<string | null>(null);
	let capturedTakenAt = $state<string | null>(null);

	function acquireGpsOnce() {
		if (typeof navigator === 'undefined' || !navigator.geolocation) {
			gpsAvailable = false;
			gpsMessage =
				'GPS tidak didukung oleh browser ini. Pilih Lokasi Serah Terima di bawah (BR-06).';
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
					if (nearest) {
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
					'Sinyal GPS tidak terbaca / ditolak. Pekerjaan tidak diblokir — pilih Lokasi Resmi di bawah (BR-06).';
			},
			{
				enableHighAccuracy: true,
				timeout: 8000,
				maximumAge: 30000
			}
		);
	}

	async function loadData() {
		loading = true;
		errorMsg = '';
		try {
			const [meRes, hoRes, loanRes, locRes] = await Promise.all([
				mobileApi.get('/api/v1/auth/me'),
				mobileApi.get('/api/v1/handovers?pageSize=50'),
				mobileApi.get('/api/v1/loans?status=ACTIVE&pageSize=50'),
				mobileApi.get('/api/v1/locations?onlyActive=true')
			]);

			if (meRes.ok) {
				const me = await meRes.json();
				currentUserId = me.user?.id ?? '';
				currentUserName = me.user?.name ?? 'Pengguna';
			}

			if (hoRes.ok) {
				const hoData = await hoRes.json();
				handovers = hoData.items ?? [];
				participants = (hoData.participants ?? []).filter(
					(p: Participant) => p.id !== currentUserId
				);
				if (!selectedReceiverId && participants.length > 0) {
					selectedReceiverId = participants[0].id;
				}
			}

			if (loanRes.ok) {
				const loanData = await loanRes.json();
				activeLoans = loanData.items ?? [];
				if (!selectedLoanId && activeLoans.length > 0) {
					selectedLoanId = activeLoans[0].id;
				}
			}

			if (locRes.ok) {
				const locData = await locRes.json();
				locations = locData.items ?? [];
				if (!selectedLocationId && locations.length > 0) {
					selectedLocationId = locations[0].id;
				}
			}

			try {
				sessionStorage.setItem(
					'itam_handovers_cache',
					JSON.stringify({
						currentUserId,
						currentUserName,
						handovers,
						participants,
						activeLoans,
						locations
					})
				);
			} catch {
				// Abaikan bila storage penuh
			}
		} catch {
			try {
				const cached = sessionStorage.getItem('itam_handovers_cache');
				if (cached) {
					const parsed = JSON.parse(cached);
					currentUserId = parsed.currentUserId ?? '';
					currentUserName = parsed.currentUserName ?? 'Pengguna';
					handovers = parsed.handovers ?? [];
					participants = parsed.participants ?? [];
					activeLoans = parsed.activeLoans ?? [];
					locations = parsed.locations ?? [];
					if (!selectedReceiverId && participants.length > 0) {
						selectedReceiverId = participants[0].id;
					}
					if (!selectedLoanId && activeLoans.length > 0) {
						selectedLoanId = activeLoans[0].id;
					}
					if (!selectedLocationId && locations.length > 0) {
						selectedLocationId = locations[0].id;
					}
					return;
				}
			} catch {
				// Abaikan
			}
			errorMsg = 'Gagal memuat data serah terima. Periksa koneksi internet HP Anda.';
		} finally {
			loading = false;
		}
	}

	async function openCamera() {
		cameraError = '';
		capturedDataUrl = null;
		capturedTakenAt = null;
		if (!navigator.mediaDevices?.getUserMedia) {
			cameraError = 'Kamera tidak didukung di browser ini.';
			return;
		}
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
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
			cameraError = 'Izin kamera belum diberikan.';
		}
	}

	function stopCamera() {
		if (stream) {
			for (const t of stream.getTracks()) t.stop();
			stream = null;
		}
		cameraOpen = false;
	}

	function captureWatermarkPhoto() {
		if (!videoEl) return;
		const { width, height } = computeCompressedDimensions(
			videoEl.videoWidth || 1280,
			videoEl.videoHeight || 960,
			1280
		);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		ctx.drawImage(videoEl, 0, 0, width, height);

		const loan = activeLoans.find((l) => l.id === selectedLoanId);
		const firstItem = loan?.items[0]?.asset;
		const locName = locations.find((l) => l.id === selectedLocationId)?.name ?? 'Lokasi Resmi';
		const now = new Date();

		const lines = formatWatermarkLines({
			actionLabel: 'SERAH TERIMA',
			assetName: firstItem?.name ?? 'Barang Pinjaman',
			assetCode: firstItem?.code ?? '-',
			userName: currentUserName,
			takenAt: now,
			gpsAvailable,
			latitude,
			longitude,
			accuracyM,
			locationName: locName
		});

		drawWatermarkToContext(ctx, width, height, lines);
		capturedDataUrl = canvas.toDataURL('image/jpeg', DEFAULT_JPEG_QUALITY);
		capturedTakenAt = now.toISOString();
		stopCamera();
	}

	async function handleCreateHandover(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';
		successMsg = '';
		queuedMsg = '';

		if (!selectedLoanId || !selectedReceiverId) {
			errorMsg = 'Pilih peminjaman aktif dan pihak penerima terlebih dahulu.';
			return;
		}

		if (capturedDataUrl && !gpsAvailable && !selectedLocationId) {
			errorMsg = 'Karena GPS tidak tersedia, pilih Lokasi Serah Terima dari daftar (BR-06).';
			return;
		}

		const loan = activeLoans.find((l) => l.id === selectedLoanId);
		const firstAsset = loan?.items[0]?.asset;
		const receiver = participants.find((p) => p.id === selectedReceiverId);

		submitting = true;
		try {
			const queued = await enqueueOfflineOperation({
				type: 'HANDOVER_CREATE',
				label: `Serah Terima ${firstAsset?.code ?? 'Pinjaman'} ke ${receiver?.name ?? 'Penerima'}`,
				assetCode: firstAsset?.code ?? null,
				assetName: firstAsset?.name ?? null,
				payload: {
					loanId: selectedLoanId,
					giverId: currentUserId || undefined,
					receiverId: selectedReceiverId,
					autoConfirmGiver: true
				},
				pendingEvidence:
					capturedDataUrl && capturedTakenAt
						? {
								purpose: 'HANDOVER',
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
							}
						: null
			});

			await syncPendingOperations({ force: true });
			const latest = await getOfflineQueueStorage().getById(queued.clientOpId);

			if (latest?.syncState === 'ACCEPTED') {
				successMsg =
					'Serah terima berhasil dibuat dan dikonfirmasi oleh Anda sebagai Pemberi. Menunggu konfirmasi Penerima.';
				showCreateForm = false;
				capturedDataUrl = null;
				await loadData();
			} else if (latest?.syncState === 'CONFLICT' || latest?.syncState === 'REJECTED') {
				errorMsg =
					latest.conflictReason ||
					latest.lastError ||
					'Serah terima tidak dapat diproses karena terjadi konflik di server.';
			} else {
				queuedMsg =
					'Tersimpan di Antrean Lokal HP! Data serah terima beserta foto bukti sudah aman di HP dan akan dikirim otomatis begitu sinyal kembali.';
				showCreateForm = false;
				capturedDataUrl = null;
			}
		} catch (err) {
			errorMsg =
				err instanceof Error && err.message
					? err.message
					: 'Gagal menyimpan serah terima ke penyimpanan lokal HP. Data belum tersimpan — periksa ruang penyimpanan HP Anda lalu coba lagi.';
		} finally {
			submitting = false;
		}
	}

	async function handleConfirmHandover(handoverId: string) {
		errorMsg = '';
		successMsg = '';
		queuedMsg = '';

		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			errorMsg =
				'HP Anda sedang offline. Konfirmasi serah terima oleh pihak kedua memerlukan koneksi internet aktif untuk memverifikasi status pinjaman terbaru dan menerbitkan Nomor Berita Acara resmi di server.';
			return;
		}

		try {
			const res = await mobileApi.post(`/api/v1/handovers/${handoverId}/confirm`, {});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = formatFriendlyErrorMessage(data, 'Gagal mengonfirmasi serah terima.');
				return;
			}
			successMsg = data.handover.isConfirmed
				? `Serah terima lengkap dikonfirmasi dua pihak! Nomor BA: ${data.handover.documentNo}`
				: 'Konfirmasi Anda berhasil dicatat.';
			await loadData();
		} catch {
			errorMsg =
				'Tidak dapat terhubung ke server untuk mengonfirmasi serah terima. Pastikan HP terhubung ke internet lalu tekan Konfirmasi kembali.';
		}
	}

	onMount(() => {
		acquireGpsOnce();
		loadData();
	});

	onDestroy(() => {
		stopCamera();
	});
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between gap-2">
		<div>
			<h1 class="text-xl font-bold text-slate-900">Serah Terima Barang</h1>
			<p class="mt-0.5 text-xs text-slate-600">
				Konfirmasi dua pihak (Pemberi & Penerima) atas perpindahan barang (Bagian 7.2).
			</p>
		</div>
		<button
			type="button"
			onclick={() => {
				showCreateForm = !showCreateForm;
				stopCamera();
			}}
			class="shrink-0 rounded-xl bg-slate-900 px-3.5 py-2.5 text-xs font-bold text-white"
		>
			{showCreateForm ? 'Tutup Form' : '+ Buat Baru'}
		</button>
	</div>

	{#if queuedMsg}
		<div
			class="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-950"
		>
			<div>{queuedMsg}</div>
			<div class="mt-2">
				<a href="/m/sync" class="text-xs font-bold text-amber-900 underline">
					Lihat Antrean Sinkronisasi (/m/sync) →
				</a>
			</div>
		</div>
	{/if}

	{#if errorMsg}
		<div class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
			{errorMsg}
		</div>
	{/if}
	{#if successMsg}
		<div
			class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800"
		>
			{successMsg}
		</div>
	{/if}

	{#if showCreateForm}
		<form
			onsubmit={handleCreateHandover}
			class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
		>
			<div class="flex items-center justify-between">
				<h2 class="text-base font-bold text-slate-900">Buat Serah Terima Dua Pihak</h2>
				<button
					type="button"
					onclick={acquireGpsOnce}
					class="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700"
				>
					{gpsLoading ? 'Mencari GPS...' : 'Segarkan GPS'}
				</button>
			</div>

			<div
				class="rounded-xl border p-3 text-xs {gpsAvailable
					? 'border-emerald-200 bg-emerald-50 text-emerald-900'
					: 'border-amber-200 bg-amber-50 text-amber-900'}"
			>
				{gpsMessage}
			</div>

			<div>
				<label for="ho-loan" class="block text-sm font-bold text-slate-800">
					Pilih Peminjaman Aktif
				</label>
				<select
					id="ho-loan"
					required
					bind:value={selectedLoanId}
					class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm"
				>
					{#if activeLoans.length === 0}
						<option value="">-- Tidak ada peminjaman aktif --</option>
					{:else}
						{#each activeLoans as loan (loan.id)}
							<option value={loan.id}>
								{loan.items.map((i) => `${i.asset.code} (${i.asset.name})`).join(', ')} —
								{loan.purpose}
							</option>
						{/each}
					{/if}
				</select>
			</div>

			<div>
				<label for="ho-rec" class="block text-sm font-bold text-slate-800">
					Pihak Penerima (Wajib Berbeda dari Pemberi - BR-20)
				</label>
				<select
					id="ho-rec"
					required
					bind:value={selectedReceiverId}
					class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm"
				>
					{#each participants as p (p.id)}
						<option value={p.id}>
							{p.name} ({RoleLabels[p.role as keyof typeof RoleLabels] ?? p.role}{p.email
								? ` · ${p.email}`
								: ''})
						</option>
					{/each}
				</select>
			</div>

			<div>
				<label for="ho-loc" class="block text-sm font-bold text-slate-800">
					Lokasi Serah Terima
				</label>
				<select
					id="ho-loc"
					bind:value={selectedLocationId}
					class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm"
				>
					{#each locations as loc (loc.id)}
						<option value={loc.id}>{loc.name}</option>
					{/each}
				</select>
			</div>

			<!-- KAMERA BUKTI SERAH TERIMA OPSIONAL (HANYA KAMERA LANGSUNG) -->
			<div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
				<div class="text-xs font-bold text-slate-700">
					Foto Bukti Serah Terima (Opsional, Kamera Langsung + GPS Watermark)
				</div>
				{#if cameraError}
					<div class="text-xs text-red-700">{cameraError}</div>
				{/if}
				{#if capturedDataUrl}
					<img
						src={capturedDataUrl}
						alt="Foto bukti serah terima"
						class="w-full rounded-xl border border-slate-300"
					/>
					<button
						type="button"
						onclick={openCamera}
						class="w-full rounded-xl border border-slate-300 bg-white py-2.5 text-xs font-bold text-slate-800"
					>
						Foto Ulang
					</button>
				{:else if cameraOpen}
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
						onclick={captureWatermarkPhoto}
						class="w-full rounded-xl bg-emerald-600 py-3.5 text-sm font-extrabold text-white"
					>
						AMBIL FOTO SERAH TERIMA
					</button>
				{:else}
					<button
						type="button"
						onclick={openCamera}
						class="w-full rounded-xl border border-slate-300 bg-white py-3 text-xs font-bold text-slate-800"
					>
						Buka Kamera Bukti
					</button>
				{/if}
			</div>

			<button
				type="submit"
				disabled={submitting || activeLoans.length === 0}
				class="w-full rounded-xl bg-slate-900 py-4 text-base font-extrabold text-white disabled:opacity-50"
			>
				{submitting ? 'Menyimpan...' : 'BUAT & KONFIRMASI PEMBERI'}
			</button>
		</form>
	{/if}

	<!-- DAFTAR SERAH TERIMA -->
	{#if loading}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			Memuat daftar serah terima...
		</div>
	{:else if handovers.length === 0}
		<div
			class="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
		>
			Belum ada catatan serah terima.
		</div>
	{:else}
		<div class="space-y-3">
			{#each handovers as ho (ho.id)}
				{@const canConfirmAsGiver = ho.giverId === currentUserId && !ho.giverConfirmedAt}
				{@const canConfirmAsReceiver = ho.receiverId === currentUserId && !ho.receiverConfirmedAt}
				<div class="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
					<div class="flex items-center justify-between">
						{#if ho.isConfirmed}
							<span
								class="rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-bold text-emerald-800"
							>
								Terkonfirmasi 2 Pihak ({ho.documentNo})
							</span>
						{:else}
							<span class="rounded-full bg-amber-100 px-3 py-0.5 text-xs font-bold text-amber-800">
								Menunggu Konfirmasi
							</span>
						{/if}
						<span class="text-[11px] text-slate-500">
							{new Date(ho.createdAt).toLocaleString('id-ID')}
						</span>
					</div>

					<div class="rounded-xl bg-slate-50 p-3 text-xs space-y-1">
						<div class="font-bold text-slate-900">
							Barang:
							{ho.loan.items.map((i) => `${i.asset.code} (${i.asset.name})`).join(', ')}
						</div>
						<div class="text-slate-600">Keperluan: {ho.loan.purpose}</div>
					</div>

					<div class="grid grid-cols-2 gap-2 text-xs">
						<div class="rounded-xl border border-slate-200 p-2.5">
							<div class="text-slate-500">Pemberi:</div>
							<div class="font-bold text-slate-900">{ho.giver.name}</div>
							<div class="mt-1 text-[11px]">
								{#if ho.giverConfirmedAt}
									<span class="font-semibold text-emerald-700">✓ Sudah Konfirmasi</span>
								{:else}
									<span class="font-semibold text-amber-700">Belum Konfirmasi</span>
								{/if}
							</div>
						</div>
						<div class="rounded-xl border border-slate-200 p-2.5">
							<div class="text-slate-500">Penerima:</div>
							<div class="font-bold text-slate-900">{ho.receiver.name}</div>
							<div class="mt-1 text-[11px]">
								{#if ho.receiverConfirmedAt}
									<span class="font-semibold text-emerald-700">✓ Sudah Konfirmasi</span>
								{:else}
									<span class="font-semibold text-amber-700">Belum Konfirmasi</span>
								{/if}
							</div>
						</div>
					</div>

					{#if canConfirmAsGiver || canConfirmAsReceiver}
						<button
							type="button"
							onclick={() => handleConfirmHandover(ho.id)}
							class="w-full rounded-xl bg-emerald-600 py-3.5 text-sm font-extrabold text-white active:bg-emerald-700"
						>
							KONFIRMASI SEBAGAI {canConfirmAsGiver ? 'PEMBERI' : 'PENERIMA'}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
