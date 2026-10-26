# Global lyrics cache — completion report

Implementation, storage format, UI and the verification that was actually executed for the
**global lyrics cache + Settings → Cache manager** work.

---

## 1. Root cause

The cache that existed before this work (`LyricsCache`, schema v1) was a **remote-only, metadata-keyed
map**: `key(artist, title, album, roundedDuration) → LyricsCandidate[]`. Provider answers were the
only thing it could hold, and it had no idea which track an entry belonged to. Everything below
followed from that single design decision:

| Symptom | Cause |
| --- | --- |
| Lyrics vanished after a restart when they came from a sidecar/tag/hand-picked file/manual pick | Those paths wrote nothing to disk. Only remote payloads were persisted. |
| Two untagged files with the same title shared one entry | The key was built from tags only; missing tags produce identical keys (`"" \| "Song" \| "" \| 0`). |
| Nothing to show in Settings, no way to inspect or delete one song | Entries carried no identity, format, origin, source path or timestamp — only opaque payload arrays. |
| Cached provider lyrics disappeared exactly when they were needed | `localOnly` (Settings → *auto-fetch* off, the app's offline switch) returned **before** the cache was read. |
| A song with no lyrics showed the previous song's lyrics under a "No lyrics found" panel | `BraccatoLyrics` treated `lyrics === null` as "never given one" and kept its last non-empty set. |
| A hand-picked file was re-cached but lost to an automatic provider match | The restored `user-file` candidate was sorted last and the renderer always defaulted to `candidates[0]`. |
| An incomplete provider answer could erase a good entry | Every answer overwrote the stored payload, definitive or not. |

The unit and browser suites written for this feature also found the last three as *real* defects
during verification; all three are fixed (see §5.4).

---

## 2. Architecture

### 2.1 Storage location and format

- **File:** `<app data dir>/lyrics-cache.json`
  - Windows `%APPDATA%\app.cadence.player\lyrics-cache.json`
  - macOS `~/Library/Application Support/app.cadence.player/lyrics-cache.json`
  - Linux `~/.local/share/app.cadence.player/lyrics-cache.json`
- **Schema `version: 3`** — one entry per **track** plus one per manual search:

```json
{
  "version": 3,
  "entries": {
    "track:12": {
      "savedAt": 1761521000000,
      "kind": "track",
      "track": { "id": 12, "title": "Fixture FLAC", "artist": "Harness Artist", "album": "Test Bench", "duration": 6 },
      "candidates": [
        {
          "source": "local-rich", "provider": "Local TTML/QRC",
          "text": "<?xml …>", "syncHint": "richsync", "language": "ja",
          "songwriters": [], "sourceHref": "/music/Fixture FLAC.ttml",
          "format": "ttml", "origin": "local", "cachedAt": 1761521000000
        }
      ],
      "network": { "savedAt": 1761521000000, "negative": false, "candidates": [ … ] }
    },
    "search:harness artist|fixture flac|test bench|6": { "kind": "search", "…": "…" }
  }
}
```

- `candidates[]` = local files, embedded tags, hand-picked files and manual picks.
  `network` = the providers' **definitive** answer, with its own timestamp so the existing
  30-day positive / 12-hour negative TTLs keep working unchanged.
- Every stored candidate keeps the **original payload byte-for-byte** (timings, TTML translations,
  transliterations, QRC word timing, LRC), plus `format`, `origin` (`local`/`manual`/`network`),
  `cachedAt`, sync hint, language, songwriters and the source path/url.
- **Keys:** `track:<library id>` for library tracks (`track:meta:<hash>` only when there is no id),
  `search:<artist|title|album|duration>` for manual searches. Two same-titled files have different
  ids, so they can never collide; a track is never stored twice.
- **Identity check:** an entry is only replayed for the same normalized title/artist/album and a
  duration within 2 s, so a re-tagged file never shows its old lyrics.
- **Migration:** `version` 1/2 files are discarded, not migrated — they hold payloads keyed by
  metadata with no identity, format or origin, so an honest upgrade is impossible and the lyrics are
  one lookup away. Everything else is validated field by field (`normalizeEntry` /
  `normalizeStoredCandidate`): a hand-edited or truncated file loses only the broken entries. Old
  metadata-keyed entries are still readable through `identityFromKey()` for robustness.
- **Atomic writes:** Node adapter writes `<file>.tmp` and `renameSync`s it; the Tauri bridge writes
  through `cmd_write_user_json` → `atomic_write_utf8`. Writes are debounced 500 ms and
  fire-and-forget, failures log and keep the data dirty for the next flush, and
  `persistNow()` is awaited by clear/delete/list so the UI reports real outcomes.
- **Caps:** 800 entries (least-recently-saved trimmed); a byte-identical bundle rewritten within
  60 s is not written again, so re-playing a track does not churn the file.

### 2.2 Read path (`LyricsServiceCore.resolve`)

1. Enabled slots are derived from the user's provider order (`providerOrder`, `d_`-prefixed = off).
2. Local sidecars (TTML/QRC/LRC/SRT/TXT/plain) and the embedded tag are read live — a file the user
   just edited is never stale.
3. The track's cached bundle is loaded (identity-checked).
4. Cached local/manual copies are restored **only when the live source is gone**: a sidecar that
   still exists is never resurrected, an embedded tag is dropped when the track is available, and a
   hand-picked file or manual search pick always comes back.
5. Network: a fresh cached answer short-circuits the lookup; offline (`localOnly`) serves the cached
   answer instead of nothing; otherwise the providers run, and only a **definitive** answer replaces
   the stored one (a timeout, rate limit or undecided answer leaves the previous entry intact).
6. Merge (a manual pick shadows the same provider's automatic row), sort by the user's provider
   order, then write the bundle back.
7. Failures never propagate: provider errors become `providerStatus` rows, cache-write errors are
   logged, and the lyrics that are already on screen are never withdrawn.

### 2.3 Write path — every source

| Source | Entry | Origin | Notes |
| --- | --- | --- | --- |
| Local sidecars TTML / QRC / LRC / SRT / TXT / plain | `track:<id>` → `candidates[]` | `local` | format detected at store time; path kept as `sourceHref` |
| Embedded USLT/SYLT tag | `track:<id>` → `candidates[]` | `local` | parsed with the same inspector as files |
| Hand-picked file (dock → *Open a lyrics file*) | `track:<id>` → `candidates[]` | `manual` | survives restarts and track navigation; **not** limited to library folders |
| Manual search pick (dock → *Search Manually*) | `track:<id>` → `candidates[]` | `manual` | replaces the same provider's automatic row |
| Manual search results | `search:<query>` | `network` | keeps the query so a repeat search works offline |
| LRCLIB, Better Lyrics (TTML/QRC/LRC), Unison, BiniLyrics | `track:<id>` → `network` | `network` | only definitive answers; `negative` for a proven "nothing found" |
| Any future source | same bundle | — | the cache has no per-provider code; anything that returns a validated `LyricsCandidate` through `putTrack`/`rememberCandidate`/`putSearch` is stored identically |

Every candidate passes `inspectLyricsPayload()` before it can be stored: malformed, empty or
timing-less payloads are rejected at the source (and the parse error is reported in the provider
status), so the cache only ever holds something that can actually be rendered.

### 2.4 Renderer

- `useLyrics` restores the user's explicit choice per track (`selectedSources`, persisted in
  `localStorage`), then prefers a hand-picked file, then the ordered candidates. Choosing a file
  records that selection so a later re-resolve keeps it.
- `LyricsCachePanel` (Settings → **Cache**) is the manager; it talks to the main process through five
  bridge methods (`listCache`, `getCacheEntry`, `removeCacheEntry`, `cacheChosenFile`,
  `rememberSelection`) and the existing `clearCache`.
- `BraccatoLyrics` now clears its lines when a resolve finishes with nothing, instead of keeping the
  previous track's set behind the empty panel.

---

## 3. Cache manager (Settings → Cache)

Controls, all exercised in the browser suite:

- **List** — newest first; title — artist, album, stored sources (`Local TTML/QRC, Embedded tag,
  Better Lyrics Line`), formats (`TTML, LRC`), local timestamp, badges for `search` and
  `nothing found`.
- **Filter** — by title, artist, album, source or format; dedicated "nothing matches" state with a
  *Clear filter* action.
- **Stats** — `N entries · 2.4 KB (2,500 bytes)`: the byte figure is the UTF-8 length of the file
  that is actually written (measured, never estimated).
- **Refresh** — re-reads the entries; it does not resolve or fetch anything.
- **Inspect** — per-candidate cards with provider name, format badge, origin badge
  (`LOCAL` / `MANUAL` / `PROVIDER`), sync hint, language, line/translation/romanization counts, the
  original file path or URL, and the stored lines replaying the real parser (timestamps, translation
  and romanization rows). Closes with the X, Escape or a backdrop click.
- **Delete one** — removes exactly that entry, reports already-gone, refreshes the list; only
  `lyrics-cache.json` changes.
- **Clear cache** — confirmation dialog, empties the file, refreshes to the empty state, and reports
  `Lyrics cache cleared (N cached songs removed)`. The legacy *Clear lyrics cache* button in
  Settings → About is kept (same action, same `clearCache` IPC) with its confirmation reworded for
  the global cache; the Cache tab is the manager.
- **States** — loading, empty, filtered-empty, list, plus an error state with `Try again` for a
  failed read/write.

Deleting entries or clearing the cache never touches sidecar lyrics files, audio files, embedded
tags, artwork or the library database.

---

## 4. Files

| Path | What changed |
| --- | --- |
| `src/main/lyrics/cacheCore.ts` | Rewritten storage core: schema v3, per-track bundles, identity, formats/origins, tolerant loading, exact byte stats, list/inspect/remove/clear, TTLs, 60 s identical-write skip, 800-entry cap |
| `src/main/lyrics/cache.ts` | Node adapter (tmp file + rename) — unchanged contract |
| `src/main/lyrics/serviceCore.ts` | Cache-first resolve, local/manual restore rules, definitive-only network writes, offline cache reads, `rememberUserFile` / `rememberSelection` |
| `src/main/lyrics/syncInspection.ts` | Cacheability gate used by every source (unchanged) |
| `src/shared/types.ts` | Cache stats / list / detail / remove types, resolve candidates |
| `src/tauri/bridge.ts` | `listCache`, `getCacheEntry`, `removeCacheEntry`, `cacheChosenFile`, `rememberSelection`; clear/delete await the real write |
| `src/renderer/features/settings/LyricsCachePanel.tsx` | **New** — the manager UI + inspector modal |
| `src/renderer/features/settings/SettingsView.tsx` | New **Cache** tab |
| `src/renderer/features/lyrics/useLyrics.ts` | Persist hand-picked files and manual picks; prefer a hand-picked file; record the selection |
| `src/renderer/features/lyrics/BraccatoLyrics.tsx` | Clear lines when a resolve found nothing |
| `src/renderer/styles/views.css` | Cache panel/inspector styles |
| `tests/unit/lyricsCacheManager.test.ts` | **New** — 17 tests over a real cache file and the real service |
| `tests/browser/lyrics-cache-manager.ts` | **New** — 43-check end-to-end suite (real bundle, real service, real HTTP bridge) |
| `package.json` | `test:cache` now runs the manager suite; the focused clear suite is `test:cache:clear` |

---

## 5. Verification actually executed

### 5.1 Commands and results (this working tree)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.node.json` | clean |
| `npx tsc --noEmit -p tsconfig.web.json` | clean |
| `npx vitest run` | **309 / 309 tests, 23 files** (17 of them new in `lyricsCacheManager.test.ts`) |
| `npm run test:renderer` | **25 / 25** |
| `npm run test:lyrics-ui` | **40 / 40** (decoration/translation/romanization regressions) |
| `npm run test:providers` | **41 / 41** (provider identity, sidecars, manual search) |
| `npm run test:cache` | **43 / 43** (new end-to-end manager suite) |
| `npm run test:cache:clear` | **13 / 13** (focused clear + failed-write retry suite) |
| `npm run smoke` | ok (Rust build skipped — no toolchain in this environment) |

`npm run test:cache` boots the **production `dist/` bundle** in headless Chromium with
`window.cadence` bridged to the real `LyricsServiceCore`/`LyricsCacheCore`/`LibraryStore` over HTTP on
port 4795, against a temporary library and a real `lyrics-cache.json`; provider HTTP is stubbed so
requests, offline mode, 404s and failures can be driven deterministically. It writes screenshots to
`.artifacts/lyrics-cache/` (`01-now-playing-local-ttml` … `09-after-clear`) and a full run log.

### 5.2 The 43 end-to-end checks, by scenario

- **Local TTML with translation + romanization + word timing** — `local-ttml-renders`,
  `cache-lists-local-entry`, `cache-row-shows-source-and-format`, `cache-stats-show-exact-bytes`,
  `inspector-shows-original-translation-romanization`, `inspector-reports-word-timing`
- **Local LRC and other formats** — `local-lrc-renders`
- **Embedded tags** — `embedded-tag-is-cached`, `cache-row-shows-embedded-source`,
  `cache-covers-every-source`
- **Network providers** — `network-only-renders`, `network-only-fetched`
- **Track identity** — `identical-metadata-tracks-have-separate-entries`,
  `twin-track-gets-its-own-entry-after-playing`, `rapid-switch-shows-the-last-track`,
  `no-lyrics-track-is-empty`
- **Manual search selection** — `manual-search-result-is-shown`, `manual-selection-is-cached`
- **Hand-picked file** — `chosen-file-renders`, `chosen-file-is-cached`,
  `chosen-file-survives-restart`
- **Navigation / no refetch** — `navigation-keeps-lyrics-without-refetch`,
  `cache-refresh-does-not-resolve`, `cache-refresh-restores-list`
- **Offline + restart** — `restored-manual-selection-plays-offline`,
  `offline-network-lyrics-come-from-cache`, `offline-local-lrc-plays`,
  `offline-restart-makes-no-provider-calls`, `cache-survives-restart`
- **Manager list / filter / states** — `cache-loading-state`, `cache-filter-narrows-the-list`,
  `cache-filter-empty-state`, `cache-error-state`, `cache-recovers-after-error`
- **Delete one / clear all** — `delete-one-removes-only-that-entry`,
  `clear-empties-the-file`, `clear-shows-empty-state`, `cancelled-clear-keeps-the-cache`
- **User data untouched** — `delete-one-keeps-sidecar-file`, `delete-one-keeps-library-track`,
  `clear-keeps-user-files`, `clear-keeps-lyrics-rendering`
- **Repopulation** — `cache-repopulates-after-clear`

### 5.3 Real UI inspection

The screenshots in `.artifacts/lyrics-cache/` were opened and checked by hand:

- `02-cache-list.png` — `1 entry · 2.4 KB (2,500 bytes)`, row
  `Fixture FLAC — Harness Artist / Test Bench · Local TTML/QRC, Embedded tag, Better Lyrics … ·
  TTML, LRC · Oct 26, 2026, 01:41 PM`.
- `03-cache-inspector.png` — three candidate cards (`Local TTML/QRC` `TTML` `LOCAL` `richsync` `ja`
  `2 lines · 1 translated · 1 romanized · 2 word-timed` with `ROMANIZATION sakura ga saku` /
  `TRANSLATION Cherry blossoms bloom`, `Embedded tag` `LRC` `LOCAL`, `Better Lyrics Line` `TTML`
  `PROVIDER`), original path/URL under each header.
- `05-cache-error-state.png` — `Could not read the lyrics cache / disk unavailable (harness) /
  Try again`, stats kept from the last good read.
- `09-after-clear.png` — `0 entries · 26 B (26 bytes)`, `The lyrics cache is empty`, toast
  `Lyrics cache cleared (7 cached songs removed)`, *Clear cache* disabled.

### 5.4 Three product defects found and fixed during verification

1. **Offline ignored cached provider lyrics** — `resolveNetwork()` returned "skipped" for
   `localOnly` before looking at the stored answer. Cached remote lyrics now play offline
   (`offline-network-lyrics-come-from-cache`).
2. **A lyric-less track kept the previous track's lines** on screen under the empty panel;
   `BraccatoLyrics` now clears on `noLyrics`.
3. **A restored hand-picked file lost to an automatic provider match** after a restart; the
   renderer now prefers `user-file` when no explicit selection exists, and choosing a file records
   the choice.

---

## 6. Remaining limitations

- **No native build here.** `cargo`/`rustc` are not installed, so the Tauri side is verified through
  the TypeScript bridge with `mockIPC` (list/inspect/delete over the real IPC contract) plus the
  `atomic_write_utf8`/`cmd_write_user_json` code path read but not compiled in this environment.
- **v1/v2 cache files are dropped, not migrated** (documented above); expect one cold lookup per
  track after upgrading.
- **Local files are re-read on every resolve.** That keeps sidecar edits instant; the cached copy is
  the fallback when the file is gone and what the manager lists. There is no mtime/size shortcut.
- **Offline = Settings → auto-fetch off** (the request's `localOnly` flag). There is no network-state
  detection, so when a provider call simply fails the app still attempts the request before falling
  back to the cache.
- **800-entry cap** with LRU-by-`savedAt` trimming; no per-entry byte size, no export/import, no
  "cache location" actions in the UI.
- The cache is per machine and per user profile; nothing is synced.
- `tests/browser/cache-clear.ts` is kept as the focused clear/failure suite (`npm run test:cache:clear`);
  `lyrics-cache-manager.ts` is the full end-to-end suite (`npm run test:cache`).
