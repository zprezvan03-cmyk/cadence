# Changelog

Branch: `feat/ui` (dibuat dari `main` @ `1615d5b`)
Tanggal: 2026-11-19 — 2026-11-21

## `0bdd36d` — feat(ui): MV sebagai background fullscreen Now Playing (early development)

- Video lokal (`.mp4/.webm/.mov/.m4v`) kini bisa jadi background full-bleed di balik UI Now Playing. Decode memakai `<video>` bawaan Chromium, selalu mute, dan tidak menambah dependency. Audio tetap memakai engine yang ada.
- Asosiasi video: sidecar otomatis `<base>-mv.*` didahulukan, lalu `<base>.*`, plus override manual per lagu lewat `trackSourceKey`. Sidecar video tidak lagi ikut terindeks sebagai lagu. MV aktif menggantikan background Kawarp/artwork (termasuk animated art), jadi hanya satu decoder video yang hidup.
- Posisi video mengikuti clock audio: seek, pause/resume, perubahan tab, dan playback rate. Video lebih pendek dari lagu di-loop; video lebih panjang berhenti bareng audio. Scrim gelap bisa diatur lewat setting `mvBackground.scrimOpacity` (default `0.45`), tanpa blur pada video.
- Toggle ada di dock fullscreen (tombol clapperboard) dan di Settings, memakai satu setting yang sama. File rusak/auto-detect gagal fallback ke background lama dengan satu toast per lagu.
- Verifikasi: `npm run typecheck`, `npm run build`, `cargo check` lolos. `npm test` 622 lolos dengan dua failure baseline (benchmark `smartShuffleBenchmark` dan lock `library.test.ts`). Harness browser `tests/browser/mv-background.ts` sudah ditambahkan tapi belum bisa dijalankan karena binary Chromium tidak tersedia (`spawn ...\chromium ENOENT`).

## Belum di-commit — feat(ui): dropdown pilih file di lyrics dock

- Tombol `Open a lyrics file` kini jadi split button: klik ikon folder tetap langsung memilih file lyrics (perilaku lama dipertahankan), sementara chevron di sampingnya membuka dropdown berisi **Lyrics file** dan **Music video**.
- Opsi **Music video** memanggil picker MV, menyimpan binding `local:<id>`, mengaktifkan background MV, lalu menampilkan toast. User tidak perlu membuka Settings hanya untuk mengganti/attach MV.
- Dropdown mengikuti pola popover dock yang ada: tertutup saat klik di luar, ikut expanded state toolbar fullscreen, dan tidak menimpa tombol Save.
- Harness `tests/browser/mv-background.ts` mendapat asersi untuk menu dua opsi, binding dari dock, dan keberadaan tombol lyrics lama. `npm run typecheck` dan `npm run build` lolos.

## `b271dc7` — fix(ui): match fullscreen header buttons to glass material

- Tombol di baris atas fullscreen (`.fs-mode-tabs`, `.fs-exit`, dan pill `.lyrics-tools`) sekarang memakai material glass yang sama dengan footer dan popover: `color-mix(in srgb, var(--bg-elevated) 58%, transparent)`, `backdrop-filter: blur(18px) saturate(1.3)`, border `var(--border)`, dan `box-shadow: var(--shadow-lg)`.
- State hover (`78%`) dan tab terpilih (`82%`) juga ikut glass, tidak lagi memakai `var(--surface-3)` yang solid.
- Playbar jendela utama (`.player-bar`) sengaja **tidak** diubah: masih solid `var(--chrome-surface)` dengan `border-top`, jadi glass ini khusus permukaan melayang di fullscreen.
- Verifikasi: `npm run build` lolos. Computed style background, border, dan shadow ketiga tombol identik dengan popover/footer. `backdropFilter` terbaca `none` di browser headless, tapi popover dan footer lama juga begitu — keterbatasan environment render, bukan CSS.

## `936348e` — Removed that one Linux artifact

- Menghapus artifact build `Cadence-7-linux.zip` (~95 MB) dari repository.

## `1f43597` — fix(ui): refine lyrics tools hover expansion and animation

- Toolbar lyrics Now Playing sekarang **expand saat hover**, bukan klik: trigger tetap di posisinya dan kontrol muncul di dalam pill yang sama. Klik pada trigger tidak lagi dipakai untuk toggle.
- Ada grace period `180ms` supaya pointer bisa menyeberang dari pill ke popover tanpa langsung collapse; popover yang terbuka dan fokus keyboard (`:focus-visible`) menahan pill tetap expanded, sedangkan klik mouse tidak.
- Animasi expand/collapse memakai satu permukaan: grid `0fr → 1fr` selama `300ms` (`--dur-pill`) untuk dua arah. `width → max-content` ditinggalkan karena Chromium meloncat langsung, dan `translateX` slide dihapus.
- Konten tetap **ter-clip** di tepi pill saat animasi (ada area invisible dekat tombol) sehingga tidak terlihat berantakan; `overflow: visible` hanya dinyalakan lewat class `has-popover` kalau ada popover dock yang terbuka.
- Audit browser (`animation-audit.ts`, `now-playing-layout.ts`) kini membuka toolbar lewat `hover` alih-alih klik; assertion yang ada tidak dilemahkan.
- Verifikasi: `npm run typecheck` dan `npm run build` lolos; `npm test` tidak berubah dari baseline (615 lolos, failure lama pada benchmark `smartShuffleBenchmark` dan lock `library.test.ts`). Sampling browser mengonfirmasi lebar pill naik `40 → 580px` dan turun lagi secara halus ~300ms, dengan popover tetap terlihat dan bisa diklik.

## `78cba44` — fix(ui): keep lyrics tools inside the inline bubble

- Toolbar lyrics yang terbuka tidak lagi memotong tombol di ujung kanan: `max-width` warisan `.lyrics-dock` dinonaktifkan di baris header dan batas lebar row diperlebar, sehingga `scrollWidth` pill sama dengan kontennya.
- Jarak antar grup dan tombol diperketat supaya semua kontrol tetap muat dalam satu baris tanpa tombol keluar dari bubble.
- Tinggi pill, wrapper, dan trigger kini sama persis `38px`, dengan tombol di dalamnya tetap tercentre; popover tetap jatuh ke bawah dan tidak keluar viewport.
- Verifikasi: `npm run typecheck`, `npm run build`, dan `npm test` statusnya tidak berubah dari commit sebelumnya (dua failure lama yang unrelated). Pemeriksaan browser: pill `w=547`, `h=38`, tombol terjauh `right=697` masih di dalam pill `right=706`.

## `5b56df9` — feat(ui): expand lyrics tools inline in fullscreen header

- Kontrol lyrics Now Playing sekarang jadi **satu baris di ujung kanan header**: tombol trigger tetap di posisinya, lalu toolbar dock-nya melebar ke kiri lewat transisi `max-width` + `opacity` + `translateX`. Tidak ada permukaan popup baru.
- `LyricsView` memasang satu instance `LyricsDock`: di header saat fullscreen, di footer saat windowed / studio preview. State `dockExpanded` di-reset saat mode berubah, dan playbar bawah tetap memakai hover visibility seperti sebelumnya.
- Popover dock (Source, Profile, Translate, dll.) kini jatuh ke bawah baris header, dan reservasi ruang header disesuaikan supaya judul tidak tertimpa saat toolbar terbuka.
- Area hover playbar fullscreen sekarang mencakup **seluruh lebar viewport** sampai tepi bawah, bukan hanya strip tengah. Pemeriksaan di browser (`http://localhost:4792/?v=5`) mengonfirmasi bar muncul dari ujung kiri/kanan dan tetap sembunyi saat pointer di area lirik.
- Audit browser diperbarui untuk membuka trigger terlebih dahulu sebelum memakai tombol dock, plus assertion baru `hover-full-width-edge-reveals-controls`; assertion lama tidak dilemahkan.
- Verifikasi: `npm run typecheck` dan `npm run build` lolos. `npm test` lolos 615/616 dengan dua kegagalan yang sudah ada sebelumnya (lock file DB di `library.test.ts` dan benchmark `smartShuffleBenchmark`); audit browser nyata masih terblokir karena binary Chromium tidak tersedia.

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

## `5132bf6` — feat(ui): add floating Home shelf scroll controls

- Tombol `<` / `>` untuk shelf horizontal Home tidak lagi duduk di heading, melainkan **melayang di ujung kiri/kanan viewport artwork**. Keduanya sejajar dengan tengah cover, memakai background gelap transparan + blur + shadow, dan otomatis hilang saat shelf sudah berada di ujung scroll.
- Satu klik menggeser **dua artwork**: jarak dihitung dari kartu pertama ke kartu ketiga supaya gap ikut terhitung; fallback memakai dua kali langkah kartu bila kartu kurang dari tiga. `prefersReducedMotion()` tetap dipakai untuk memilih `smooth` atau `auto`.
- Track dibungkus `.home-shelf-viewport` sebagai anchor overlay. Ref viewport milik `HomeTrackShelf` disambung lewat callback ref, jadi menu track tidak putus; struktur `.card-grid.home-shelf-track` yang dipakai audit stagger tidak diubah.
- Versi tombol di heading (commit `8516259`) sudah direvert lebih dulu lewat `f793d39`; implementasi ini menggantikannya dengan posisi floating sesuai espek.

## `c11501b` — fix(ui): dismiss lyrics dock popovers outside the dock

- Popover di lyrics dock Now Playing (**Source**, **Profile**, **Translate**, **Save**, **Regenerate**) sekarang auto-hide saat ada `pointerdown` di luar area dock. Klik di dalam popover tidak menutupnya, dan klik luar langsung menutup semua popover yang sedang terbuka.
- Trigger popover kini memakai helper `closePopovers` / `togglePanel` / `toggleLanguage` / `toggleSave` / `toggleRegenerate`, sehingga membuka satu popover menutup popover lain yang masih terbuka. Klik tombol yang sama tetap berfungsi sebagai toggle tutup.
- Row aksi (pilih source, profile, hasil pencarian, dan navigasi Search ↔ Sources) juga ikut menutup popover lewat helper yang sama. Animasi presence `pop-in` / `pop-out` tidak diubah.

## `93f257b` — feat(ui): scroll Home shelves by viewport width

- Scroll Home shelf sekarang bergerak **satu layar penuh** per klik, bukan dua kartu tetap. Langkahnya `node.clientWidth`, jadi mengikuti lebar jendela: kalau yang terlihat 5,5 artwork, gesernya juga 5,5 artwork.
- Helper `scrollByCards` diganti `scrollByPage`; perhitungan jarak dari kartu pertama/ketiga dibuang. Perilaku ujung scroll dan `prefersReducedMotion()` tidak berubah, begitu juga posisi tombol floating dan ref viewport track.
- Entry `5132bf6` tetap mencatat perilaku dua kartu pada commit itu; `93f257b` menggantikannya di HEAD.

## `06e3373` - feat(ui): unify Now Playing footer glass and icon-only lyrics dock

- Dua pill kaca (`.fs-controls` + `.lyrics-dock`) diganti jadi **satu permukaan kaca `.lyrics-footer` selebar viewport**. Kedua bar tetap mempertahankan posisi dan ukuran relatifnya, tapi background/border/radius individualnya dihapus — glass kini milik strip penuh tersebut.
- Popover dock di-anchor ke **footer** (bukan dock), jadi muncul 10px di atas seluruh strip dan tetap nempel ke tombol masing-masing (kiri untuk Source/Profile/Translate, kanan untuk Save/Regenerate). `z-index`-nya dinaikkan supaya berada di atas playbar.
- Strip kaca ikut hide/show bersama kontrol lewat kelas `.is-concealed`; kalau ada popover yang terbuka, strip tetap nyala (pinned).
- Enam trigger dock (Source, Profile, Translate, Romanize, Regenerate, Save) jadi **icon-only** lewat modifier `.dock-button--icon`, dengan `title` + `aria-label` (Romanize juga `aria-pressed`). Ikon yang kurang nyambung diganti: `Sparkles` → `ListMusic`, `LayoutGrid` → `Palette`, `Wand2` → `Type`.
- Satu selector di `tests/browser/audit-ui.mjs` disesuaikan ke `button[title="Lyrics source"]`; assertion yang ada tidak dilemahkan.

## `4cdf617` — feat(ui): mirror home playbar in fullscreen Now Playing

- Bar fullscreen sekarang memakai tiga zona persis seperti playbar Home: `.player-track` (thumbnail + judul/artis + Like) di kiri, `.player-center` (transport di atas seek row) di tengah, dan `.player-right` (volume + Queue + Mini player) di kanan. Satu-satunya yang beda tetap background dinamis yang live.
- Artwork dan metadata di footer adalah duplikat dekoratif: `PlaybackArtwork shared={false}` dan tanpa `data-player-part`, supaya hanya artwork + judul hero di badan view yang ikut handoff. Slot handoff footer tetap satu-satunya di `.transport`.
- Tombol **Now Playing** sengaja tidak ditambahkan di footer supaya assertion `single-fullscreen-button-in-fullscreen` tetap lolos; Queue dan Mini player tetap tersedia di kanan.
- `TransportButtons` tidak diekstrak — shuffle/repeat tetap bersama transport seperti di Home.
- `tests/browser/run-app.mjs`: assertion lama `transportLeft` / `trackCentre` / `rightModes` diganti cek struktur baru `trackLeft` / `transportCentre` / `rightTools` (termasuk ketiadaan slot handoff duplikat dan tombol Now Playing kedua). Assertion lain tidak dilemahkan.
- Grid CSS memakai `minmax(0, 1fr) clamp(248px, 30vw, 400px) minmax(0, 1fr)` dengan lebar volume mengikuti `vw`, bukan `cqi` (container query tidak terpakai di sini), dan zona ditumpuk saat lebar `< 900px`.

## Verifikasi

- `4cdf617`: `npm run typecheck` dan `npm run build` lolos. `npm test`: 615/616 lolos; dua kegagalan yang sudah ada tetap ada (DB lock `library.test.ts` di Windows dan threshold `smartShuffleBenchmark.test.ts`), tidak ada kegagalan baru. Di browser harness (setelah rebuild): fullscreen terbuka, kolom terukur `164.264px 283.458px 164.278px`, semua cek `fsParts` baru true, dan satu-satunya `data-player-part` di footer adalah `transport`. Audit `npm run test:animation` masih gagal sebelum eksekusi karena binary Chromium `...\AppData\Local\Temp\chromium` tidak ada (ENOENT).
- `f3a4ce0`: `npm run build` lolos (CSS-only); sudah dicek visual di `npm run dev`.
- `884a22d`: `npm run typecheck` dan `npm run build` lolos; sudah dicek visual di `npm run dev`.
- `ddf785e`: `npm run typecheck` dan `npm run build` lolos; `tests/unit/homeSelection.test.ts` (5 test) dan 3 test normalisasi settings baru lolos.
- `b5f54f8`: `npm run typecheck` dan `npm run build` lolos; `tests/unit/homeSelection.test.ts` + `tests/unit/settings.test.ts` (31 test) lolos.
- `6e9672d`: `npm run typecheck`, `npm run build`, dan `cargo check --manifest-path src-tauri/Cargo.toml` lolos; 61 test targeted (`lyricsAutomationStores`, `settings`, `lyricsAutofetch`, `lyricsAudit`) lolos.
- `eb82f79`: `npm run typecheck` dan `npm run build` lolos. Perubahan hanya markup/kelas tombol dan urutan tab; assertion browser yang bergantung pada urutan/default disesuaikan, tidak dilemahkan.
- `ac9f6a0`: YAML workflow divalidasi lokal dengan PyYAML. Build Linux belum dijalankan lokal (tapi akan berjalan di runner `ubuntu-latest` saat workflow ini di-push).
- `5132bf6`: `npm run typecheck` dan `npm run build` lolos. Di browser harness, tombol berada di edge viewport dan satu klik menggeser `320px` (dua kartu `148px` + dua gap `12px`).
- `c11501b`: `npm run typecheck` dan `npm run build` lolos. Di browser harness: klik di dalam popover tidak menutup, klik di luar menutup, pindah trigger menutup popover lama, dan klik luar berikutnya mengosongkan semua popover.
- `93f257b`: `npm run typecheck` dan `npm run build` lolos. Di browser harness dengan viewport shelf `708px`, satu klik menggeser tepat `708px`.
- `06e3373`: `npm run typecheck` dan `npm run build` lolos. Di browser harness: footer selebar viewport (800px), glass aktif saat hover dan tetap pinned saat popover terbuka, kelima popover 10px di atas strip serta ter-align ke trigger, outside-click menutup semua, dan nol teks pada tombol dock.
- `npm run typecheck` lolos.
- `npm run build` lolos.
- `npm test`: 615/616 test lolos. Dua kegagalan yang sudah ada sebelum perubahan ini tetap ada (file DB terkunci di Windows saat cleanup `library.test.ts` dan threshold benchmark Smart Shuffle); `_matasaburo_full.test.ts` lolos pada run ini. Tidak ada kegagalan baru dari perubahan ini — total test turun dari 630 karena suite `lyricsFetchAll.test.ts` (14 test) ikut dihapus bersama fiturnya.
- Audit browser (`npm run test:animation`, juga `npm run test:ui`) masih gagal sebelum eksekusi: `@sparticuz/chromium` mengembalikan path `...\AppData\Local\Temp\chromium` tanpa `.exe`, sehingga puppeteer gagal `spawn ... ENOENT` di Windows. Untuk `884a22d`, audit dijalankan lewat salinan sementara yang memakai Chrome lokal: keempat id `lyrics-mode-*` terdeteksi saat masuk maupun keluar mode. Salinan tersebut sudah dihapus; test asli tidak diubah.

> Dua file schema yang sudah modified sebelum perubahan ini tidak masuk ke commit mana pun.
