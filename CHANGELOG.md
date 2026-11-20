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

## `ddf785e` — fix(ui): keep Home album rotation stable until daily or manual refresh

- Akar masalah: `HomeView` memilih 10 album dengan `shuffle(unique)` memakai `Math.random` saat mount. Karena `App.tsx` mengganti `key` `.content-scroll` tiap pindah route, Home di-unmount/remount dan **Featured album** plus **Explore your albums** ikut teracak ulang.
- Seleksi dipindah ke helper murni `homeSelection.ts`: dedup By `album.name` (sama seperti sebelumnya), Fisher–Yates dengan RNG ber-seed mulberry32, lalu `slice(0, 10)`. Seed yang sama selalu menghasilkan urutan yang sama, jadi nav bolak-balik tidak mengubah apa pun.
- Seed harian berasal dari hash FNV-1a atas kunci tanggal lokal `YYYY-MM-DD`, sehingga rotasi berganti otomatis tiap hari tanpa perlu write pengaturan saat tengah malam.
- Tombol **Refresh featured albums** ditambahkan di Settings → Library (dekat *Rescan now*). Tombol menyimpan seed acak 32-bit + hari pembuatannya lewat `useSettings.patch`, lalu toast; seed manual hanya berlaku di hari itu, besok kembali ke seed tanggal.
- Field `AppSettings.home` (`featuredSeed`, `featuredSeedDay`) ditambahkan ke default dan dinormalisasi saat load/patch (seed harus finite, day key `YYYY-MM-DD`), jadi file settings lama atau hasil edit manual tidak bikin crash. Home menunggu settings termuat sebelum pick pertama agar seed manual yang tersimpan tidak memicu shuffle ulang saat startup.
- Shelf lain yang bergantung pada waktu (`topTracks`, `onRepeat`, `rediscover`) sengaja tidak disentuh; scope perubahan hanya dua shelf album.

## `b5f54f8` — feat(ui): add General settings section for featured refresh

- Tab **General** baru ditambahkan di `SettingsView` (setelah **Appearance**), dengan `SettingsSection = "general"` di `uiStore`. Default buka Settings sengaja tetap **Appearance** supaya perilaku cold-start tidak berubah.
- Tombol **Refresh featured albums** dipindah dari Settings → Library ke Settings → General (`data-testid="settings-refresh-featured"` tetap dipakai). Logika seed, toast, dan penanganan error tidak berubah; Library kembali hanya berisi folder, rescan, dan Decode Tester.
- Section General memakai styling `.settings-section` / `.heading-actions` / `.muted` yang sudah ada, tanpa CSS baru. Konten Appearance, Lyrics, Library, dan About tidak disentuh.
- Assertion daftar tab di `tests/browser/run-app.mjs` diperbarui menjadi `Appearance, General, Lyrics, Library, Playback, Cache, About`. Assertion lama lainnya tetap utuh, termasuk posisi **Reset all** di About dan **Replay onboarding** di Appearance.

## `6e9672d` — refactor: remove Fetch All Lyrics feature

- Fitur **✨ FETCH ALL LYRICS ✨** dihapus penuh: engine job (`fetchAllCore.ts`), klaster duplikat (`recordingIdentity.ts`), store renderer, komponen Settings/Sidebar, dan suite test khusus tidak ada lagi. Tombol, panel progres, indikator sidebar, serta teks onboarding yang menyebutnya ikut hilang.
- Bridge Tauri tidak lagi membuat/mengembalikan job, memanggil `restore()`/`flush()`, atau mengekspos `bridge.lyrics.fetchAll`; `BootstrapPayload`, `cmd_bootstrap`, dan `cmd_write_user_json` tidak lagi membawa `lyricsFetchJob`. File `lyrics-fetch-job.json` lama sengaja dibiarkan di disk tanpa migrasi.
- `assessTrack`/`shareRecordingResult` dan tipe-tipe job dihapus, tetapi mekanisme yang dipakai bersama tetap ada: `ConcurrencyLimiter` + `providerRequests`, `shareInFlight`, coverage cache (`queriedModules`/`enabledKeys`), `notFoundCooldownDays`, provider order, history, dan `cmd_write_user_json` generik.
- Autofetch tetap berjalan seperti biasa; hanya panggilan `promote()` ke job yang sudah tidak ada yang dicabut. Onboarding sekarang 4 langkah (Welcome → Library → Preferences → Ready), clamp step di `settingsCore.ts` jadi `3`, dan fixture/test browser mengikuti.
- CSS khusus fitur (`.fetch-*`, `@keyframes count-in`, `.onboarding-stats`, `.onboarding-actions-inline`) dan selector `.fetch-panel` di `MarqueeText` dibersihkan. Dokumentasi arsitektur dipangkas menjadi catatan Autofetch + Onboarding.

## `eb82f79` — feat(ui): lead Settings with General and align action buttons

- Tab Settings sekarang urutannya **General → Appearance → Lyrics → Library → Playback → Cache → About**; **General** juga jadi section default saat membuka Settings (`uiStore.settingsSection`). Sebelumnya General nomor 2 dan default tetap Appearance.
- Tombol **Replay Onboarding** (Appearance) dan **Customize** (Now Playing) yang sebelumnya cuma teks polos sekarang memakai `.ghost-button setting-action`, mengikuti gaya tombol **Restore default settings**: persegi panjang dengan background/border dan hover.
- Di About, **Clear lyrics cache** tidak lagi berdiri sendiri di tengah. Sekarang memakai `.setting-row` seperti **Restore default settings**: label + deskripsi di kiri, tombol `ghost-button danger setting-action` di kanan. Teks, konfirmasi, dan logika clear tidak berubah; Reset all tetap elemen terakhir di About.
- Assertion urutan tab di `tests/browser/run-app.mjs` disesuaikan. `provider-identity.ts` sekarang mengklik tab Appearance secara eksplisit setelah reload sebelum memeriksa font, karena default sudah bergeser ke General. Assertion lain tidak dilemahkan.

## `ac9f6a0` — ci: add Linux AppImage and deb build workflow

- Menambahkan `.github/workflows/build-linux.yml` sebagai pasangan `build-windows.yml`: jalan manual lewat **workflow_dispatch** (input `stage`, default `7` dari `.github/stage-build.txt`) dan otomatis saat push ke `feat/ui` yang menyentuh workflow ini atau `stage-build.txt`.
- Job berjalan di `ubuntu-latest`: Node 22 + Rust stable + `rust-cache`, install dependensi Tauri Linux (`webkit2gtk-4.1`, `appindicator3`, `librsvg2`, `patchelf`, dll), lalu `npm run typecheck` dan `npm run package:linux` (`tauri build --bundles appimage,deb`).
- Artefak di-upload sebagai `Cadence-<stage>-linux`, berisi `.AppImage`, `.deb`, binary `cadence`, dan `SHA256SUMS`. Tidak ada commit balik ke branch seperti di workflow Windows.

## Verifikasi

- `f3a4ce0`: `npm run build` lolos (CSS-only); sudah dicek visual di `npm run dev`.
- `884a22d`: `npm run typecheck` dan `npm run build` lolos; sudah dicek visual di `npm run dev`.
- `ddf785e`: `npm run typecheck` dan `npm run build` lolos; `tests/unit/homeSelection.test.ts` (5 test) dan 3 test normalisasi settings baru lolos.
- `b5f54f8`: `npm run typecheck` dan `npm run build` lolos; `tests/unit/homeSelection.test.ts` + `tests/unit/settings.test.ts` (31 test) lolos.
- `6e9672d`: `npm run typecheck`, `npm run build`, dan `cargo check --manifest-path src-tauri/Cargo.toml` lolos; 61 test targeted (`lyricsAutomationStores`, `settings`, `lyricsAutofetch`, `lyricsAudit`) lolos.
- `eb82f79`: `npm run typecheck` dan `npm run build` lolos. Perubahan hanya markup/kelas tombol dan urutan tab; assertion browser yang bergantung pada urutan/default disesuaikan, tidak dilemahkan.
- `ac9f6a0`: YAML workflow divalidasi lokal dengan PyYAML. Build Linux belum dijalankan lokal (tapi akan berjalan di runner `ubuntu-latest` saat workflow ini di-push).
- `npm run typecheck` lolos.
- `npm run build` lolos.
- `npm test`: 615/616 test lolos. Dua kegagalan yang sudah ada sebelum perubahan ini tetap ada (file DB terkunci di Windows saat cleanup `library.test.ts` dan threshold benchmark Smart Shuffle); `_matasaburo_full.test.ts` lolos pada run ini. Tidak ada kegagalan baru dari perubahan ini — total test turun dari 630 karena suite `lyricsFetchAll.test.ts` (14 test) ikut dihapus bersama fiturnya.
- Audit browser (`npm run test:animation`, juga `npm run test:ui`) masih gagal sebelum eksekusi: `@sparticuz/chromium` mengembalikan path `...\AppData\Local\Temp\chromium` tanpa `.exe`, sehingga puppeteer gagal `spawn ... ENOENT` di Windows. Untuk `884a22d`, audit dijalankan lewat salinan sementara yang memakai Chrome lokal: keempat id `lyrics-mode-*` terdeteksi saat masuk maupun keluar mode. Salinan tersebut sudah dihapus; test asli tidak diubah.

> Dua file schema yang sudah modified sebelum perubahan ini tidak masuk ke commit mana pun.
