# Panduan Deploy dan Pembaruan (DEPLOY)

## 1. Prasyarat Server (VPS)

- OS: Linux (Ubuntu 22.04/24.04 LTS disarankan), minimal 2 GB RAM.
- Terpasang: Docker Engine dan Docker Compose plugin (`docker compose`).
- Domain (mis. `aset.example.com`) sudah diarahkan (A record) ke IP publik VPS.

## 2. Langkah Deploy Awal

1. Salin repositori ke server dan buat berkas `.env` dari `.env.example`:
   ```bash
   cp .env.example .env
   ```
2. Isi seluruh variabel rahasia pada `.env` (`POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `DATABASE_URL`, dll.).
3. Sesuaikan nama domain di `Caddyfile`.
4. Jalankan layanan dengan Docker Compose:
   ```bash
   docker compose up -d --build
   ```
5. Verifikasi kesehatan layanan:
   ```bash
   curl https://aset.example.com/api/v1/health
   ```

## 3. Alur Pembaruan Aplikasi

```bash
git pull origin main
docker compose build app
docker compose run --rm app npx prisma migrate deploy
docker compose up -d app
```

## 4. Backup dan Restore

### Backup Database PostgreSQL

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup_$(date +%F).dump
```

### Restore Database PostgreSQL (di lingkungan uji / pemulihan)

```bash
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup_YYYY-MM-DD.dump
```
