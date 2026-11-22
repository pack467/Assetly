# SOP Pengguna Sistem Manajemen Aset IT (ITAM)

> Dokumen ini adalah kerangka awal SOP Pengguna (Bagian 22 `PROJECT_SPEC.md`) dan akan dilengkapi dengan tangkapan layar pada Milestone M6 menjelang pilot.

## 1. Aturan Utama

1. **Barang tanpa scan dianggap belum diserahkan.** Setiap peminjaman, pengembalian, dan serah terima wajib melalui scan QR di aplikasi.
2. **Foto bukti wajib dari kamera langsung.** Ambil foto kondisi barang dengan jelas saat meminjam dan mengembalikan.
3. **Konfirmasi serah terima dua pihak.** Jika barang diserahkan antar petugas atau ke peminjam, kedua pihak wajib menekan tombol konfirmasi.

## 2. Penanganan Kondisi Khusus

- **Sinyal lemah atau mati:** Tetap lakukan scan, foto, dan simpan seperti biasa. Aplikasi akan menyimpan ke antrean lokal dan mengirim otomatis saat sinyal kembali.
- **Label QR rusak:** Gunakan fitur pencarian kode manual (mis. `AST-0042`) di layar Scan, lalu laporkan ke Admin untuk cetak ulang QR.
- **GPS tidak terbaca di dalam ruangan:** Pilih lokasi resmi secara manual dari daftar lokasi yang tersedia.
- **Larangan pemalsuan lokasi:** Penggunaan aplikasi lokasi palsu (_mock location_) akan terdeteksi, tercatat di laporan risiko Admin, dan memblokir transaksi.
