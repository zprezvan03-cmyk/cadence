# Cadence

A local desktop music player built on **Tauri v2** (Windows WebView2) with the **Better Lyrics**
lyrics engine and **Better Lyrics Shaders** artwork effects built in. Point it at your music
folder; it reads your files, shows word-level karaoke lyrics over an audio-reactive Kawarp
background, and never phones home unless you ask it to fetch lyrics.

GPL-3.0. Upstream attribution and pinned commits: [`UPSTREAM.md`](UPSTREAM.md).

## Install

### Windows production build & installers

Requirements on a Windows build host:
- Node.js ≥ 22.12 and npm ≥ 10
- Rust stable toolchain (`rustup`, ≥ 1.77.2) with the `x86_64-pc-windows-msvc` target + Visual Studio C++ Build Tools
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11; the NSIS/MSI installer also ships Tauri's silent WebView2 bootstrapper fallback)

```bash
npm ci
npm run package:win            # Tauri NSIS (.exe) + MSI (.msi) installers in src-tauri/target/release/bundle/
npm run package:win:portable   # Portable ZIP from the compiled release binary → release/Cadence-0.1.0-win-x64-portable.zip
```

The build is unsigned by default, so Windows SmartScreen will show "Unknown publisher" on first run
(*More info → Run anyway*). A portable ZIP needs no admin rights: unzip and start `Cadence.exe`.

### Development from source

```bash
npm ci
npm run dev            # Vite dev server (http://localhost:1420) + Tauri desktop window
npm run build          # Production frontend bundle in dist/
npm run build:desktop  # Full Tauri production build (frontend + Rust host + platform bundles)
```

## Using it

1. **Add music** — top-right button, or <kbd>Ctrl/Cmd</kbd>+<kbd>O</kbd>. Folders are scanned recursively;
   hidden directories and common system folders are skipped.
2. **Play** — click a row. <kbd>Space</kbd> toggles, <kbd>←</kbd>/<kbd>→</kbd> seek 5 s
   (<kbd>Shift</kbd> or <kbd>Ctrl/Cmd</kbd> = previous/next), <kbd>↑</kbd>/<kbd>↓</kbd> volume,
   <kbd>M</kbd> mute, <kbd>S</kbd> shuffle, <kbd>R</kbd> repeat, <kbd>Q</kbd> queue, <kbd>N</kbd> / <kbd>L</kbd>
   Now Playing, <kbd>F</kbd> / <kbd>F11</kbd> fullscreen Now Playing, <kbd>Ctrl/Cmd</kbd>+<kbd>K</kbd> search,
   <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> rescan library. Hardware media keys and Windows System
   Media Transport Controls (SMTC) work through global shortcuts and the WebView2 Media Session API.
3. **Now Playing** — open the Now Playing tab (sidebar, or the mic button in the player bar). Providers
   run in exact priority order: local `.ttml`/`.qrc` → Better Lyrics API / Unison / Binimum rich-synced →
   Better Lyrics word-synced → local `.lrc` → Unison / Better Lyrics / LRCLIB line-synced → LRCLIB plain →
   embedded tag (USLT/SYLT/`©lyr`/Vorbis `LYRICS`). Use the dock or Lyrics Selector to change source, run a
   manual search (including keyless YouTube link metadata fill), adjust typography, offset (±0.05 s steps),
   translation, romanization, reload, load a file, or save what is on screen as a sidecar `.lrc`.
4. **Shaders** — Settings → Shaders. Opacity, warp, blur passes, animation speed, transition
   duration, saturation, dithering, auto-dim of bright artwork, audio reactivity (beat threshold,
   speed multiplier, scale boost), pause when idle, and a performance mode
   (`high`/`balanced`/`low`/`off`). `off` swaps in the artwork-blur fallback.
5. **Settings → Playback → Appearance** picks the **font** used by the app and the lyrics view from
   system families (sans, serif and monospace stacks). Choices apply immediately, persist across
   restarts, and each stack falls back to a similar system font when the named one is not installed.
6. **Settings → Library** shows folders, rescan, the SQLite engine in use and scan errors;
   **About** lists versions and runtime information.
7. **Decode Tester** (sidebar, or Settings → Library) health-checks your library by really decoding
   every file — beginning, middle and end — through the same Chromium media stack playback uses,
   streamed over the `cadence-media` Range protocol (nothing is loaded wholesale into memory, and
   scanning never modifies files). Corrupt, truncated, inaccessible and unsupported-codec files are
   listed separately with the decoder's error. For each you can **Keep** it (marks it intentionally
   retained; it stays in results unless you enable *Hide kept files*), **Remove** selected files
   (an explicit confirmation lists them first; only confirmed deletions touch disk and leave the
   library), or **Export file list** to a UTF-8 `.txt` with one problematic path per line via a
   native save dialog. Music keeps playing while a scan runs, and a scan can be canceled anytime.

## What it supports

| Format | Playback | Verified |
| --- | --- | --- |
| FLAC | yes | yes, decodes and plays |
| MP3 | yes | yes |
| AAC / M4A | yes | yes |
| WAV (PCM) | yes | yes |
| Ogg Vorbis | yes | yes |
| Opus | yes | yes |
| ALAC (.m4a) | **no** | yes — WebView2/Chromium's FFmpeg demuxer reports `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` |

Unsupported codecs are labelled **no decoder** in the library and produce an actionable message
(*"ALAC is not decodable by Chromium's built-in media stack. Convert the file to FLAC or WAV…"*),
never a silent failure. `src/renderer/audio/codecs.ts` is the single source of truth for this table.

## Architecture

```
src-tauri/src       Tauri v2 Rust host: cadence-media Range protocol, path allowlist, rusqlite DB,
                    rfd native dialogs, reqwest HTTP client + cancellation, single-instance & media keys
src-tauri/capabilities/default.json   least-privilege window capability (no arbitrary shell or fs)
src-tauri/tauri.windows.conf.json     Windows-only window overlay: decorations off for the integrated title bar
src/tauri/bridge.ts WebView2 implementation of window.cadence (CadenceApi) over @tauri-apps/api
src/main/library    runtime-agnostic library store, RangeTokenizer metadata core, artwork cache, scanner
src/main/lyrics     provider orchestration, Better Lyrics/Unison/Binimum/LRCLIB clients, YouTube oEmbed, cache
src/main/media      cross-platform path allowlist and cadence-media URL/Range handler
src/renderer        React 19 shell: routes, library views, player bar, queue, Now Playing, settings
src/renderer/audio  the <audio> clock authority + WebAudio analyser
src/renderer/features/lyrics   Now Playing page, Lyrics Selector, dock and fullscreen controls (Braccato)
src/renderer/features/shaders  Kawarp WebGL background component
src/renderer/upstream           ported upstream modules (headers say where from)
src/shared          cross-runtime contract and ported upstream data
```

### Window chrome

Windows builds run without native decorations (`src-tauri/tauri.windows.conf.json`) so no OS-coloured
caption strip can sit above the app. `src/renderer/app/WindowTitleBar.tsx` draws the replacement title
bar as the first row of the app shell: it continues the sidebar and top-bar surfaces, carries the drag
region (`data-tauri-drag-region` plus the `core:window:allow-start-dragging` capability), and puts
minimize / maximize-restore / close flush in the top-right corner. macOS and Linux keep their native
frames — the Rust side reports `undecorated: false`, so the custom bar is never rendered twice. The bar
covers the first `--titlebar-height` pixels for any view that sizes itself against the viewport
(`--window-chrome-top`), and it steps aside in immersive Now Playing and native fullscreen.

The `<audio>` element is the single timing authority: the lyric renderer binds to it directly, so
seek, pause, rate changes and track switches move the highlight with no second clock to drift.

## Tests

```bash
npm run typecheck    # tsc --noEmit for Node/Tauri bridge and renderer
npm test             # 201 Vitest assertions (library, protocol, providers, search, YouTube, Tauri bridge)
npm run smoke        # fixtures + tests + Vite production build + Tauri config/capability checks
npm run test:renderer # 25 headless Chromium audio/Braccato/Kawarp engine checks
npm run test:ui      # production renderer in headless Chromium: interactive UI suite
```

`npm run test:ui` needs `python3` with `av`, `soundfile`, `numpy`, `mutagen` for the first fixture
generation (`python3 tests/fixtures/generate-audio.py`), and the Chromium build from
`@sparticuz/chromium` (installed as a dev dependency; no download at test time).

On minimal Linux containers the bundled Chromium may need NSS/NSPR shared libraries that ship in
`@sparticuz/chromium`'s `al2023` layer; unpack it and prepend it to the loader path:

```bash
brotli -d node_modules/@sparticuz/chromium/bin/al2023.tar.br -o /tmp/al2023.tar
mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023
LD_LIBRARY_PATH=/tmp/al2023/lib npm run test:ui
```

## Troubleshooting

**"Cadence needs its desktop shell"** — the renderer was opened in a browser outside Tauri. Start it
with `npm run dev` or the packaged app.

**No sound, but the position moves** — check the output device and the volume control; Cadence uses
the system mixer and has no exclusive-mode output.

**A file shows "no decoder"** — see the format table above. Convert to FLAC/WAV.

**Lyrics say "No lyrics found"** — Providers ran and nothing matched. Check the source popover in the
lyrics dock: it lists each provider as `hit`, `miss`, `skipped` (with the reason) or `error` (with the
message, e.g. offline). Placing a `.lrc` next to the file always wins.

**Shaders stutter on an integrated GPU** — Settings → Shaders → Performance mode `low` (halves blur
passes and render resolution); `off` disables WebGL entirely and keeps the blurred-artwork fallback.

**Where is my data?** — `%APPDATA%/app.cadence.player` on Windows,
`~/.local/share/app.cadence.player` on Linux, `~/Library/Application Support/app.cadence.player` on
macOS: `settings.json`, `library.db`, `artwork/`, `lyrics-cache.json`.

## Licenses

Cadence is GPL-3.0 (`LICENSE`). Ported upstream code keeps its GPL-3.0 terms; `@braccato/*` and
`@kawarp/core` are MIT. See [`UPSTREAM.md`](UPSTREAM.md) for commits, file mapping and the full
dependency license list.
