# Catatan Deviasi dan Penyesuaian Teknis (DEVIATIONS)

Dokumen ini mencatat penyesuaian teknis terhadap lingkungan pengembangan atau perilaku library sesuai aturan **Bagian 0 butir 11 `PROJECT_SPEC.md`**.

## 1. Lingkungan Database Lokal & Verifikasi Stack Docker (M0 & Pra-M4C)

- **Konteks:** Kriteria penerimaan M0 dan Bagian 16 `PROJECT_SPEC.md` menetapkan jalannya stack melalui `docker compose up -d --build` (aplikasi SvelteKit Node, PostgreSQL 18, dan reverse proxy Caddy) beserta migrasi dan constraint SQL.
- **Kondisi Lingkungan Host:**
  1. Pada saat M0 dikerjakan, Docker belum terpasang di mesin host sehingga disediakan skrip `scripts/local-pg.mjs` (`npm run db:local:start` / `npm run db:local:stop`) yang menjalankan cluster PostgreSQL 18 lokal di `.pgdata` (port `5433`) untuk keperluan `npm run dev` dan `npm test`.
  2. **Pembaruan Pra-M4C:** Docker Desktop (`Docker 29.9.3` & `Docker Compose v5.7.0`) kini telah terpasang di mesin pengembangan. Seluruh stack `docker compose up -d --build` (`app`, `db` dengan `postgres:18-alpine`, dan `caddy` dengan `caddy:2.9-alpine`) telah diverifikasi berjalan penuh dari awal.
- **Konfigurasi Stack Docker & Mode Dev:**
  1. Hanya kontainer `caddy` yang mempublikasikan port ke host (`80` dan `443`), sedangkan `db` dan `app` berjalan eksklusif di jaringan internal Docker.
  2. Data PostgreSQL 18 disimpan pada volume persisten `pgdata` (`PGDATA=/var/lib/postgresql/data/pgdata`) dan foto bukti disimpan pada volume persisten `evidence_data` (`/app/.storage`), sehingga keduanya tetap utuh saat kontainer dibuat ulang (`--force-recreate`).
  3. Mode pengembangan lokal dengan PostgreSQL 18 port `5433` (`scripts/local-pg.mjs`) tetap dipertahankan agar `npm test` (Vitest) dan `npm run dev` dapat berjalan cepat tanpa tergantung pada kontainer yang sedang menyala.

## 2. Versi Prisma ORM (M0)

- **Konteks:** Bagian 5.1 menyebutkan bahwa blok `datasource db { provider = "postgresql" url = env("DATABASE_URL") }` mengikuti gaya Prisma yang umum.
- **Keputusan:** Proyek menggunakan **Prisma v6 (`^6.6.0`)** agar `prisma/schema.prisma` tetap 100% kompatibel dengan skema pada Bagian 5.1 tanpa memerlukan perubahan struktur konfigurasi baru pada Prisma 7.

## 3. Penghapusan `JWT_REFRESH_SECRET` dari `.env.example`

- **Konteks:** Contoh `.env.example` pada Bagian 16.4 mencantumkan `JWT_REFRESH_SECRET=`, sedangkan Bagian 5.1 (`Session.refreshTokenHash`) dan Bagian 12 menetapkan bahwa refresh token disimpan sebagai hash di tabel `Session` dan dapat dicabut.
- **Keputusan:** Refresh token diimplementasikan sebagai _opaque token_ acak kriptografis 48 byte (`randomBytes(48).toString('base64url')`) yang di-hash dengan SHA-256 (`refreshTokenHash`), bukan JWT. Oleh karena itu `JWT_REFRESH_SECRET` tidak diperlukan dan dihapus dari `.env.example` serta `docs/DEPLOY.md`.

## 4. Storage Foto Privat dengan Volume Persisten & Signed URL (M2 Tahap 2A & Pra-M4C)

- **Konteks:** Bagian 4.2, 9.1, dan 12 menetapkan bahwa foto bukti disimpan di storage privat (bukan URL publik), divalidasi hanya JPEG (maks 5 MB), dan ditampilkan melalui _signed URL_ berumur pendek (5 menit).
- **Solusi & Mitigasi:**
  1. Modul `src/lib/server/storage/index.ts` menyimpan berkas JPEG tervalidasi (cek magic bytes `FF D8 FF` dan ukuran `<= 5 MB`) di direktori privat `.storage/evidence/` (dikecualikan oleh `.gitignore` dan `.dockerignore`, serta berada di luar folder statis web). Pada deployment Docker, direktori `/app/.storage` di-mount ke named volume persisten `evidence_data` sehingga berkas foto tetap aman saat kontainer `app` dibuat ulang atau diperbarui.
  2. _Signed URL_ dibuat dengan tanda tangan kriptografis HMAC-SHA256 berumur 5 menit (`/api/v1/evidence/{id}/file?expires=...&sig=...`) menggunakan kunci khusus `EVIDENCE_SIGNING_SECRET` dan diverifikasi dengan `timingSafeEqual`. Akses tanpa tanda tangan atau setelah kedaluwarsa ditolak dengan `403 FORBIDDEN`.

## 5. Penyimpanan Antrean Operasi Offline dengan IndexedDB (M4 Tahap 4B)

- **Konteks:** Bagian 4.1 dan 10.2 `PROJECT_SPEC.md` menyebutkan penyimpanan antrean lokal di HP menggunakan Capacitor SQLite / Preferences.
- **Kondisi Lingkungan & Tahap Pengujian:** Pada Tahap 4B, aplikasi lapangan `/m/*` diuji langsung di browser Chrome HP melalui USB port forwarding tanpa membangun APK Capacitor terlebih dahulu. Plugin native `@capacitor-community/sqlite` memerlukan container native Android atau setup WASM khusus.
- **Solusi & Mitigasi:**
  1. Dibuat satu lapisan abstraksi `OfflineQueueStorage` di `src/lib/client/offlineQueue.ts` (sejajar dengan `TokenStorageAdapter` di `src/lib/client/tokenStorage.ts`) dengan fungsi `setOfflineQueueStorage(adapter)`.
  2. Implementasi default di browser menggunakan **IndexedDB** (`itam_offline_queue_db`, object store `offline_operations`) yang mampu menyimpan payload operasi beserta foto bukti terkompresi secara persisten lintas _reload_ halaman dan saat browser HP berada dalam mode _offline_.
  3. Untuk pengujian otomatis di Node/Vitest disediakan `createMemoryOfflineQueueStorage()`, dan saat pembungkusan APK Android nanti adapter dapat diganti ke Capacitor SQLite tanpa mengubah kode layar `/m/*` maupun `syncManager.ts`.
