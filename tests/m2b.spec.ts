import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	computeCompressedDimensions,
	drawWatermarkToContext,
	findNearestLocation,
	formatFriendlyErrorMessage,
	formatWatermarkLines,
	type Canvas2DWatermarkTarget
} from '../src/lib/shared/mobile/watermark';
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

describe('M2 Tahap 2B: UI Mobile (/m/*), Watermark Canvas, Kompresi 1280px, GPS Fallback, & Pesan Error Awam', () => {
	describe('1. Kompresi Dimensi Gambar <= 1280 px (Bagian 9.1)', () => {
		it('mengecilkan gambar landscape dan portrait agar sisi terpanjang tepat 1280 px dengan rasio aspek terjaga', () => {
			// Landscape 4000 x 3000 -> 1280 x 960
			expect(computeCompressedDimensions(4000, 3000, 1280)).toEqual({
				width: 1280,
				height: 960
			});

			// Portrait 2160 x 3840 -> 720 x 1280
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

	describe('4. Kepatuhan Arsitektur SPA Mobile (/m/* — Bagian 4.4)', () => {
		it('menjalankan /m/* dengan ssr = false dan tanpa file +page.server.ts atau +layout.server.ts', () => {
			expect(mobileLayoutConfig.ssr).toBe(false);

			const mobileRoutesDir = resolve(process.cwd(), 'src/routes/m');
			const allMobileFiles = collectFilesRecursive(mobileRoutesDir);
			const serverFiles = allMobileFiles.filter(
				(f) => f.endsWith('+page.server.ts') || f.endsWith('+layout.server.ts')
			);
			expect(serverFiles).toEqual([]);
		});
	});
});
