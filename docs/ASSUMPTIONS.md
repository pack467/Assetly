# Daftar Asumsi Proyek (ASSUMPTIONS)

Dokumen ini mencatat semua keputusan terbuka pada **Bagian 21 `PROJECT_SPEC.md`** yang menggunakan nilai bawaan (_default_) sesuai instruksi pemilik proyek, beserta asumsi teknis implementasi.

## 1. Keputusan Terbuka Bagian 21 (Nilai Default Diterapkan)

| No  | Hal                                              | Keputusan / Nilai Default yang Dipakai                                                                                                                                             |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pilihan final frontend/Android                   | **SvelteKit + Capacitor** (satu codebase dengan dua target build: `adapter-node` untuk server/web admin + API, dan `adapter-static` SPA untuk Android `/m/*`).                     |
| 2   | Target hosting                                   | **VPS + Docker Compose + Caddy** (`app`, `db` PostgreSQL 18, `caddy`, dengan volume persisten `pgdata` dan `evidence_data`).                                                       |
| 3   | `RISK_BLOCK_ON_MOCK`                             | **`true`** (memblokir transaksi jika `isMockLocation = true` dengan kode error `MOCK_LOCATION_BLOCKED`; sinyal risiko lain hanya menandai `NEEDS_REVIEW` atau `SUSPICIOUS`).       |
| 4   | Retensi foto dan data lokasi                     | **365 hari** (`EVIDENCE_RETENTION_DAYS=365`). `AuditLog` disimpan tanpa batas waktu.                                                                                               |
| 5   | Kategori yang `requiresApproval`                 | **Semua `false`** secara bawaan sampai diatur oleh `ADMIN` pada master kategori.                                                                                                   |
| 6   | Aturan eskalasi keterlambatan & kanal notifikasi | Mengikuti **Tabel 7.6** (H-1 pengingat ke peminjam, H+0 peringatan ke peminjam, H+3 notifikasi ke admin, H+7 laporan ke penanggung jawab) melalui abstraksi `NotificationService`. |
| 7   | Definisi shift & kewajiban tutup shift           | **Satu shift per hari kerja per petugas**; tutup shift wajib bagi petugas dengan mencatat alasan untuk setiap barang yang masih keluar (`ShiftItem`).                              |
| 8   | Format kolom impor CSV barang                    | Menggunakan **kolom minimal Bagian 18**: `name`, `category`, `serialNumber` (opsional), `homeLocation` (opsional), `purchasedAt` (opsional), `notes` (opsional).                   |
| 9   | Versi Android minimum                            | Mengikuti default Capacitor 7 (**Android 7.0+ / API 24+**, akan divalidasi kembali saat uji HP kelas bawah pada M6).                                                               |
| 10  | Batas waktu konfirmasi serah terima              | **24 jam** — serah terima (`Handover`) yang belum dikonfirmasi kedua pihak setelah 24 jam ditandai di dashboard admin.                                                             |
| 11  | Deteksi mock location di Capacitor               | Diverifikasi pada M2; pada API server (`POST /api/v1/evidence`), field `isMockLocation` sudah disiapkan dan diuji dengan kebijakan `RISK_BLOCK_ON_MOCK`.                           |
| 12  | Admin utama & penanggung jawab data              | Disediakan akun seed `ADMIN` awal untuk inisialisasi; pemilik proyek menetapkan personil sebelum pilot.                                                                            |
| 13  | Aturan tanggung jawab tertulis                   | Disusun pemilik pada SOP non-teknis; aplikasi menyediakan jejak bukti (`Evidence`), `Handover`, dan `AuditLog` yang tidak dapat diubah.                                            |

## 2. Asumsi Teknis Tambahan (M0)

1. **Masa berlaku token & pencabutan sesi instan (Bagian 12):**
   - Access token (JWT HS256) berlaku **15 menit** dan memuat klaim `sid` (`Session.id`). Variabel `JWT_ACCESS_SECRET` dimuat melalui `$env/dynamic/private` SvelteKit dan divalidasi wajib minimal **32 karakter**.
   - Penandatanganan _signed URL_ foto bukti (`Evidence`) dipisahkan dari kunci JWT menggunakan variabel khusus `EVIDENCE_SIGNING_SECRET` (HMAC-SHA256, wajib minimal **32 karakter**).
   - Refresh token berlaku **30 hari**, dibangkitkan sebagai token acak kriptografis 48 byte (`randomBytes(48).toString('base64url')`), disimpan sebagai hash SHA-256 (`refreshTokenHash`) di tabel `Session`, dan dirotasi setiap kali `/api/v1/auth/refresh` dipanggil. Karena refresh token bersifat _opaque_ (bukan JWT), variabel `JWT_REFRESH_SECRET` dihapus dari `.env.example` agar tidak membingungkan.
   - Setiap request terautentikasi memverifikasi status `Session` (`revokedAt IS NULL` dan `expiresAt > now()`) serta `User.isActive = true` sehingga pencabutan sesi oleh admin berlaku **segera** pada permintaan berikutnya.
2. **Pembatasan percobaan login (Rate Limit - Bagian 12):**
   - Maksimal **5 percobaan gagal per 15 menit** per kombinasi email/IP; percobaan ke-6 mengembalikan HTTP `429` dengan kode error baku `RATE_LIMITED`.
3. **Verifikasi dua langkah (TOTP - BR-19):**
   - Akun `ADMIN` yang sudah memiliki `mfaSecret` wajib menyertakan `totpCode` 6 digit saat login. Pendaftaran/aktivasi TOTP admin dikelola pada M1.
4. **Konfigurasi CORS Ketat untuk Capacitor (Bagian 12):**
   - Origin aplikasi Android Capacitor (`https://localhost` dan `capacitor://localhost`) dikontrol melalui variabel lingkungan `CORS_ALLOWED_ORIGINS` (daftar eksplisit dipisahkan koma, termasuk penanganan preflight `OPTIONS`). Penggunaan wildcard (`*`) ditolak secara otomatis oleh server.
5. **Perpindahan Pemegang Barang Setelah Serah Terima Dikonfirmasi Dua Pihak (Pilihan a — Bagian 7.2):**
   - Setelah kedua pihak (`giver` dan `receiver`) mengonfirmasi `Handover`, pemegang barang aktif (`Loan.borrowerId`) berpindah ke pihak penerima (`receiverId`) dalam transaksi yang sama beserta pencatatan `AuditLog` (`LOAN_HOLDER_TRANSFERRED`).
   - Konsekuensinya: `currentHolder` pada info barang, daftar "Pinjaman Saya", hak pengembalian barang, `responsibleUserId` bawaan saat tutup shift (BR-12), dan proteksi penonaktifan user pemegang barang (`USER_HOLDS_ASSETS`, BR-16) otomatis mengikuti pemegang baru.
6. **Perilaku Antrean Offline pada Serah Terima (`/m/handovers`) dan Shift (`/m/shifts`) (Bagian 7.2, 7.4, 10.2, & BR-12):**
   - **Pembuatan Serah Terima (`HANDOVER_CREATE`) & Foto ber-GPS:** Mengambil koordinat GPS perangkat (`acquireGpsOnce`) untuk watermark serta metadata `Evidence`, lalu menyimpan operasi dan foto bukti ke antrean offline (`enqueueOfflineOperation`) untuk diunggah di latar belakang.
   - **Konfirmasi Serah Terima oleh Pihak Lain (`HANDOVER_CONFIRM`):** Bersifat _online-only_ karena harus memverifikasi status `Loan` aktif secara real-time, memindahkan pemegang (`Loan.borrowerId`), membatalkan handover gantung lain (`SUPERSEDED`), dan menerbitkan `documentNo` resmi. Bila ditekan saat offline, UI menampilkan pesan bahasa Indonesia yang jelas agar pengguna menyambungkan koneksi terlebih dahulu.
   - **Buka & Tutup Shift (`SHIFT_OPEN` & `SHIFT_CLOSE`) serta Jalur Darurat (Lapis 1 & Lapis 2):**
     - **Lapis 1 (Antre `SHIFT_CLOSE` Saat Masih Ada Operasi Barang Tertunda):** Barang dalam payload `SHIFT_CLOSE` dapat diidentifikasi melalui `loanItemId`, `assetId`, atau `assetCode`. Saat petugas mengantrekan `LOAN_CREATE` secara offline lalu menutup shift (`SHIFT_CLOSE`), server memproses batch berurutan berdasarkan `clientCreatedAt` sehingga `LOAN_CREATE` membuat `LoanItem` terlebih dahulu dan `SHIFT_CLOSE` mencocokkan `assetId` tersebut ke `LoanItem` yang baru dibuat. Alasan untuk barang yang ternyata sudah dikembalikan sebelum tutup shift diabaikan (bukan error). Bila saat `SHIFT_CLOSE` diproses masih ada barang keluar yang belum memiliki alasan, server menolak (`REJECTED`) dengan menyebutkan kode barang yang butuh alasan (tanpa mengisi alasan otomatis), dan layar `/m/sync` menyediakan form untuk melengkapi alasan tersebut lalu mengirim ulang.
     - **Lapis 2 (Tutup Shift Darurat oleh ADMIN):** Bila perangkat petugas mati/hilang sinyal permanen, hanya `ADMIN` yang dapat menutup shift atas nama petugas dengan mengisi `emergencyCloseReason` wajib (minimal 10 karakter) beserta alasan per barang keluar. Tindakan ini dicatat di `AuditLog` (`SHIFT_FORCE_CLOSED_BY_ADMIN`), ditampilkan pada "Catatan Shift Sebelumnya" bagi petugas berikutnya, dan mengubah `SHIFT_CLOSE` susulan dari HP petugas yang menyala kembali menjadi `CONFLICT`.
7. **Penilaian Risiko Waktu Foto Offline (`CLOCK_SKEW` & `IMPOSSIBLE_JUMP`) dan Pelacakan `Session.lastSeenAt` (Bagian 9.2, 9.4, & 10.2):**
   - Klien mengirimkan `uploadedAtDevice` (jam dinding HP saat foto diunggah) di samping `takenAtDevice` (jam HP saat foto diambil).
   - Server menghitung:
     - **(a) Selisih jam HP saat unggah:** `|receivedAtServer - uploadedAtDevice|` untuk mendeteksi jam HP yang memang melenceng saat mengunggah.
     - **(b) Batas durasi offline yang sah:** klaim lama offline (`uploadedAtDevice - takenAtDevice`) dibatasi oleh `(receivedAtServer - lastOnlineActivityAtServer) + 15 menit toleransi`, dengan syarat `takenAtDevice` tidak berada di masa depan (> 60 detik) dan tidak lebih tua dari `takenAtDevice` bukti terakhir pengguna yang sama.
   - `lastOnlineActivityAtServer` dihitung sebagai `max(Session.lastSeenAt, waktu efektif bukti terakhir)` di mana waktu efektif bukti terakhir adalah `Evidence.receivedAtServer - Evidence.offlineDelaySec`. Kolom `Session.lastSeenAt` diperbarui saat login, `refreshUserSession`, serta saat request `/api/v1/sync` dan `/api/v1/evidence` berhasil terautentikasi.
   - Selisih jam efektif (`clockSkewSec`), selisih mentah (`rawClockSkewSec`), dan lama antrean offline terverifikasi (`offlineDelaySec`) disimpan di tabel `Evidence` dan ditampilkan di halaman peminjaman Admin (`/admin/loans`).
   - Perhitungan kecepatan `IMPOSSIBLE_JUMP` memakai waktu pengambilan efektif yang sudah dibatasi (`receivedAtServer - offlineDelaySec`), sedangkan waktu resmi pengembalian barang (`LoanItem.returnedAt`) selalu memakai waktu server.
