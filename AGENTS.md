# AGENTS.md — Handoff: animasi background Now Playing

Status: **selesai diimplementasikan** di commit ini (`feat/ui`). File ini menggantikan handoff lama yang sudah usang dan tetap dipertahankan sebagai catatan keputusan.

## Konteks

- Branch aktif: `feat/ui` (dibuat dari `main` @ `1615d5b`).
- Commit terakhir: `2d984e2 feat(ui): rename Listen Now heading to Home and add changelog`.
- Dua file ini sudah modified sebelum pekerjaan apa pun — **jangan disentuh / jangan di-commit**:
  - `src-tauri/gen/schemas/desktop-schema.json`
  - `src-tauri/gen/schemas/windows-schema.json`
- Perintah: `npm run typecheck`, `npm run build`, `npm test`.

## Masalah

Video `C:\Users\Tyas\Videos\Screen Recordings\Screen Recording 2026-11-19 173421.mp4` menunjukkan saat masuk fullscreen Now Playing: judul lagu dan artwork bergerak dari playbar, tetapi background langsung muncul seketika.

Akar penyebab (sudah diverifikasi dari kode):
- `PlayerLayoutMotion.componentDidUpdate` membatalkan animasi `view-in` / `fs-in` pada `.lyrics-view` supaya artwork + judul tidak double-fade saat handoff.
- Artwork, metadata, dan transport dianimasikan lewat WAAPI dengan id `player-*-handoff`.
- Layer background (`.kawarp-bg` untuk mode *fluid*, `.np-bg` untuk mode lain) tidak punya animasi masuk/keluar sendiri.

## Keputusan pengguna

- Gaya: **geser penuh dari bawah** (`translateY(100%) → 0`), bukan clip-path / fade.
- Dipakai saat **masuk + keluar** fullscreen.
- Kerja dilanjutkan di branch `feat/ui`, commit baru.

## Rencana implementasi

### 1. `src/renderer/features/player/PlayerLayoutMotion.tsx`

- Di `getSnapshotBeforeUpdate`, simpan node + `DOMRect` background fullscreen dengan selector `:is(.kawarp-bg, .np-bg)` di dalam `.lyrics-view.is-fullscreen` (hanya saat transisi melibatkan `fullscreen`, dan hanya kalau `canAnimateLayout()` serta `!reducedMotion`).
- **Masuk fullscreen:** animasikan background yang baru tiba:
  - keyframe `[{ transform: "translateY(100%)" }, { transform: "translateY(0)" }]`
  - `id: "player-background-handoff"`
  - `duration: MOTION_DURATION_MS.scene` (300ms), `easing: MOTION_EASING.settle`, `fill: "both"`
  - masukkan ke array `animations` yang sudah ada supaya ikut `finishMotion`.
- **Keluar fullscreen:** pakai **node asli** yang tersimpan (bukan clone/snapshot layer):
  - kalau node sudah tidak `isConnected` (LyricsView ikut unmount), append sementara ke `document.body`;
  - pin ke rect lama memakai `position: fixed`, `left/top/width/height` dari rect, `margin: 0`, `zIndex: 34` — di atas sidebar/konten (30) tapi di bawah player bar (35) supaya artwork yang terbang tetap di atas;
  - animasikan `translateY(0) → translateY(100%)` dengan id dan timing yang sama;
  - saat selesai / dibatalkan `finishMotion`: kembalikan inline style kalau node masih terpasang, atau `node.remove()` kalau tadi dipindahkan ke body.
- Pindahkan pengecekan `if (!animations.length) return;` **setelah** animasi background ditambahkan.
- Biarkan blok pembatalan `view-in` / `fs-in` apa adanya.

### 2. `src/renderer/styles/lyrics.css`

- Tambah `background: #05050a;` pada `.lyrics-view.is-fullscreen` supaya area di atas layer yang masih naik tidak menampilkan app di belakangnya.
- Tidak perlu keyframe CSS baru; gerak fullscreen dilakukan via WAAPI agar entry/exit memakai satu jalur dan nol js tambahan di komponen lain.
- Reduced-motion sudah ditangani aturan global `[data-reduce-motion="true"]` / `prefers-reduced-motion`.

### 3. `tests/browser/animation-audit.ts`

- Di `freezeAt(120)` setelah klik `open-now-playing` (dekat `fullscreen-enters-with-shared-artwork`), tambah cek bahwa `fsHeld.names` memuat `player-background-handoff`.
- Di blok Escape (`exitState`), cek animations `document.getAnimations()` juga memuat id `player-background-handoff` saat keluar.
- Jangan melemahkan assertion yang sudah ada.

### 4. `CHANGELOG.md`

- Tambah entri untuk commit ini dengan gaya yang sama seperti entri `e41e7f6`, `760d5d9`, `2d984e2` (branch + hash + daftar perubahan + verifikasi).

### 5. Verifikasi & commit

```bash
npm run typecheck
npm run build
npm test
```

- Commit baru di `feat/ui` dengan pesan seperti `feat(ui): animate Now Playing background from player bar`.
- Audit browser: `AUDIT_ONLY` hanya bisa jalan kalau binary Chromium tersedia. Di sesi sebelumnya gagal dengan `spawn C:\Users\Tyas\AppData\Local\Temp\chromium ENOENT`; coba lagi, tapi laporkan kalau masih gagal.

## Catatan

- Durasi 300ms = `--dur-scene`, sama dengan handoff artwork/judul; tidak menambah delay.
- Memakai node asli berarti canvas Kawarp tetap hidup selama animasi keluar — jangan diganti dengan snapshot/clone.
- `data-player-moving` tidak diperlukan untuk rencana ini; jangan menambah flag CSS baru kecuali memang perlu.
- Aturan kerja: inspect before editing, edit minimal, jangan curang pada test, jangan log secret, hormati path/locking Windows.
