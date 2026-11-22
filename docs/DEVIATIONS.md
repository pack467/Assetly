# Catatan Deviasi dan Penyesuaian Teknis (DEVIATIONS)

Dokumen ini mencatat penyesuaian teknis terhadap lingkungan pengembangan atau perilaku library sesuai aturan **Bagian 0 butir 11 `PROJECT_SPEC.md`**.

## 1. Lingkungan Database Lokal Saat Pengembangan (M0)

- **Konteks:** Kriteria penerimaan M0 menyebutkan `docker compose up` serta pengujian migrasi, trigger `audit_log_no_update`, dan unique partial index `one_active_loan_per_asset` langsung di database PostgreSQL.
- **Kondisi Lingkungan Host:** Pada mesin Windows pengembangan saat ini, binary `docker` belum terpasang di `PATH`, namun **PostgreSQL 18 (`C:\Program Files\PostgreSQL\18\bin`)** terpasang secara native.
- **Solusi & Mitigasi:**
  1. Berkas `docker-compose.yml`, `Dockerfile`, dan `Caddyfile` (beserta salinannya di folder `docker/`) tetap dibuat lengkap, tervalidasi, dan siap dijalankan di VPS atau mesin dengan Docker (`docker compose up -d`).
  2. Untuk menjalankan dan menguji database PostgreSQL secara nyata di mesin lokal tanpa mengganggu instance PostgreSQL global pada port 5432, disediakan skrip `scripts/local-pg.mjs` (`npm run db:local:start` / `npm run db:local:stop`) yang menjalankan cluster PostgreSQL 18 terisolasi di `.pgdata` (port `5433`).
  3. Seluruh migrasi Prisma (`prisma migrate deploy`), constraint SQL tambahan, trigger, dan integration test dijalankan terhadap mesin PostgreSQL 18 asli tersebut.
  4. Contoh `docker-compose.yml` pada Bagian 16.2 `PROJECT_SPEC.md` mencantumkan `postgres:16`, namun telah diselaraskan menjadi `postgres:18-alpine` pada `docker-compose.yml` dan `docker/docker-compose.yml` agar versi PostgreSQL di kontainer sama persis dengan versi PostgreSQL 18 yang digunakan di lingkungan pengembangan lokal.

## 2. Versi Prisma ORM (M0)

- **Konteks:** Bagian 5.1 menyebutkan bahwa blok `datasource db { provider = "postgresql" url = env("DATABASE_URL") }` mengikuti gaya Prisma yang umum.
- **Keputusan:** Proyek menggunakan **Prisma v6 (`^6.6.0`)** agar `prisma/schema.prisma` tetap 100% kompatibel dengan skema pada Bagian 5.1 tanpa memerlukan perubahan struktur konfigurasi baru pada Prisma 7.

## 3. Penghapusan `JWT_REFRESH_SECRET` dari `.env.example`

- **Konteks:** Contoh `.env.example` pada Bagian 16.4 mencantumkan `JWT_REFRESH_SECRET=`, sedangkan Bagian 5.1 (`Session.refreshTokenHash`) dan Bagian 12 menetapkan bahwa refresh token disimpan sebagai hash di tabel `Session` dan dapat dicabut.
- **Keputusan:** Refresh token diimplementasikan sebagai _opaque token_ acak kriptografis 48 byte (`randomBytes(48).toString('base64url')`) yang di-hash dengan SHA-256 (`refreshTokenHash`), bukan JWT. Oleh karena itu `JWT_REFRESH_SECRET` tidak diperlukan dan dihapus dari `.env.example` serta `docs/DEPLOY.md`.

## 4. Storage Foto Privat Lokal Tanpa Docker di Windows (M2 Tahap 2A)

- **Konteks:** Bagian 4.2, 9.1, dan 12 menetapkan bahwa foto bukti disimpan di storage privat (bukan URL publik), divalidasi hanya JPEG (maks 5 MB), dan ditampilkan melalui _signed URL_ berumur pendek (5 menit).
- **Kondisi Lingkungan Host:** Pada mesin Windows pengembangan tanpa Docker, menjalankan container MinIO belum dapat dilakukan langsung.
- **Solusi & Mitigasi:**
  1. Modul `src/lib/server/storage/index.ts` menyimpan berkas JPEG tervalidasi (cek magic bytes `FF D8 FF` dan ukuran `<= 5 MB`) di direktori privat `.storage/evidence/` (dikecualikan oleh `.gitignore` dan berada di luar folder statis web).
  2. _Signed URL_ dibuat dengan tanda tangan kriptografis HMAC-SHA256 berumur 5 menit (`/api/v1/evidence/{id}/file?expires=...&sig=...`) dan diverifikasi dengan `timingSafeEqual`. Akses tanpa tanda tangan atau setelah kedaluwarsa ditolak dengan `403 FORBIDDEN`.
