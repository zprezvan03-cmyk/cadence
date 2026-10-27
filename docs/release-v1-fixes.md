# Cadence v1.0.0 release fixes

Two focused fixes plus one navigation change, verified in the real rendered UI.

---

## 1. ALAC playback startup

### Root cause

The delay is not in the file, the tags or the audio pipeline: **the WebView cannot decode ALAC at
all**. This is measured, not assumed — the harness feeds the real ALAC fixture to a plain
`<audio>` element and Chromium answers `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) in ~30 ms, while the
same test plays FLAC, MP3, WAV and AAC/M4A in 7–14 ms.

So every ALAC track is decoded by the native bridge (`src-tauri/src/alac.rs`, Symphonia) into a
lossless integer PCM WAV, and *only then* does the `<audio>` element get a source:

```
click → playerStore.loadCurrent → audioEngine.load
      → resolvePlaybackSource → window.cadence.player.prepareAlacSource
      → cmd_prepare_alac_playback → spawn_blocking(decode_alac_to_wav_cached)
      → full-file Symphonia decode + WAV write into <app data>/alac-cache
      → cadence-media URL → element.src → audio
```

The bridge decodes the **whole** file before one sample plays, has no cancellation, and cannot join
concurrent callers. Three consequences, all reproducible:

1. **Queue transitions paid a full decode.** Listening to ALAC One and pressing *next* to ALAC Two
   started ALAC Two's decode only at the moment of the skip: measured **963–980 ms** (with the
   harness modelling a 900 ms decode) versus **57–90 ms** for FLAC/MP3 in the same conditions.
2. **Concurrent requests duplicated the work.** Two loads of the same cold file (double click, a
   queue change while a decode is in flight) each started their own full decode — the second then
   waited behind the first (measured **+800 ms** of avoidable delay on a two-core decode).
3. **The wait was invisible.** The player bar showed a paused track with no indication that a
   decode was running, which reads as a hang.

Metadata parsing, format detection and the WAV streaming path are not the bottleneck: after the
decode, the prepared WAV reaches `canplay` in 7–14 ms like any other file, and seeking inside it is
instant (measured `currentTime = 4.5` after a seek to 4 s).

### Changes

| File | Change |
| --- | --- |
| `src/renderer/audio/playbackSource.ts` | Identical concurrent preparations of the same path share **one** native decode (in-flight map, cleared when it settles, so a replaced file is still re-decoded). The bound bridge function is cached once instead of being re-bound on every load, so the map is actually shared. |
| `src/renderer/audio/engine.ts` | New `prewarm(track)`: resolves the playback source ahead of time. For ALAC that means the decode lands in the on-disk WAV cache, so the later `load()` is a cache hit; for every other codec it returns the stream URL without touching the bridge. |
| `src/renderer/state/playerStore.ts` | After a track actually starts playing, the **next** queue entry is prewarmed (skipped for repeat-one and single-track queues). |
| `src/renderer/features/player/PlayerBar.tsx` | `Preparing audio…` notice, shown only when buffering a *paused* element lasts longer than 260 ms — i.e. only for real work such as an ALAC decode. |
| `src/renderer/styles/global.css` | Styling for that notice (subtle pulse, no layout shift). |

Nothing about decoding changed: same Symphonia path, same integer PCM, same sample rate, bit depth
(16/24/32-bit packing preserved), channel count and seekability. No resampling, no lossy step, no
change to the Rust decoder.

### Measurements (headless Chromium, production `dist/`, real library + real files)

The native bridge is stubbed with a **fixed 900 ms decode model** (`ALAC_DECODE_MS`), serialized to
model shared CPU cores, because this environment has no Rust toolchain to run the real decoder.
Absolute numbers therefore describe the *renderer-side* scheduling, not a specific machine's
Symphonia throughput; the ratio between "waits for a decode" and "does not" is what matters.

| Scenario | Before | After |
| --- | --- | --- |
| FLAC (Chromium decodes it) | 57–113 ms | 57–113 ms |
| MP3 | 59–96 ms | 59–96 ms |
| ALAC, cold, single click (one decode is irreducible) | 977–998 ms | 984–1046 ms (unchanged; 1 decode) |
| ALAC, double click on a cold track | 961–991 ms, 1 decode | 961–1014 ms, 1 decode (now guaranteed; previously two could start) |
| **ALAC → ALAC queue transition ("next")** | **963–980 ms** (decode started at the skip) | **80–115 ms** (decoded in the background while the previous track played) |
| Rapid switch between two cold ALAC files | 1752–1808 ms (2 decodes) | 1752–1808 ms (still 2 — an abandoned decode cannot be cancelled) |

Reproduce with `npm run test:alac` (13 checks) — screenshots in `.artifacts/alac-startup/`,
including `02a-alac-preparing.png` (the notice) and `02-alac-playing.png`.

Verified in that suite: playback starts, `duration` is reported (6 s fixture), time advances,
seeking works, the next track plays, a real double click still produces a single decode for the
clicked file, and no decode notice appears for FLAC/MP3.

### Remaining limitations

- **The first ALAC play of a session always needs one full decode.** That is the decoder, not the
  renderer; hiding it would require streaming PCM or a gapless native output, both out of scope for
  a stability release (and the former risks the exact quality/correctness guarantees the brief
  protects).
- The Rust cache directory is wiped at launch (`src-tauri/src/lib.rs`), so decoded WAVs never
  survive a restart; prewarming therefore helps within a session only.
- A skipped-away ALAC decode cannot be cancelled and finishes in the background.
- The real decoder was not measured here: `cargo`/`rustc` are unavailable in this sandbox. The Rust
  unit tests in `src-tauri/src/alac.rs` (44.1 kHz, 96 kHz, AAC rejection, stale-cache rejection)
  remain the coverage for the decoder itself and were not modified.

---

## 2. Now Playing layout without lyrics

### Root cause

`LyricsView` renders the lyrics renderer and the status card **inside the same scrolling
`.lyrics-body`**. The renderer host (`braccato-lyrics`) is `min-height: 100%`, so in the no-lyrics
state the card was simply pushed *below a full-height empty block* — measured before the fix:

```
body   y=157 h=580  (bottom 737)
panel  y=717 h=175  →  bottom 892  (past the body's bottom, under the dock, off-screen)
```

So the page looked broken: a full page of empty shader with a card half-hidden behind the dock,
and the alignment was left to the scroll container. The same happened for the error state, and the
loading state had no presence at all (a bare, empty area while a lookup ran).

### Changes

| File | Change |
| --- | --- |
| `src/renderer/features/lyrics/LyricsView.tsx` | `.lyrics-body` gets `has-status-panel` while a status is shown; the status card and a new loading card are rendered with a shared structure (icon + heading + copy + actions); the loading card appears only after 350 ms so a local-file resolve never flashes it. |
| `src/renderer/styles/lyrics.css` | `.lyrics-body.has-status-panel` centres its child (flex, no scroll, no fade mask) and hides the empty renderer host so it cannot reserve space. The cards share one width (`min(520px, 100%)`), the error card's button moved into the same action row as the empty state, and the loading card is chrome-less. |

The headings, footer/dock, player bar and body geometry are untouched, so nothing moves when lyrics
appear or disappear:

```
before/after, all states: heading y=94, footer y=737, body x=248 y=157 w=1192 h=580
empty card: x=584 y=315 w=520 → centred in the body (Δx 0, Δy 20), bottom 539 above the dock
```

### Visual verification (real rendered UI, headless Chromium)

Screenshots in `.artifacts/now-playing-layout/`:

- `01-synced-lyrics.png` — synchronized lyrics (line-synced badge, active line highlighted)
- `02-unsynced-lyrics.png` — unsynchronized lyrics (same body geometry as synced)
- `04-loading.png` — "Finding lyrics…" card, centred, frame unchanged
- `03-no-lyrics.png` — "No lyrics found" card centred with *Choose a lyrics file* / *Try again*
- `05-error.png` — "Lyrics could not be loaded" card, same footprint, retry action
- `06-fullscreen-no-lyrics.png` — fullscreen layout: artwork + heading on the left, the card centred
  in the lyrics column above the controls

`npm run test:now-playing` (17 checks) asserts the geometry rather than the pictures: card inside
the lyrics body, horizontally and vertically centred, above the dock, no jump between states,
loading keeps the frame, and the fullscreen card is centred and clear of the controls.

---

## 3. Decode Tester moved into Settings

- Removed from the sidebar (`src/renderer/app/Sidebar.tsx`, including the now-unused `Stethoscope`
  import). The route, view, store and IPC stay exactly as they were — no second implementation.
- It was already reachable from **Settings → Library** (*Open Decode Tester*, next to *Add folder*
  and *Rescan now*), with a one-line explanation of what it does. That is the maintenance/tools
  place the brief asks for, so nothing was added or restructured; the existing entry is now the only
  entry point.
- Checked for leftovers: the `decode-tester` route, `#/decode-tester` hash handling, the view and
  its store are all still referenced by the Settings button and by the app router, so nothing else
  became dead.

Verified in the real app (`npm run test:ui`), screenshots in `.artifacts/screens/`:

- `07-settings.png` / `07b-settings-library.png` — the Library section with *Open Decode Tester*
- `08-decode-tester.png` — the tester opened from Settings: full scan results (broken, missing,
  truncated), keep/remove/export actions all present and working
- Sidebar no longer lists Decode Tester (asserted by `decode-tester-not-in-sidebar`)

---

## 4. Test and build results

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` | **311 / 311** (23 files; +2 new ALAC preparation tests) |
| `npm run test:renderer` | 25 / 25 |
| `npm run test:lyrics-ui` | 40 / 40 |
| `npm run test:providers` | 41 / 41 |
| `npm run test:cache` | 43 / 43 |
| `npm run test:cache:clear` | 13 / 13 |
| `npm run test:alac` (new) | **13 / 13** |
| `npm run test:now-playing` (new) | **17 / 17** |
| `npm run test:ui` | 130 / 150 — the **20 failures are pre-existing** on the base commit (`lyrics-tab-renders`, `lyrics-word-level`, `lyrics-active-line`, `lyrics-follow-seek`, `fullscreen-layout-*`, `lyrics-right-edge-*`, `lyrics-active-not-offset-*`); baseline measured on a clean worktree of `6dfa647`: 128 / 149 with the same 20 plus `settings-tabs-consolidated`. Decode Tester and settings-tab checks now pass. |
| `npm run smoke` | ok (Rust build skipped: no toolchain) |

`run-app.mjs` was updated for the two intended behaviour changes: the Decode Tester is opened
through Settings (plus a new `decode-tester-not-in-sidebar` assertion) and the settings tab list is
now Appearance / Library / Playback / Cache / About.

The version number was not changed.
