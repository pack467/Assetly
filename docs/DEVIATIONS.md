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
