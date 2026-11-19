# Changelog

Branch: `feat/ui` (dibuat dari `main` @ `1615d5b`)
Tanggal: 2026-11-19 — 2026-11-20

## `e41e7f6` — fix(ui): decouple title bar brand from sidebar

- Segmen brand titlebar memakai lebar tetap `256px` dan tidak lagi mengikuti `--sidebar-width`.
- Ikon dan tulisan **Cadence** di titlebar selalu tampil, walau sidebar dalam mode compact atau hover-expand.
- Aturan compact dan transisi yang menyelaraskan brand titlebar dengan sidebar dihapus.

## `760d5d9` — feat(ui): simplify sidebar header and tune compact tiles

- Tombol brand sidebar (logo + tulisan **Cadence**) dihapus. Navigasi Home tetap tersedia lewat item **Home**.
- Label **LISTEN** di bawah search bar dihapus, termasuk CSS `.nav-group` yang hanya dipakai label tersebut.
- Ukuran tile nav untuk jendela pendek (`@media (max-height: 720px)`) digedein sedikit: `min-height` `29px` → `31px`, `padding-block` `5px` → `6px`. Masih di bawah ukuran jendela normal (`34px` / `7px`).
- Audit keyboard: test yang sebelumnya menargetkan `.brand` dialihkan ke item nav **Home**, sehingga cakupan test tetap ada.

## `2d984e2` feat(ui): rename Listen Now heading to Home and add changelog

- Menambahkan dan commit CHANGELOG ini beserta isinya.
- Judul halaman Home diubah dari **Listen Now** menjadi **Home** (`HomeView.tsx`), termasuk komentar section CSS-nya.

## Perubahan pada commit ini — feat(ui): animate Now Playing background from player bar

- Background fullscreen Now Playing (`.kawarp-bg` untuk mode *fluid*, `.np-bg` untuk mode lain) ikut naik penuh dari bawah (`translateY(100%) → 0`) berbarengan dengan artwork, judul, dan transport saat masuk fullscreen.
- Saat keluar fullscreen, node background aslinya di-pin ke rect lama lalu turun (`translateY(0) → 100%`). Kalau `LyricsView` ikut unmount, node dipindahkan sementara ke `body` dan dibuang setelah animasi — canvas shader tetap hidup selama transisi, bukan diganti snapshot.
- Kedua arah memakai satu jalur WAAPI dengan id `player-background-handoff`, durasi `MOTION_DURATION_MS.scene` (300ms / `--dur-scene`), dan easing `MOTION_EASING.settle`; animasi turunan `view-in` / `fs-in` tidak diubah.
- `.lyrics-view.is-fullscreen` diberi warna dasar `#05050a` supaya area yang belum tertutup layer yang masih naik tidak menampilkan app di belakangnya.
- Audit animasi browser mendapat assertion masuk dan keluar untuk `player-background-handoff`; assertion yang sudah ada tidak dilemahkan.

## `f3a4ce0` — fix(ui): compact and frost Now Playing footer bars

- `.lyrics-dock` diperkecil sekitar sepertiga: variabel `--dock-control-size` (`clamp(26px, 2.9cqh, 38px)`) menggantikan `min-height` tombol bawaan `~38px`, padding vertikal `~13px → ~8px` per sisi, dan ikon dock mengikuti ukuran tombol. Di viewport 900px tinggi bar `~65px → ~44px`.
- `.lyrics-dock` dan `.fs-controls` tidak lagi memakai isian solid `var(--bg-elevated)`: keduanya jadi `color-mix(in srgb, var(--bg-elevated) 58%, transparent)` dengan `backdrop-filter: blur(18px) saturate(1.3)` (plus prefiks `-webkit-`), supaya shader/artwork di belakang tetap terbaca.
- Warna dasar `#05050a` di `.lyrics-view.is-fullscreen` dari commit sebelumnya tetap dipertahankan — itu hanya menutup area selagi layer background masih naik, bukan mengganti background Now Playing.
- Mode panel (`.fs-controls.is-panel`) sengaja tidak disentuh: tetap transparan tanpa blur sesuai perilaku sebelumnya.

## `884a22d` — feat(ui): animate Lyrics On/Off tab switch in Now Playing

- Perpindahan tab **Lyrics On / Lyrics Off** di fullscreen tidak lagi polos: artwork, judul, dan transport diukur sebelum commit React lalu dianimasikan dari posisi lama ke slot baru (FLIP via WAAPI), memakai id `lyrics-mode-artwork-handoff`, `lyrics-mode-metadata-handoff`, dan `lyrics-mode-transport-handoff` dengan durasi `MOTION_DURATION_MS.scene` (300ms) serta easing `MOTION_EASING.settle`.
- Judul diberi jeda 40ms supaya artwork/transport memimpin gerakan dan teks menyusul; node asli yang dipakai, jadi cover dissolve dan state hover tetap hidup.
- Lirik tidak di-unmount saat mode berubah: hanya paint-nya yang fade + geser 12px. Keluar memakai `MOTION_DURATION_MS.fast` (120ms, ease-in) dengan `visibility` dipin sementara agar fade tidak terpotong oleh `.lyrics-body.is-hidden`; masuk memakai `MOTION_DURATION_MS.surface` (180ms, ease-out, delay 60ms) dengan id `lyrics-mode-body`.
- Animasi dibatalkan otomatis lewat `finishMotion` saat selesai, resize, pergantian tab cepat, atau reduced motion; inline style dikembalikan ke CSS setelahnya. Komponen baru `LyricsModeMotion.tsx` hanya membungkus children, tidak menambah DOM node.
- Studio preview dan transisi masuk/keluar fullscreen tidak tersentuh — keduanya punya jalur animasi sendiri.

## Verifikasi

- `f3a4ce0`: `npm run build` lolos (CSS-only); sudah dicek visual di `npm run dev`.
- `884a22d`: `npm run typecheck` dan `npm run build` lolos; sudah dicek visual di `npm run dev`.
- `npm run typecheck` lolos.
- `npm run build` lolos.
- `npm test`: 621/622 test lolos. Dua kegagalan yang sudah ada sebelum perubahan ini tetap ada (file DB terkunci di Windows saat cleanup dan threshold benchmark Smart Shuffle), tidak ada kegagalan baru.
- Audit browser (`npm run test:animation`) masih gagal sebelum eksekusi: `@sparticuz/chromium` mengembalikan path `...\AppData\Local\Temp\chromium` tanpa `.exe`, sehingga puppeteer gagal `spawn ... ENOENT` di Windows. Untuk `884a22d`, audit dijalankan lewat salinan sementara yang memakai Chrome lokal: keempat id `lyrics-mode-*` terdeteksi saat masuk maupun keluar mode. Salinan tersebut sudah dihapus; test asli tidak diubah.

> Dua file schema yang sudah modified sebelum perubahan ini tidak masuk ke commit mana pun.
