# Cadence

A local desktop music player with the **Better Lyrics** lyrics engine and **Better Lyrics Shaders**
artwork effects built in. Point it at your music folder; it reads your files, shows word-level
karaoke lyrics over an audio-reactive Kawarp background, and never phones home unless you ask it to
fetch lyrics.

GPL-3.0. Upstream attribution and pinned commits: [`UPSTREAM.md`](UPSTREAM.md).

## Status — read this first

This build has been verified **without** a working Electron runtime, because the Electron binary
cannot be downloaded in the environment it was developed in. Concretely:

| Area | How it was verified |
| --- | --- |
| Library scan, metadata, artwork, sidecars, rescan, SQLite + JSON stores | Real files through the real main-process modules (vitest) |
| Playback, pause/resume, seek, next/prev, mute | The production renderer bundle in headless Chromium, real `<audio>` element, real WebAudio |
| Lyrics rendering, word-level highlight, seek-following, fullscreen | Same harness, with the real `@braccato/core` renderer |
| Shader background + animation + audio-reactive wiring | Same harness, WebGL via SwiftShader, pixel sampling before/after |
| Settings persistence across restart | Same harness, reload with persisted state |
| **The Electron window itself** | **Not launched here.** `electron-builder` could not run either (it needs the Electron binary) |

So: the app builds, its logic and UI are tested, but `npm start` / the packaged `.exe` have not been
executed in this environment. Run `npm run dev` on your machine to confirm the shell.

## Install

### From a Windows package (once built on a networked machine)

```
npm ci
npm run package:win            # NSIS installer → release/Cadence-0.1.0-x64.exe (+ release/win-unpacked)
npm run package:win:portable   # ZIP from that win-unpacked → release/Cadence-0.1.0-win-x64-portable.zip
```

The build is unsigned, so Windows SmartScreen will show "Unknown publisher" on first run
(*More info → Run anyway*). A portable ZIP needs no admin rights: unzip and start `Cadence.exe`.

### From source

Requirements: Node.js ≥ 22.12, npm ≥ 10. Python 3 is only needed to regenerate audio test fixtures.

```bash
npm ci
npm run dev        # electron-vite dev server + Electron window
npm run build      # production bundles in out/
npm start          # run the built bundles
```

## Using it

1. **Add music** — top-right button, or *File → Add music folder…*. Folders are scanned recursively;
   hidden directories and common system folders are skipped.
2. **Play** — click a row. <kbd>Space</kbd> toggles, <kbd>←</kbd>/<kbd>→</kbd> seek 5 s
   (<kbd>Shift</kbd> = previous/next), <kbd>↑</kbd>/<kbd>↓</kbd> volume, <kbd>M</kbd> mute,
   <kbd>S</kbd> shuffle, <kbd>R</kbd> repeat, <kbd>Q</kbd> queue, <kbd>N</kbd> Now Playing,
   <kbd>L</kbd> lyrics, <kbd>F</kbd> fullscreen lyrics, <kbd>Ctrl/Cmd</kbd>+<kbd>K</kbd> search.
   OS media keys work through the Media Session API.
3. **Lyrics** — open the Lyrics tab. Providers run in order: local `.lrc`/`.ttml`/`.qrc` next to the
   file → embedded tag (USLT/SYLT/`©lyr`/Vorbis `LYRICS`) → LRCLIB synced → LRCLIB plain. Use the
   dock to change source, typography, offset (±0.05 s steps), translation, romanization, reload, load
   a file, or save what is on screen as a sidecar `.lrc`.
4. **Shaders** — Settings → Shaders. Opacity, warp, blur passes, animation speed, transition
   duration, saturation, dithering, auto-dim of bright artwork, audio reactivity (beat threshold,
   speed multiplier, scale boost), pause when idle, and a performance mode
   (`high`/`balanced`/`low`/`off`). `off` swaps in the artwork-blur fallback.
5. **Settings → Library** shows folders, rescan, the SQLite engine in use and scan errors;
   **About** lists versions and paths.

## What it supports

| Format | Playback | Verified |
| --- | --- | --- |
| FLAC | yes | yes, decodes and plays |
| MP3 | yes | yes |
| AAC / M4A | yes | yes |
| WAV (PCM) | yes | yes |
| Ogg Vorbis | yes | yes |
| Opus | yes | yes |
| ALAC (.m4a) | **no** | yes — Chromium's FFmpeg demuxer reports `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` |

Unsupported codecs are labelled **no decoder** in the library and produce an actionable message
(*"ALAC is not decodable by Chromium's built-in media stack. Convert the file to FLAC or WAV…"*),
never a silent failure. `src/renderer/audio/codecs.ts` is the single source of truth for this table.

Missing/moved files surface as scan errors in Settings → Library; corrupt files stay in the library
flagged, so you can see and remove them instead of wondering where they went.

## Architecture

```
src/main            Electron main: window, menu, IPC, media protocol, settings
src/main/library    scanner, music-metadata extraction, artwork cache, SQLite/JSON store
src/main/lyrics     provider orchestration, LRCLIB client, local files, cache
src/main/media      path allowlist for the cadence-media: protocol
src/preload         contextBridge → window.cadence (the only renderer capability surface)
src/renderer        React shell: routes, library views, player bar, queue, Now Playing, settings
src/renderer/audio  the <audio> clock authority + WebAudio analyser
src/renderer/features/lyrics   lyrics tab and dock (Braccato renderer)
src/renderer/features/shaders  Kawarp background component
src/renderer/upstream           ported upstream modules (headers say where from)
src/shared          cross-process contract and ported upstream data
```

The `<audio>` element is the single timing authority: the lyric renderer binds to it directly, so
seek, pause, rate changes and track switches move the highlight with no second clock to drift.

## Tests

```bash
npm run typecheck    # tsc --noEmit for main and renderer
npm test             # 47 vitest assertions (library, queue, lyrics, LRC parsing)
npm run smoke        # tests + build + bundle sanity checks
npm run test:ui      # production renderer in headless Chromium: 38 interactive checks
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

**"Cadence needs its desktop shell"** — the renderer was opened in a browser. Start it with
`npm run dev` or the packaged app.

**No sound, but the position moves** — check the output device and the volume control; Cadence uses
the system mixer and has no exclusive-mode output.

**A file shows "no decoder"** — see the format table above. Convert to FLAC/WAV.

**Lyrics say "No lyrics found"** — Providers ran and nothing matched. Check the source popover in the
lyrics dock: it lists each provider as `hit`, `miss`, `skipped` (with the reason) or `error` (with the
message, e.g. offline). Placing a `.lrc` next to the file always wins.

**Wrong lyrics match** — LRCLIB is matched on artist/title/album/duration with a Sørensen–Dice score;
rename tags for a better match, or load a file manually from the dock.

**Shaders stutter on an integrated GPU** — Settings → Shaders → Performance mode `low` (halves blur
passes and render resolution); `off` disables WebGL entirely and keeps the blurred-artwork fallback.

**Search finds nothing** — search is over the local library only, and only after a scan finishes
(watch the indicator in the top bar).

**Where is my data?** — `%APPDATA%/Cadence` on Windows, `~/.config/Cadence` on Linux,
`~/Library/Application Support/Cadence` on macOS: `settings.json`, `library.db` (or `library.json`),
`artwork/`, `lyrics-cache.json`, `logs/main.log`.

## Licenses

Cadence is GPL-3.0 (`LICENSE`). Ported upstream code keeps its GPL-3.0 terms; `@braccato/*` and
`@kawarp/core` are MIT. See [`UPSTREAM.md`](UPSTREAM.md) for commits, file mapping and the full
dependency license list.
