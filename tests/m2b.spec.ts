import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	computeCompressedDimensions,
	drawWatermarkToContext,
	findNearestLocation,
	formatFriendlyErrorMessage,
	formatWatermarkLines,
	type Canvas2DWatermarkTarget
} from '../src/lib/shared/mobile/watermark';
import { createMobileApiClient } from '../src/lib/client/api';
import { createMemoryTokenStorage } from '../src/lib/client/tokenStorage';
import * as mobileLayoutConfig from '../src/routes/m/+layout';

function collectFilesRecursive(dir: string): string[] {
	const results: string[] = [];
	if (!existsSync(dir)) return results;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			results.push(...collectFilesRecursive(full));
		} else {
			results.push(full);
		}
	}
	return results;
}

describe('M2 Tahap 2B: UI Mobile (/m/*), Watermark Canvas, Kompresi 1280px, GPS Fallback, & Mobile API Client', () => {
	describe('1. Kompresi Dimensi Gambar <= 1280 px (Bagian 9.1)', () => {
		it('mengecilkan gambar landscape dan portrait agar sisi terpanjang tepat 1280 px dengan rasio aspek terjaga', () => {
			expect(computeCompressedDimensions(4000, 3000, 1280)).toEqual({
				width: 1280,
				height: 960
			});

			expect(computeCompressedDimensions(2160, 3840, 1280)).toEqual({
				width: 720,
				height: 1280
			});
		});

		it('tidak memperbesar gambar yang sudah lebih kecil atau sama dengan 1280 px', () => {
			expect(computeCompressedDimensions(800, 600, 1280)).toEqual({
				width: 800,
				height: 600
			});
			expect(computeCompressedDimensions(1280, 720, 1280)).toEqual({
				width: 1280,
				height: 720
			});
		});

		it('menolak dimensi gambar 0 atau negatif', () => {
			expect(() => computeCompressedDimensions(0, 500)).toThrowError(
				/Dimensi gambar sumber tidak valid/
			);
			expect(() => computeCompressedDimensions(500, -10)).toThrowError(
				/Dimensi gambar sumber tidak valid/
			);
		});
	});

	describe('2. Pembuatan 6 Baris Watermark & Render Canvas 2D (Bagian 9.1)', () => {
		it('membentuk 6 baris watermark lengkap dengan koordinat dan akurasi saat GPS tersedia', () => {
			const lines = formatWatermarkLines({
				actionLabel: 'PINJAM',
				assetName: 'Laptop Dell 5420',
				assetCode: 'AST-0042',
				userName: 'Budi Peminjam',
				takenAt: new Date('2026-11-19T07:32:00Z'),
				gpsAvailable: true,
				latitude: 3.5952,
				longitude: 98.6722,
				accuracyM: 12.4,
				locationName: 'Ruang Seminar A'
			});

			expect(lines).toHaveLength(6);
			expect(lines[0]).toBe('Aksi: PINJAM');
			expect(lines[1]).toBe('Barang: Laptop Dell 5420 · AST-0042');
			expect(lines[2]).toBe('Pengguna: Budi Peminjam');
			expect(lines[3]).toContain('2026');
			expect(lines[4]).toBe('Koordinat: 3.5952, 98.6722 (±12 m)');
			expect(lines[5]).toBe('Lokasi: Ruang Seminar A');
		});

		it('menampilkan "GPS tidak tersedia" pada baris koordinat dan tetap mencantumkan lokasi manual (BR-06)', () => {
			const lines = formatWatermarkLines({
				actionLabel: 'KEMBALI',
				assetName: 'Proyektor Epson',
				assetCode: 'AST-0009',
				userName: 'Siti Petugas',
				takenAt: new Date('2026-11-23T04:00:00Z'),
				gpsAvailable: false,
				latitude: null,
				longitude: null,
				locationName: 'Gudang IT Pusat'
			});

			expect(lines).toHaveLength(6);
			expect(lines[0]).toBe('Aksi: KEMBALI');
			expect(lines[4]).toBe('Koordinat: GPS tidak tersedia');
			expect(lines[5]).toBe('Lokasi: Gudang IT Pusat');
		});

		it('menggambar latar belakang gelap dan ke-6 baris teks ke Canvas 2D context', () => {
			const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
			const texts: Array<{ text: string; x: number; y: number }> = [];

			const mockCtx: Canvas2DWatermarkTarget = {
				fillStyle: '',
				font: '',
				textBaseline: 'alphabetic',
				fillRect(x, y, w, h) {
					rects.push({ x, y, w, h });
				},
				fillText(text, x, y) {
					texts.push({ text, x, y });
				}
			};

			const lines = formatWatermarkLines({
				actionLabel: 'PINJAM',
				assetName: 'Kamera Sony',
				assetCode: 'AST-0101',
				userName: 'Budi',
				takenAt: new Date(),
				gpsAvailable: false,
				locationName: 'Ruang Seminar A'
			});

			drawWatermarkToContext(mockCtx, 1280, 960, lines);

			expect(rects).toHaveLength(1);
			expect(rects[0].w).toBe(1280);
			expect(rects[0].y).toBeGreaterThan(0);
			expect(texts).toHaveLength(6);
			expect(texts[0].text).toBe('Aksi: PINJAM');
			expect(texts[5].text).toBe('Lokasi: Ruang Seminar A');
		});
	});

	describe('3. Pencarian Lokasi Resmi Terdekat & Pesan Error Bahasa Indonesia untuk Pengguna Awam', () => {
		it('memilih lokasi resmi terdekat berdasarkan koordinat GPS', () => {
			const locations = [
				{
					id: 'loc-a',
					name: 'Ruang Seminar A',
					latitude: -6.2,
					longitude: 106.8166,
					radiusM: 100
				},
				{
					id: 'loc-b',
					name: 'Gedung Cabang Bandung',
					latitude: -6.9175,
					longitude: 107.6191,
					radiusM: 100
				}
			];

			const nearest = findNearestLocation(-6.2002, 106.8167, locations);
			expect(nearest).not.toBeNull();
			expect(nearest?.location.id).toBe('loc-a');
			expect(nearest?.withinRadius).toBe(true);
		});

		it('mengubah kode error server menjadi kalimat Bahasa Indonesia yang ramah bagi pengguna awam', () => {
			expect(
				formatFriendlyErrorMessage({
					error: {
						code: 'ASSET_NOT_AVAILABLE',
						message: 'Not available',
						details: { currentHolder: 'Andi Saputra' }
					}
				})
			).toBe('Barang ini sedang dipinjam oleh Andi Saputra dan belum dikembalikan.');

			expect(
				formatFriendlyErrorMessage({
					error: { code: 'ALREADY_BORROWED_CONFLICT', message: 'Conflict' }
				})
			).toContain('baru saja dipinjam oleh orang lain');

			expect(
				formatFriendlyErrorMessage({
					error: { code: 'MOCK_LOCATION_BLOCKED', message: 'Mock' }
				})
			).toContain('Lokasi palsu');
		});
	});

	describe('4. Kepatuhan Arsitektur SPA Mobile (/m/*) & Tidak Ada fetch() Langsung', () => {
		it('menjalankan /m/* dengan ssr = false, tanpa +page.server.ts, dan semua request memakai mobileApi', () => {
			expect(mobileLayoutConfig.ssr).toBe(false);

			const mobileRoutesDir = resolve(process.cwd(), 'src/routes/m');
			const allMobileFiles = collectFilesRecursive(mobileRoutesDir);
			const serverFiles = allMobileFiles.filter(
				(f) => f.endsWith('+page.server.ts') || f.endsWith('+layout.server.ts')
			);
			expect(serverFiles).toEqual([]);

			// Pastikan tidak ada pemanggilan fetch( langsung di seluruh file di bawah src/routes/m/
			for (const filePath of allMobileFiles) {
				const content = readFileSync(filePath, 'utf8');
				expect(content).not.toMatch(/\bfetch\s*\(/);
			}
		});
	});

	describe('5. Manajemen Sesi & Klien API Terpusat (src/lib/client/api.ts)', () => {
		it('otomatis memanggil /api/v1/auth/refresh satu kali saat menerima 401, lalu mengulang request asli dengan Bearer token baru', async () => {
			const storage = createMemoryTokenStorage({
				accessToken: 'expired-access-token',
				refreshToken: 'valid-refresh-token-1'
			});

			const calls: Array<{ url: string; authHeader: string | null }> = [];
			let unauthorizedCount = 0;

			const mockFetch: typeof fetch = async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers ?? {});
				const authHeader = headers.get('authorization');
				calls.push({ url, authHeader });

				if (url === 'https://api.itam.test/api/v1/auth/refresh') {
					const body = JSON.parse(String(init?.body ?? '{}'));
					expect(body.refreshToken).toBe('valid-refresh-token-1');
					return new Response(
						JSON.stringify({
							accessToken: 'fresh-access-token-2',
							refreshToken: 'fresh-refresh-token-2'
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					);
				}

				if (authHeader === 'Bearer expired-access-token') {
					return new Response(
						JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }),
						{ status: 401, headers: { 'content-type': 'application/json' } }
					);
				}

				if (authHeader === 'Bearer fresh-access-token-2') {
					return new Response(JSON.stringify({ ok: true, data: 'loan-saved' }), {
						status: 201,
						headers: { 'content-type': 'application/json' }
					});
				}

				return new Response('Unexpected', { status: 500 });
			};

			const client = createMobileApiClient({
				baseUrl: 'https://api.itam.test',
				fetchFn: mockFetch,
				storage,
				onUnauthorized: () => {
					unauthorizedCount += 1;
				}
			});

			const res = await client.post('/api/v1/loans', { purpose: 'Seminar' });
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.data).toBe('loan-saved');
			expect(unauthorizedCount).toBe(0);

			// Urutan panggilan: 1) POST /loans (401) -> 2) POST /auth/refresh (200) -> 3) POST /loans retry (201)
			expect(calls).toHaveLength(3);
			expect(calls[0]).toEqual({
				url: 'https://api.itam.test/api/v1/loans',
				authHeader: 'Bearer expired-access-token'
			});
			expect(calls[1].url).toBe('https://api.itam.test/api/v1/auth/refresh');
			expect(calls[2]).toEqual({
				url: 'https://api.itam.test/api/v1/loans',
				authHeader: 'Bearer fresh-access-token-2'
			});

			// Token baru tersimpan di storage
			const stored = await storage.getTokens();
			expect(stored).toEqual({
				accessToken: 'fresh-access-token-2',
				refreshToken: 'fresh-refresh-token-2'
			});
		});

		it('hanya memicu tepat SATU refresh (single-flight) ketika banyak request paralel terkena 401 bersamaan', async () => {
			const storage = createMemoryTokenStorage({
				accessToken: 'expired-token-parallel',
				refreshToken: 'refresh-token-parallel-1'
			});

			let refreshCallCount = 0;

			const mockFetch: typeof fetch = async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers ?? {});
				const auth = headers.get('authorization');

				if (url.endsWith('/api/v1/auth/refresh')) {
					refreshCallCount += 1;
					await new Promise((r) => setTimeout(r, 30));
					return new Response(
						JSON.stringify({
							accessToken: 'new-parallel-access-token',
							refreshToken: 'new-parallel-refresh-token'
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					);
				}

				if (auth === 'Bearer expired-token-parallel') {
					return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
						status: 401
					});
				}

				if (auth === 'Bearer new-parallel-access-token') {
					return new Response(JSON.stringify({ url, status: 'ok' }), { status: 200 });
				}

				return new Response('Unexpected', { status: 500 });
			};

			const client = createMobileApiClient({
				baseUrl: 'http://localhost:5173',
				fetchFn: mockFetch,
				storage
			});

			// Jalankan 5 request secara paralel yang semuanya gagal 401 pada percobaan pertama
			const responses = await Promise.all([
				client.get('/api/v1/assets/by-code/AST-0001'),
				client.get('/api/v1/locations?onlyActive=true'),
				client.get('/api/v1/auth/me'),
				client.get('/api/v1/loans?pageSize=20'),
				client.get('/api/v1/categories')
			]);

			for (const res of responses) {
				expect(res.status).toBe(200);
			}

			// Meskipun ada 5 request paralel yang kena 401, endpoint /api/v1/auth/refresh wajib hanya dipanggil 1 kali
			expect(refreshCallCount).toBe(1);
		});

		it('menghapus token dan memicu redirect/callback ke login saat refresh gagal (401)', async () => {
			const storage = createMemoryTokenStorage({
				accessToken: 'expired-access-token',
				refreshToken: 'revoked-refresh-token'
			});

			let redirectedToLogin = false;
			let refreshCalls = 0;

			const mockFetch: typeof fetch = async (input) => {
				const url = String(input);
				if (url.endsWith('/api/v1/auth/refresh')) {
					refreshCalls += 1;
					return new Response(
						JSON.stringify({
							error: { code: 'UNAUTHENTICATED', message: 'Sesi telah dicabut.' }
						}),
						{ status: 401, headers: { 'content-type': 'application/json' } }
					);
				}

				return new Response(
					JSON.stringify({
						error: { code: 'UNAUTHENTICATED', message: 'Token expired.' }
					}),
					{ status: 401, headers: { 'content-type': 'application/json' } }
				);
			};

			const client = createMobileApiClient({
				baseUrl: 'http://localhost:5173',
				fetchFn: mockFetch,
				storage,
				onUnauthorized: () => {
					redirectedToLogin = true;
				}
			});

			const res = await client.get('/api/v1/loans');
			expect(res.status).toBe(401);
			expect(refreshCalls).toBe(1);
			expect(redirectedToLogin).toBe(true);
			expect(await storage.getTokens()).toBeNull();
		});
	});
});
