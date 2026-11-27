# Changelog

Branch: `arena/f3cb8f17-cadence` (dibuat dari `main` @ `cc35df7`)
Tanggal: 2026-11-22 — 2026-11-23

## `2b2076f` — fix(shaders): wallpaper tidak boleh memutihkan seluruh jendela

- **Bug yang dilaporkan dari build nyata: layar abu-abu/kosong setelah shader dinyalakan.** Penyebabnya satu baris hook yang salah tempat di `GlobalShaderBackground`: `const artworkUrl = item?.artworkUrl ?? useMemo(() => generatedShaderSource(accent), [accent])`. `useMemo` di situ adalah **hook yang dipanggil bersyarat**. Pada render pertama setelah sebuah lagu mulai diputar, `item` berisi, `??` melakukan short-circuit, dan `useMemo` terlewat. React membandingkan urutan hook dengan render sebelumnya, melihat jumlah yang berbeda, lalu melempar error #300 ("Rendered more hooks than during the previous render"). Tidak ada yang menangkap error itu, jadi React melepas seluruh root: `#root` tersisa **nol anak**, body tidak punya teks, dan yang terlihat hanya latar jendela — layar abu-abu yang persis seperti laporan. Toggle di Settings yang seharusnya bisa mematikan shader ikut hilang bersama UI-nya, sehingga pengguna tidak punya jalan keluar dari dalam aplikasi.
- **Perbaikan pada akarnya**: gradien fallback sekarang dihitung tanpa syarat, lalu dipilih setelahnya (`const generated = useMemo(...); const artworkUrl = item?.artworkUrl ?? generated;`). Tidak ada z-index atau CSS yang disentuh.
- **Pengaman kedua, karena wallpaper tidak boleh bisa menjatuhkan aplikasi.** `src/renderer/app/ShaderBoundary.tsx` (class component, satu-satunya cara menangkap render error di React 19) membungkus subtree shader di `App.tsx`. Render error di situ hanya melepas wallpaper, dicatat sekali ke console, dan sisa aplikasi tetap berjalan di atas canvas biasa — Settings tetap bisa dibuka dan shader tetap bisa dimatikan pengguna.
- **Kenapa harness tidak menangkapnya.** `visual-inspect.mjs` dan `run-app.mjs` memang menyalakan shader dan berjalan antar halaman, tapi tidak pernah memutar lagu yang benar-benar ter-decode saat shader aktif. Track pertama yang dipakai probe lama adalah `broken.flac` — fixture yang memang tidak bisa didecode — jadi playback gagal, item media tidak pernah ada, `item` tetap `null`, dan jumlah hook tidak pernah berubah.
- **Pengaman regresi baru**: `global-shader-playback-never-blanks-the-app` di `run-app.mjs`. Dengan wallpaper aktif ia memutar "Fixture FLAC", lalu memastikan `#root` masih punya anak dan lebih dari 1 KB markup, body masih berisi teks, heading dan judul player ada, layer masih canvas hidup di `z-index: -1`, teks tidak ter-hit-test ke layer, dan **tidak ada page error**. Diverifikasi: pada kode sebelum perbaikan cek ini gagal (`#root` kosong, React #300) dan mengambil screenshot layar kosong; setelah perbaikan lolos.
- Reproduksi dan verifikasi memakai aplikasi hasil build di Chromium (`--use-gl=angle --use-angle=swiftshader`), bukan pembacaan source. Screenshot sebelum perbaikan: `.artifacts/visual/_repro-after-play.png` (kosong), sesudah: `.artifacts/screens/07e-global-shader-playing.png` (UI utuh, lagu berjalan, wallpaper aktif).
- Verifikasi otomatis: `npm run typecheck` lolos; `npm run build:web` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **633/633**; `tests/browser/run-app.mjs` **169/169**; `tests/browser/visual-inspect.mjs` **29/29, tanpa error console**.
- `docs/global-shader-background.md`: bagian baru "The grey screen" (penjelasan bug, containment, kenapa harness melewatkannya) dan "If the app is already stuck blank" — cara keluar untuk build lama lewat `settings.json` di direktori data aplikasi (`%APPDATA%\app.cadence.player\settings.json` di Windows; `app_data_dir` + `settings.json` di `src-tauri/src/commands.rs`), dengan `shaders.globalBackground` dan `shaders.enabled` diset `false`.
- SHA entri sebelumnya diperbaiki dari `b7afcb5` (tidak pernah ada) menjadi `320b1ad`.

## `320b1ad` — fix(shaders): perbaiki layer shader global dan tambahkan glassmorphism

- **Bug utama diperbaiki: teks seluruh UI hilang saat shader aktif.** Layer wallpaper dulu memakai `z-index: 0` di dalam `.app-shell` yang `isolation: isolate`. Anak ber-`z-index: 0` yang berposisi digambar di lapisan positioned, yaitu **di atas** konten in-flow yang tidak berposisi — dan hampir semua teks di route (judul halaman, judul track, label) tidak berposisi. Yang selamat hanya elemen yang punya stacking context sendiri (cover album, baris player bar), persis pola yang terlihat: gambar muncul, kata hilang. Hit-test DOM tetap melaporkan teks sebagai elemen teratas karena layer-nya `pointer-events: none`, jadi bug ini hanya kelihatan dari piksel.
- Perbaikannya pada akar masalah, bukan tambal z-index: layer dipindah ke **`z-index: -1`**. Sebagai anak negatif dari konteks terisolasi, ia melukis di atas latar shell sendiri tapi di bawah semua konten in-flow dan semua turunan berposisi. Tidak ada satu pun z-index di komponen UI yang dinaikkan — foreground tidak disentuh. Aturan ini ditulis sebagai komentar di stylesheet supaya tidak "diperbaiki" balik nanti.
- **Shader-nya nyaris hitam** saat tidak ada lagu yang diputar: tidak ada artwork untuk di-warp. Ditambahkan `shaderSource.ts` yang membuat gradien aksen (SVG inline, di-cache per warna aksen, tanpa request jaringan) sebagai sumber warp ketika tidak ada cover.
- **Glassmorphism bubbles** (`ShaderBubbles.tsx`): enam bola kaca frosted besar di dalam layer wallpaper — disc translusen dengan `backdrop-filter` blur, rim light inset, specular highlight (`::before`), caustic di tepi bawah (`::after`), dan bayangan lembut. Bergerak lewat animasi CSS (`transform` 26–47 detik dengan fase berbeda) plus morph `border-radius`, jadi tidak ada JS per frame. Komposisinya sengaja dijauhkan dari kolom baca: sudut, gutter antara sidebar dan konten, serta tepi bawah. Reduced motion membekukan keduanya.
- Kontras: scrim wallpaper dibuat lebih ringan daripada panggung Now Playing, dan kolom konten mendapat shade gradien lebar sendiri (`.content-scroll::before`, `z-index: -1`) supaya teks body mempertahankan kontras di atas warna yang bergerak tanpa mematikan shader-nya.
- Verifikasi visual nyata (bukan dari source): `tests/browser/visual-inspect.mjs` baru — menjalankan aplikasi hasil build, menyalakan wallpaper, membuka **Home, Songs, Albums, Artists, Liked songs, Playlists, Stats, History, Settings, lyrics windowed, fullscreen Now Playing, dan queue**, mengambil screenshot tiap halaman, memeriksa alpha setiap text node dan hit-test tiap halaman, mengubah ukuran window ke 1024×700 dan 1680×1000, mematikan/menyalakan lewat Settings, lalu reload untuk membuktikan persistensi. **29/29 cek, tanpa error console**; screenshot di `.artifacts/visual/`.
- Verifikasi otomatis: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **633/633**; `npm run build:web` lolos; `tests/browser/run-app.mjs` **168/168** termasuk pengaman regresi baru `global-shader-never-covers-text` (judul halaman dan judul track tidak berada di bawah layer dan tidak transparan) dan `global-shader-is-one-surface` (tepat satu layer, satu canvas, enam bubble); `audit-ui.mjs` **295 pass, 1 fail** (flake lama yang gagal juga di base); `now-playing-layout.ts` 37 cek lalu probe `openProfileSwitcher` (gagal juga di base); `animation-audit.ts` 117 cek dengan empat kegagalan yang sama seperti base.
- **Keterbatasan yang tidak diverifikasi**: jendela Tauri asli tidak bisa dijalankan di environment ini (tidak ada toolchain Rust), jadi inspeksi memakai renderer hasil build di Chromium dengan kontrak bridge yang sama — mencakup layout, stacking, animasi CSS dan WebGL, tapi tidak compositing WebView2 atau driver GPU nyata (di sini ANGLE/SwiftShader). Kelancaran dinilai dari screenshot dan inspeksi manual, bukan profil frame-time.

## `2e689ad` — feat(shaders): shader background global yang opsional

- Background shader Kawarp kini bisa dipakai di seluruh aplikasi, bukan hanya panggung Now Playing. Layer-nya satu permukaan `position: fixed; inset: 0; z-index: 0; pointer-events: none` yang jadi saudara dari shell — di belakang sidebar, setiap route, player bar, overlay, dan panggung fullscreen — sehingga navigasi tidak pernah me-mount ulang atau mematikan shader. Layer ini tidak menangkap input dan `aria-hidden`, jadi scroll, seleksi teks, fokus, dan kontrol jendela tetap seperti biasa.
- **Default mati.** Field baru `shaders.globalBackground` (default `false`) dinormalisasi di setiap load dan patch, sehingga nilai yang hilang, `null`, atau rusak tidak akan pernah menyalakannya. Saat mati, layer tidak dirender sama sekali: tidak ada canvas, konteks GL, resize observer, maupun render loop, dan shell tetap opak serta tidak di-isolate seperti sebelumnya.
- **Onboarding → Preferences** menawarkan pilihan eksplisit `Off | On` (`[data-testid="onboarding-shader-background"]`), default Off, dan opsional: tombol Next tidak bergantung padanya, menyelesaikan alur tanpa menyentuhnya menyimpan `false`.
- **Settings → Appearance** mendapat toggle "Shader background across the whole app" di sebelah toggle shader lama. Perubahan berlaku langsung tanpa restart, dan toggle membaca state yang benar-benar tersimpan.
- Saat aktif, kanvas aplikasi jadi transparan, player bar dan title bar jadi tembus pandang dengan blur di atas permukaan yang tetap opak, sidebar mempertahankan isi hampir solid (0.94) supaya navigasi tetap terbaca di atas warna yang bergerak, dan panggung Now Playing ikut transparan sehingga hanya ada **satu** konteks GL untuk jendela — bukan dua untuk piksel yang sama. Music video per lagu tetap dapat layer-nya sendiri.
- Siklus GPU tetap memakai mount yang sudah ada (`KawarpBackground`): satu konteks per mount, `dispose()` saat unmount, dan tanpa kerja saat `document.hidden`. Wallpaper tetap bergerak saat playback berhenti (lewat prop baru `animateWhenPaused`) karena latar yang membeku terbaca rusak, tapi menghormati reduced motion lewat `still` — satu frame diam.
- Kegagalan engine tidak meninggalkan lubang: `KawarpBackground` sudah menukar ke layer artwork ber-blur, dan wallpaper mempertahankan isi opak di belakang UI yang tembus pandang. Komponen tidak lagi unmount saat engine gagal, karena itu justru meninggalkan area transparan di atas apa pun.
- Pengaman browser diperluas: `global-shader-off-by-default` (tanpa layer/canvas, shell tetap opak dan tidak ter-isolate), `global-shader-enables-live`, `global-shader-layer-behind-the-ui`, `global-shader-does-not-capture-input`, `global-shader-covers-the-immersive-stage` (panggung transparan, tepat satu canvas), `global-shader-survives-reload`, `global-shader-disables-live`, `global-shader-falls-back-when-engine-fails`, `global-shader-failure-keeps-app-usable`, plus empat cek onboarding.
- Verifikasi: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **633/633** (lima kasus baru di `settings.test.ts`); `npm run build:web` lolos; `tests/browser/run-app.mjs` **166/166**; `tests/browser/audit-ui.mjs` **295 pass, 1 fail** (flake lama `instrumental-setting-completes`, gagal juga di base); `now-playing-layout.ts` 37 cek lalu probe `openProfileSwitcher` (gagal juga di base); `animation-audit.ts` 117 cek dengan empat kegagalan yang sama seperti base.
- Dokumentasi: `docs/global-shader-background.md` memetakan field, layer, mount point, aturan CSS, siklus GPU, fallback, dan hasil verifikasi.

## `c3f42f9` — feat(now-playing): chrome fullscreen hanya muncul saat hover

- Bar bawah, dock lirik, dan aksi kanan-atas (tab mode + tombol exit) kini **hanya muncul saat pointer berada di atasnya**. Tidak ada lagi sinyal global: menggerakkan pointer di atas artwork atau lirik tidak memunculkan apa pun, jadi tampilan istirahat fullscreen bersih.
- Setiap permukaan chrome ditandai `.fs-chrome` dan rect-nya dipakai sebagai zona hover dengan kelonggaran 8px, sehingga bar terbit saat pointer mendekat di tepi bawah dan tab mode/exit terbit di sudut kanan-atas. Chrome yang tersembunyi tetap punya box, jadi areanya tetap bisa ditemukan walau `pointer-events: none`.
- Waktu tunggu dipendekkan dari 3 detik ke **2 detik** (`CHROME_IDLE_MS = 2000`): chrome memudar 2 detik setelah pointer meninggalkannya. Popover/queue yang terbuka, tombol mouse yang ditekan, fokus keyboard, dan sembarang keypress tetap menahannya. Masuk fullscreen memunculkan chrome sekali lalu istirahat sendiri.
- Kursor tidak lagi disembunyikan (`cursor: none` dibuang): di chrome yang hover-only, kursor adalah cara menemukan bar lagi.
- Perbaikan bug dari refactor sebelumnya: `.fs-page-actions.is-concealed` hilang bersama kontrol kolom, sehingga tab mode dan tombol exit tidak pernah ikut memudar. Aturan fade-nya dikembalikan bersama `.fs-controls`/`.lyrics-dock`.
- Harness disesuaikan ke perilaku baru: `run-app.mjs` kini menguji `chrome-hidden-over-lyrics`, `hover-lyrics-roam-keeps-chrome-hidden`, `cursor-stays-visible-over-lyrics`, hover tepi kiri/kanan bar, dan fade 2 detik; klik di fullscreen lebih dulu memindahkan pointer ke band bar (atau ke tombol exit) karena wake global sudah tidak ada. `audit-ui.mjs`, `now-playing-layout.ts`, dan `animation-audit.ts` memakai helper yang sama (hover ke sasaran, bukan sekadar menggerakkan pointer).
- Verifikasi: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **628/628**; `npm run build:web` lolos; `tests/browser/run-app.mjs` **153/153**; `tests/browser/audit-ui.mjs` **296 pass, 0 fail** (4 blocked, 3 not tested); `now-playing-layout.ts` 37 cek lolos lalu berhenti di probe `openProfileSwitcher` (gagal juga di base); `animation-audit.ts` 117 cek dengan 4 kegagalan yang identik di base (`lyric-follow-…`, `mini-expansion-…`, `mini-handoff-…`, `layout-stable`), sementara `fs-controls-hide-on-leave` kini lolos.

## `1defecf` — feat(now-playing): satu playbar, kontrol kolom dibuang

- Kontrol di bawah artwork dihapus. `FullscreenColumnControls`, `FullscreenColumnTransport`, dan `FullscreenInfoActions` hilang dari `FullscreenControls.tsx`; kolom `.fs-side` kini hanya memuat cover plus heading info lagu, jadi tidak ada lagi progress bar dan transport kedua di sisi lirik.
- Transport tinggal di bar bawah: baris identity (`judul` + `artist · album`) dengan heart di kanan, baris transport di atas seek row, lalu volume dan tool tampilan. Favourite pindah ke bar sebagai `.icon-button.heart` tanpa kehilangan feedback-nya (pop 640ms, iris reveal 900ms, burst ray/dot 460–480ms).
- CSS kolom ikut dibersihkan: `.fs-info-row*`, `.fs-info-actions*`, `.fs-col-transport*`, `.fs-col-controls`, `.fs-col-shuffle/.fs-col-repeat`, dan `.fs-disc` varian panel lirik dihapus; `.fs-page-actions.is-concealed` kini berdiri sendiri dan daftar reduced-motion dipangkas.
- Pengaman di `tests/browser/run-app.mjs`: `fsParts.noColumnControls` memastikan tidak ada `[data-testid="fullscreen-column-controls"]` maupun `.fs-info-row` di fullscreen, dan heart diperiksa lewat `.fs-player-track button.heart`.
- Verifikasi: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **628/628**; `npm run build:web` lolos; `tests/browser/run-app.mjs` **153/153**; `tests/browser/audit-ui.mjs` **295 pass, 1 fail** (4 blocked, 3 not tested) — `instrumental-setting-completes` gagal juga di base dan lolos saat dijalankan sendiri, jadi itu flake lama, bukan regresi.
- Dokumentasi: `docs/now-playing-parity.md` diperbarui ke layout satu bar — catatan "transport sengaja diduplikasi" diganti penjelasan bahwa Cadence hanya memakai bar bawah.

## `d5fda88` — feat(now-playing): Better Lyrics fullscreen parity

- Layout fullscreen mengikuti halaman player Better Lyrics (`#blyrics-fs-column`): artwork → baris info lagu → progress bar 4px → baris transport. Baris info memuat judul (weight 700) dan `artist · album` (opacity 0.5) plus aksi 28px: favourite, volume, queue, dan mini player. Baris transport berisi disc 52px mengapit tombol play putih 68px, dengan shuffle dan repeat di slot terluar.
- Feedback klik disamakan dengan referensi: pop 280ms, nudge ikon ±22% 300ms pada tombol skip, ripple 480ms (`scale(2.6)`) yang muncul dari titik klik, serta favourite dengan pop 640ms, iris reveal 900ms, dan burst ray/dot 460–480ms.
- `ProgressBar` baru (`features/player/ProgressBar.tsx`): track 4px, knob 10px, fill digerakkan `transform` dengan glide 260ms saat seek, scrub mem-preview posisi sebelum release, klik-untuk-seek, dan step keyboard (5 detik, 30 detik dengan Shift, Home/End). Waktu kanan bisa dibalik antara total dan sisa (`-0:04`) lewat klik, dengan animasi 420ms `cubic-bezier(.22,1,.36,1)`.
- Setting baru `playback.showRemainingTime` (default `false`) dipakai bersama oleh kolom fullscreen dan bar bawah, tersimpan lewat settings store sehingga bertahan setelah restart.
- Volume memakai slider hover-expand referensi: bar 4px yang meluncur keluar sampai `clamp(72px, 7vw, 104px)` saat hover/focus, menutup 350ms setelah pointer pergi, wheel 4% per notch, panah 5%, Home/End ekstrem, dan Escape menutup. Glyph berganti sesuai level (muted/low/high).
- Bar player fullscreen kini edge-to-edge dengan permukaan matte `#1b1b1d` dan progress putih (menggantikan accent), meniru bar YouTube Music yang tetap hidup di fullscreen versi Better Lyrics. Zona kiri/tengah/kanan tetap dipertahankan.
- `useFullscreenChrome` menggantikan `useControlsHover`: chrome (bar, aksi info lagu, kontrol kolom, tab mode, tombol exit, dock) muncul saat ada gerakan pointer, keyboard, atau fokus, lalu sembunyi setelah **3 detik** diam (aturan idle Better Lyrics). Pointer yang berhenti di atas chrome, popover/queue yang terbuka, dan fokus keyboard menahannya; klik mouse tidak. Saat chrome sembunyi, kursor ikut disembunyikan (`cursor: none`), dan fade memakai `--dur-3` dengan `visibility` mengikuti di akhir agar kontrol keluar dari hit-testing dan urutan fokus.
- Dock lirik pindah dari baris inline kanan-atas ke pill mengambang di kanan-bawah kolom lirik seperti `.blyrics-dock__inner`: padding 8px, gap 4px, radius 14px, `hsla(0,0%,100%,0.06)`, `blur(12px)`, hairline inset, plus state hidden `scale(0.85)` + `blur(8px)`.
- Loader mengikuti `#blyrics-loader`: mark 3.5rem berputar 1.5s dengan teks 2.2rem bold bergradien shimmer 3s, masuk dengan `cubic-bezier(.22,1,.36,1)`. "Lyrics not found" jadi pesan inline tenang (tanpa kartu berbingkai) dengan aksi pemulihan yang sudah ada; Lyrics Off tanpa lirik tetap menampilkan progress bar dan transport di kartu artwork.
- Profile tetap menentukan segalanya: `metadataSlot`/`metadataVisible` memindahkan heading, `artworkVisible` menyembunyikan cover, `controlsVisible: false` kembali ke presentasi lama (kontrol hanya di bar bawah), dan `artwork-right` memirror kolom.
- Verifikasi: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **628/628**; `npm run build:web` lolos; `tests/browser/run-app.mjs` **153/153** (termasuk cek baru untuk wake pointer, idle 3 detik, kursor tersembunyi, popover yang mem-pin, bar matte full-width, dan kontrol kolom); `tests/browser/audit-ui.mjs` **296 pass, 0 fail** (4 blocked, 3 not tested, sama seperti base). `tests/browser/animation-audit.ts` lolos 61 cek lalu berhenti pada `InvalidStateError` saat menyelesaikan animasi shimmer infinite — kegagalan yang sama terjadi di base. `tests/browser/now-playing-layout.ts` lolos 37 cek; probe `openProfileSwitcher` gagal juga di base, sementara tiga assertion yang disesuaikan di sini lolos.
- Dokumentasi: `docs/now-playing-parity.md` memetakan tiap elemen referensi ke implementasi Cadence, mencatat verifikasi, dan menyebut selisih yang disengaja — duplikasi transport saat itu sengaja mengikuti referensi (lalu disederhanakan ke satu bar di entri di atas), like/dislike voting tidak punya padanan (heart = favourite library, shuffle/repeat menempati slot terluar), dan artist/album bukan anchor link.

## `e2342c6` — feat(settings): enumerasi font sistem untuk font selector global

- Daftar font hard-coded diganti pemindaian langsung font yang terpasang. Host Tauri (`src-tauri/src/fonts.rs`, baru) membaca name table sfnt setiap font di direktori font platform — `%WINDIR%\Fonts` + `%LOCALAPPDATA%\Microsoft\Windows\Fonts` di Windows, empat direktori di macOS, dan `fc-list` dengan fallback pemindaian direktori di Linux — lewat `spawn_blocking` sehingga UI thread tidak terblokir. Format ttf/otf/ttc/otc, ID tipografis 16/17 didahulukan, nama Inggris diutamakan lewat `name_rank`, dengan batas ukuran/kedalaman file.
- ID font: `"system"`, `"monospace"`, atau nama family persis dari mesin. ID lama dimigrasi lewat `LEGACY_FONT_PRESETS`, dan `fontStack(id, target)` menghasilkan dua stack: `SYSTEM_FONT_STACK` untuk shell UI dan `LYRICS_DEFAULT_FONT_STACK` (Satoshi-led) untuk lirik. `applyFontFamily` menulis `--font`, `--blyrics-font-family`, dan `data-font-family`.
- `fontsStore` (baru) menyimpan hasil scan dengan `maxAgeMs`, mendukung pencarian, dan refresh saat window kembali fokus atau lewat tombol Refresh (dibatasi 30 detik). Settings → Appearance dan Studio Now Playing menampilkan seluruh family yang terpasang tanpa perubahan kode.
- Family yang tidak tersedia atau sudah dihapus tetap terpilih, dengan hint "“X” is not installed on this device. Cadence falls back to the system font." dan fallback stack yang aman; pilihan bertahan setelah restart karena tersimpan di settings store.
- Satoshi Variable (ITF Free Font License) dibundel beserta `NOTICE.txt` dan atribusi di `UPSTREAM.md`, supaya tipografi default lirik sama dengan Better Lyrics; shell tetap memakai font UI platform untuk `"system"`.
- Verifikasi: `npm run typecheck` lolos; `npm test -- --exclude tests/unit/_matasaburo_full.test.ts` **628/628**; `npm run build:web` lolos; audit UI lolos 86/86 lalu 38/38 termasuk `appearance-font-system-preset-stacks`, `appearance-font-satoshi-bundled`, dan `appearance-font-missing-stays-selected`. **Keterbatasan**: toolchain Rust tidak tersedia di environment ini sehingga `fonts.rs` hanya di-review dan belum pernah dikompilasi — dicatat di `docs/system-fonts.md`.

---

Branch: `feat/ui` (dibuat dari `main` @ `1615d5b`)
Tanggal: 2026-11-19 — 2026-11-21

## `0bdd36d` — feat(ui): MV sebagai background fullscreen Now Playing (early development)

- Video lokal (`.mp4/.webm/.mov/.m4v`) kini bisa jadi background full-bleed di balik UI Now Playing. Decode memakai `<video>` bawaan Chromium, selalu mute, dan tidak menambah dependency. Audio tetap memakai engine yang ada.
- Asosiasi video: sidecar otomatis `<base>-mv.*` didahulukan, lalu `<base>.*`, plus override manual per lagu lewat `trackSourceKey`. Sidecar video tidak lagi ikut terindeks sebagai lagu. MV aktif menggantikan background Kawarp/artwork (termasuk animated art), jadi hanya satu decoder video yang hidup.
- Posisi video mengikuti clock audio: seek, pause/resume, perubahan tab, dan playback rate. Video lebih pendek dari lagu di-loop; video lebih panjang berhenti bareng audio. Scrim gelap bisa diatur lewat setting `mvBackground.scrimOpacity` (default `0.45`), tanpa blur pada video.
- Toggle ada di dock fullscreen (tombol clapperboard) dan di Settings, memakai satu setting yang sama. File rusak/auto-detect gagal fallback ke background lama dengan satu toast per lagu.
- Verifikasi: `npm run typecheck`, `npm run build`, `cargo check` lolos. `npm test` 622 lolos dengan dua failure baseline (benchmark `smartShuffleBenchmark` dan lock `library.test.ts`). Harness browser `tests/browser/mv-background.ts` sudah ditambahkan tapi belum bisa dijalankan karena binary Chromium tidak tersedia (`spawn ...\chromium ENOENT`).

## `4889d60` — feat(ui): dropdown pilih file di lyrics dock (early development)

- Tombol pilih file di dock kini membuka dropdown berisi **Lyrics file** dan **Music video**, mengikuti pola popover tombol Save (satu tombol berisi ikon folder + chevron).
- Opsi **Music video** memanggil picker MV, menyimpan binding `local:<id>`, mengaktifkan background MV, lalu menampilkan toast. User tidak perlu membuka Settings hanya untuk mengganti/attach MV.
- Dropdown mengikuti pola popover dock yang ada: tertutup saat klik di luar, ikut expanded state toolbar fullscreen, dan tidak menimpa tombol Save.
- Harness `tests/browser/mv-background.ts` mendapat asersi untuk menu dua opsi dan binding dari dock. `npm run typecheck` dan `npm run build` lolos.

## Belum di-commit — unify tombol pilih file di lyrics dock

- Split button (folder + chevron terpisah) disatukan jadi satu tombol, supaya tidak ada dua kontrol berdampingan. Klik tombol membuka dropdown dua opsi seperti tombol Save.
- Test browser yang memakai `Open a lyrics file` kini masuk lewat dropdown (`Choose file` → **Lyrics file**). `npm run typecheck` dan `npm run build` lolos.

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
