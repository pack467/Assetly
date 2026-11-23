# Panduan Deploy dan Pembaruan (DEPLOY)

## 1. Prasyarat Server (VPS) atau Mini PC Host Docker

- OS: Linux (Ubuntu 22.04/24.04 LTS disarankan untuk VPS/Mini PC, minimal 2 GB RAM) atau Windows/macOS dengan Docker Desktop.
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
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` (**wajib diisi**; `docker-compose.yml` menggunakan validasi `${VAR:?pesan}` tanpa nilai bawaan `"postgres"` dan akan menolak menyala bila salah satu kosong).
   - `JWT_ACCESS_SECRET` (wajib, minimal 32 karakter acak).
   - `EVIDENCE_SIGNING_SECRET` (wajib, minimal 32 karakter acak, terpisah dari kunci JWT).
   - `CORS_ALLOWED_ORIGINS` (daftar origin terpisah koma tanpa wildcard `*`, mis. `https://localhost,capacitor://localhost`).
   - `CADDY_SITE_ADDRESS` (opsional: biarkan kosong atau `:80` untuk akses lokal di mesin yang sama via `http://localhost`, atau isi sesuai opsi HTTPS di Bagian 6).
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

---

## 6. Akses HTTPS untuk Jaringan Lokal (Cookie `Secure` & Efek ke APK Android)

### Mengapa HTTPS Wajib untuk Akses Selain `http://localhost`?

1. **Cookie Web Admin (`Secure: true`):** Pada container produksi (`NODE_ENV=production`), cookie sesi `itam_access` dan `itam_refresh` selalu dikirim dengan atribut `Secure`. Browser mengizinkan cookie `Secure` pada `http://localhost` (di mesin yang sama), tetapi **menolak menyimpan cookie `Secure` pada `http://<IP-LAN>`** (mis. `http://192.168.1.50/admin`), sehingga login web admin dari perangkat lain di LAN tidak akan bertahan tanpa HTTPS.
2. **Keamanan APK Android & Kamera/GPS Browser:** Android 9+ secara bawaan menolak trafik HTTP biasa (_cleartext traffic_) dari dalam APK, dan WebView Capacitor berjalan di origin `https://localhost` (sehingga memanggil `http://<IP-LAN>` dari WebView HTTPS akan diblokir sebagai _Mixed Content_).

Berikut adalah **3 opsi penyediaan HTTPS** untuk server di jaringan lokal (mis. satu mini PC rumahan):

---

### Opsi 1: Domain Resmi + Let's Encrypt (DNS-01 Challenge / Split-DNS)

- **Cara Kerja:** Menggunakan domain/subdomain milik sendiri (mis. `itam.domainanda.id`). Di jaringan rumah yang tidak memiliki IP publik statis atau port 80/443 tertutup ISP (CGNAT), Caddy memvalidasi kepemilikan domain lewat **DNS-01 Challenge** (API Cloudflare/Porkbun/dll.) untuk mendapatkan sertifikat Let's Encrypt resmi, sementara router lokal atau DNS menunjuk `itam.domainanda.id` ke IP LAN mini PC (mis. `192.168.1.50`).
- **Kelebihan:**
  - Sertifikat TLS dipercaya secara bawaan oleh **semua browser dan semua HP Android** tanpa perlu memasang sertifikat CA manual di perangkat pengguna.
  - Tetap bekerja penuh di Wi-Fi lokal dengan kecepatan LAN meskipun internet rumah sedang putus (selama DNS lokal/hosts meresolusi ke IP LAN).
- **Kekurangan:**
  - Memerlukan kepemilikan domain berbayar (Rp100–200 ribu/tahun) dan token API DNS provider, serta build custom image Caddy dengan plugin DNS (`xcaddy`) atau pemakaian `acme.sh` / Certbot DNS.
- **Efek ke APK Android:**
  - **Kepercayaan Sertifikat:** Langsung dipercaya oleh OS Android dan WebView Capacitor tanpa konfigurasi khusus (`network_security_config.xml` tidak perlu diubah).
  - **CORS & Base URL:** `PUBLIC_API_BASE_URL=https://itam.domainanda.id`, dan `CORS_ALLOWED_ORIGINS=https://localhost,capacitor://localhost,https://itam.domainanda.id`.

---

### Opsi 2: Tailscale HTTPS (`tailscale cert` / MagicDNS `.ts.net`)

- **Cara Kerja:** Memasang Tailscale (gratis untuk penggunaan personal/tim kecil) di mini PC dan perangkat pengakses. Tailscale menyediakan nama domain unik `https://<nama-minipc>.<tailnet>.ts.net` beserta sertifikat TLS resmi dari **Let's Encrypt** melalui `tailscale cert` atau `tailscale serve`.
- **Kelebihan:**
  - **Gratis** (tidak perlu membeli domain) dan menggunakan sertifikat **Let's Encrypt asli** yang langsung dipercaya oleh browser maupun OS Android.
  - Tidak perlu membuka port (_port forwarding_) di router rumah dan tetap bisa diakses dari luar jaringan Wi-Fi rumah (mis. lewat data seluler 4G/5G) secara terenkripsi.
- **Kekurangan:**
  - Setiap HP atau laptop yang ingin mengakses server wajib memasang dan menyalakan aplikasi **Tailscale** yang tergabung dalam _tailnet_ (atau dibagikan via _Node Sharing_).
- **Efek ke APK Android:**
  - **Kepercayaan Sertifikat:** Karena sertifikat `.ts.net` diterbitkan oleh Let's Encrypt publik, APK Android langsung mempercayainya tanpa perlu memasang Root CA di HP dan tanpa mengubah `network_security_config.xml`.
  - **CORS & Base URL:** `PUBLIC_API_BASE_URL=https://<nama-minipc>.<tailnet>.ts.net`, dan `CORS_ALLOWED_ORIGINS=https://localhost,capacitor://localhost,https://<nama-minipc>.<tailnet>.ts.net`.

---

### Opsi 3: CA Internal Caddy (`tls internal` pada IP LAN)

- **Cara Kerja:** Mengatur `Caddyfile` untuk melayani `https://192.168.x.x` dengan direktif `tls internal`. Caddy otomatis membangkitkan Root CA lokal (`pki/authorities/local/root.crt` di volume `caddy_data`) dan menandatangani sertifikat TLS untuk IP LAN mini PC.
- **Kelebihan:**
  - **100% mandiri (_offline-ready_)**: tidak memerlukan domain, tidak memerlukan akun pihak ketiga, dan tidak perlu memasang aplikasi VPN/Tailscale di HP.
- **Kekurangan:**
  - Browser dan HP akan menampilkan peringatan sertifikat tidak dikenal sampai berkas `root.crt` dari Caddy diunduh dan dipasang secara manual ke setiap perangkat.
- **Efek ke APK Android:**
  - **Kepercayaan Sertifikat (Penting):** Sejak Android 7.0 (API 24+), aplikasi/APK secara bawaan **mengabaikan sertifikat CA yang dipasang pengguna (_User CA_)** dan hanya mempercayai _System CA_. Agar APK Capacitor mempercayai `root.crt` milik Caddy:
    1. Berkas `root.crt` Caddy harus dipasang di HP Android (_Settings -> Security -> Encryption & credentials -> Install a certificate -> CA certificate_), **DAN**
    2. Proyek Android Capacitor wajib menyertakan `android/app/src/main/res/xml/network_security_config.xml` yang mengizinkan `<certificates src="user" />` (atau melakukan _pinning_ langsung file `root.crt` di `res/raw/caddy_root_ca.crt`), lalu mereferensikannya lewat `android:networkSecurityConfig="@xml/network_security_config"` pada `AndroidManifest.xml`.
  - **CORS & Base URL:** `PUBLIC_API_BASE_URL=https://192.168.x.x`, dan `CORS_ALLOWED_ORIGINS=https://localhost,capacitor://localhost,https://192.168.x.x`.

---

### Ringkasan Perbandingan & Rekomendasi untuk Satu Mini PC Rumahan

| Kriteria                                       | Opsi 1 (Domain + Let's Encrypt) | Opsi 2 (Tailscale `.ts.net`)              | Opsi 3 (CA Internal Caddy)                      |
| :--------------------------------------------- | :------------------------------ | :---------------------------------------- | :---------------------------------------------- |
| **Biaya & Prasyarat**                          | Butuh domain berbayar + DNS API | Gratis, pasang aplikasi Tailscale         | Gratis, tanpa akun/aplikasi luar                |
| **Pasang CA Manual di HP?**                    | Tidak perlu                     | Tidak perlu                               | **Wajib** pasang `root.crt` di HP               |
| **Ubah `network_security_config.xml` di APK?** | Tidak perlu                     | Tidak perlu                               | **Wajib** izinkan User CA / sematkan `root.crt` |
| **Jalan Saat Internet Rumah Mati Total?**      | Ya (dengan DNS lokal)           | Hanya bila _direct peer_ sudah tersambung | **Ya (100% LAN murni)**                         |

#### Rekomendasi untuk Satu Mini PC Rumahan:

1. **Jika semua perangkat berada di Wi-Fi rumah yang sama dan Anda tidak ingin memasang aplikasi tambahan (Tailscale) atau membeli domain:** Pilih **Opsi 3 (CA Internal Caddy `tls internal`)** dengan menyematkan sertifikat `root.crt` Caddy ke dalam `network_security_config.xml` saat mem-build APK Android pada Tahap 4C (sehingga APK langsung mempercayai mini PC, sedangkan di laptop admin cukup memasang `root.crt` sekali).
2. **Jika Anda ingin sertifikat resmi Let's Encrypt tanpa pusing memasang `root.crt` dan sekaligus bisa mengakses mini PC dari luar rumah (4G/5G):** Pilih **Opsi 2 (Tailscale HTTPS)**.
