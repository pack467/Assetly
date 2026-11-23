# Panduan Deploy dan Pembaruan (DEPLOY)

## 1. Prasyarat Server (VPS) atau Mesin Host Docker

- OS: Linux (Ubuntu 22.04/24.04 LTS disarankan untuk VPS, minimal 2 GB RAM) atau Windows/macOS dengan Docker Desktop.
- Terpasang: Docker Engine (`>= 24`) dan Docker Compose plugin (`docker compose`).
- Untuk deploy publik di VPS: domain (mis. `aset.example.com`) sudah diarahkan (A record) ke IP publik VPS, dan port `80` serta `443` terbuka di firewall.

## 2. Arsitektur Kontainer & Isolasi Jaringan

Stack `docker-compose.yml` terdiri dari tiga layanan:

1. **`caddy` (`caddy:2.9-alpine`)**: Satu-satunya layanan yang membuka port keluar (`80` dan `443`), meneruskan trafik ke `app:3000`.
2. **`app` (`node:22-alpine`)**: Aplikasi SvelteKit (`@sveltejs/adapter-node`). Tidak mempublikasikan port ke jaringan luar; otomatis menjalankan `npx prisma migrate deploy` saat kontainer menyala.
3. **`db` (`postgres:18-alpine`)**: Database PostgreSQL 18. Tidak mempublikasikan port ke jaringan luar; hanya dapat diakses oleh `app` melalui jaringan internal Docker.

Volume persisten yang menjaga data tetap aman saat kontainer dibuat ulang (`--force-recreate`) atau diperbarui:

- `pgdata`: Menyimpan data database PostgreSQL 18 (`/var/lib/postgresql/data/pgdata`).
- `evidence_data`: Menyimpan berkas foto bukti privat (`/app/.storage/evidence`).
- `caddy_data` & `caddy_config`: Menyimpan sertifikat TLS dan state Caddy.

## 3. Langkah Deploy Awal

1. Salin repositori ke server dan buat berkas `.env` dari `.env.example` (berkas `.env` dikecualikan oleh `.gitignore` dan `.dockerignore` sehingga tidak pernah masuk ke repo maupun ke dalam image Docker):
   ```bash
   cp .env.example .env
   ```
2. Isi variabel wajib pada `.env`:
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `JWT_ACCESS_SECRET` (wajib, minimal 32 karakter acak)
   - `EVIDENCE_SIGNING_SECRET` (wajib, minimal 32 karakter acak, terpisah dari kunci JWT)
   - `CORS_ALLOWED_ORIGINS` (daftar origin terpisah koma tanpa wildcard `*`, mis. `https://localhost,capacitor://localhost`)
   - `CADDY_SITE_ADDRESS` (opsional: biarkan kosong atau `:80` untuk pengujian lokal via `http://localhost`, atau isi dengan nama domain seperti `aset.example.com` pada VPS produksi agar Caddy otomatis menerbitkan sertifikat HTTPS Let's Encrypt).
3. Bangun dan jalankan seluruh stack:
   ```bash
   docker compose up -d --build
   ```
   _(Saat `app` menyala, migrasi Prisma `20261123000001_init` dan `20261123000002_extra_constraints` — termasuk unique partial index `one_active_loan_per_asset`, trigger `audit_log_no_update`, dan CHECK koordinat `evidence_lat_range`/`evidence_lng_range` — dijalankan secara otomatis)._
4. Periksa status kontainer dan kesehatan layanan:
   ```bash
   docker compose ps
   curl http://localhost/api/v1/health
   ```
5. Jalankan _seed_ akun Admin awal dan data master dasar (tanpa menyimpan password di berkas mana pun):
   ```bash
   docker compose exec -T app npm run db:seed
   ```
   - Perintah di atas otomatis membuat akun `admin@itam.local` dengan _password_ acak satu kali (_Generated One-Time Admin Password_) dan _TOTP Base32 Secret_ yang dicetak satu kali ke terminal.
   - Catat _password_ dan daftarkan _TOTP Base32 Secret_ ke aplikasi autentikator (Google Authenticator / Aegis / 2FAS), lalu masuk ke `/admin`.
   - Untuk membuat akun uji `OFFICER` atau `BORROWER`, masuk ke `/admin/users` sebagai Admin lalu tambahkan pengguna baru dari antarmuka web.

## 4. Alur Pembaruan Aplikasi

```bash
git pull origin main
docker compose up -d --build app
```

_(Kontainer `app` yang baru otomatis menjalankan `npx prisma migrate deploy` sebelum menyalakan server Node, sementara data di volume `pgdata` dan `evidence_data` tetap utuh)._

## 5. Backup dan Restore

### Backup Database PostgreSQL 18

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup_$(date +%F).dump
```

### Restore Database PostgreSQL 18 (di lingkungan uji / pemulihan)

```bash
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backup_YYYY-MM-DD.dump
```
