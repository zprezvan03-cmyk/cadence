# Autofetch Lyrics + Fetch All Lyrics + Onboarding — architecture assessment & implementation notes

Written before implementation (per spec Part 11 / Final Expectations). The user approved proceeding
with the remake, so this file doubles as the implementation record; deviations are called out in §6.

## 1. Existing systems reused (no duplicates created)

| System | Where | How it is reused |
| --- | --- | --- |
| Provider modules (Better Lyrics, Unison, BiniLyrics, LRCLIB) + local sidecar/embedded slots | `src/main/lyrics/{betterLyrics,unison,binimum,lrclib}.ts`, registry in `src/shared/upstream/better-lyrics/constants.ts` | Untouched. All fetching still goes through `LyricsServiceCore.resolve/searchLyrics`. |
| Provider priority (single source of truth) | `settings.lyrics.providerOrder` (+ `d_` disabled prefix, `src/shared/providerOrder.ts`) | Autofetch, Fetch All and manual search all resolve with this order; candidates are still sorted by `providerOrderRank`. No second ordering. |
| Provider orchestration: concurrent fan-out, `definitive` detection, Retry-After backoff, per-request HTTP timeouts | `LyricsServiceCore.runNetworkModules/runModule`, `src/main/lyrics/http.ts` | Extended, not replaced: a central concurrency limiter + per-module timeout now wrap `runModule`; subset runs for newly-enabled providers. |
| In-flight request sharing | `shareInFlight` in `serviceCore.ts` (metadata-keyed, consumer-counted aborts) | This *is* the shared request coordinator (spec Part 4). Autofetch, Fetch All and manual resolve all call the same service instance in the bridge, so overlapping work dedupes here. |
| Lyrics cache (schema v3, per-track bundles, Settings → Cache manager) | `src/main/lyrics/cacheCore.ts` | Extended backward-compatibly: network sections gain `queriedModules`/`enabledKeys` coverage; negative TTL becomes configurable (the Not-Found cooldown). No second database. |
| Playback history | `historyStore` + SQLite `cmd_history_list`, `Track.lastPlayedAt/playCount` | Fetch All queue order reads the same history rows via the bridge; no new tracker. |
| Player state | `playerStore.currentTrackId`, bridge `lastPlayerState` | Current-track queue priority + dynamic promotion. |
| Settings persistence | `SettingsCore` + `settings.json` via `cmd_write_user_json` | New prefs are fields on the existing settings object; old files gain defaults via `mergeSettings`. |
| Atomic user-JSON persistence | Rust `cmd_write_user_json` / `cmd_bootstrap` | One new file kind (`lyricsFetchJob` → `lyrics-fetch-job.json`) for the persistent job. |
| Renderer lyrics session | `lyricsStore` (Zustand) + `useLyrics` | Autofetch writes into the same store through an extracted `ensureLyricsForTrack`; Now Playing renders the same state. TTML/QRC/LRC parsing, translation and romanization passes are untouched. |

## 2. Architectural conflicts found, and the smallest resolutions

1. **Bridge `lyrics.resolve` aborts the previous resolve globally** (`resolveController` in
   `src/tauri/bridge.ts`, covered by `tauriBridge.test.ts`). Naïvely running Fetch All through
   `bridge.lyrics.resolve` would abort Now Playing lookups and vice versa.
   → Fetch All lives *inside* the bridge beside the service and calls
   `LyricsServiceCore.resolve` directly with its own per-track `AbortController`s. The UI resolve
   keeps its existing consumer-abort behaviour; `shareInFlight` only aborts the shared network
   work when its last consumer leaves, so an aborted UI resolve never cancels a Fetch All waiter
   (and the result is still cached).
2. **`useLyrics` only runs while Now Playing is mounted**, so nothing fetched on track change.
   → The resolve pipeline was extracted from the hook into module-level
   `ensureLyricsForTrack()`; a tiny app-level subscription (`useAutofetchLyrics`, mounted in
   `App`) calls it on every active-track change. The hook keeps owning translation/romanization.
3. **Negative-cache TTL was a fixed 12 h**; the spec wants a 1–30 day configurable cooldown whose
   changes take effect immediately. → The stored timestamp stays `network.savedAt` (last
   definitive attempt — never a pre-computed retry date); `LyricsCacheCore.setNegativeTtlMs()`
   re-interprets it, wired from Settings in the bridge. Default setting: 7 days. Cores constructed
   without settings (Node tests) keep the legacy 12 h interpretation.
4. **The cache did not record which providers had been queried**, so "search only the remaining /
   newly-enabled providers" was impossible. → Network sections now store `queriedModules` +
   `enabledKeys`. Legacy entries without coverage are treated as complete (their previous
   behaviour: serve from cache), so no migration is needed.
5. **Cache is keyed per library track id**, while duplicate detection is recording-level.
   → Conservative recording clusters (normalized artist+title, duration within 2 s, version
   tokens kept distinct) share *network* results by copying the network section between the
   per-track entries (`shareRecordingResult`); local/manual candidates are never copied.
6. **No onboarding existed.** Existing installs must not suddenly get a first-run flow.
   → Onboarding auto-shows only when settings say it never completed *and* no music folder is
   configured yet (true first launch). Replay from Settings forces it regardless.

## 3. New modules (genuinely necessary)

- `src/main/lyrics/fetchAllCore.ts` — runtime-agnostic persistent Fetch All job engine
  (queue build with chunked pagination, priority + dynamic promotion, duplicate sharing,
  pause/resume/cancel/retry-failed, classification, debounced persistence, restart restore).
- `src/main/lyrics/recordingIdentity.ts` — conservative duplicate-recording clustering.
- `src/renderer/features/lyrics/upgrade.ts` — pure candidate-pick / seamless-upgrade decisions.
- `src/renderer/features/lyrics/useAutofetch.ts` — track-change subscription → `ensureLyricsForTrack`.
- `src/renderer/state/fetchAllStore.ts`, `src/renderer/state/onboardingStore.ts` — UI mirrors.
- `src/renderer/features/lyrics-fetch/{FetchAllIndicator,FetchAllSettings}.tsx` — top-bar + Settings UI.
- `src/renderer/features/onboarding/Onboarding.tsx` — first-launch flow.

## 4. Components modified

`shared/types.ts` (settings fields, `forceRefresh`, job snapshot types, bridge API),
`settingsCore.ts` (defaults + clamping), `http.ts` (central `ConcurrencyLimiter`),
`cacheCore.ts` (coverage fields, configurable negative TTL), `serviceCore.ts` (limiter +
per-module timeout, coverage-aware/subset network runs, `assessTrack`, `shareRecordingResult`),
`src/tauri/bridge.ts` (job wiring, settings re-apply), `src-tauri/src/commands.rs`
(bootstrap + write kind), renderer: `lyricsStore.ts` (seamless same-track refresh),
`useLyrics.ts` (extracted two-phase resolve: local/cache fallback first, upgrade second),
`LyricsView.tsx` (loader only when there is nothing to show), `App.tsx`, `TopBar.tsx`,
`SettingsView.tsx`, `uiStore.ts`, `harness.tsx`, `views.css`.

## 5. Testing strategy

New Vitest suites (`tests/unit/lyricsAutofetch.test.ts`, `tests/unit/lyricsFetchAll.test.ts`)
map onto the spec's 25 cases using the same mocked-`fetch` service harnesses as the existing
provider suites; the full existing suite is re-run for regressions, plus `typecheck` and `build`.

## 6. Known limitations / conscious deviations

- The global limiter bounds provider *module runs* (a module may make two sequential HTTP calls
  internally); it is still one central limiter for every consumer.
- A track found via local lyrics while some providers errored is classified `found` for the job;
  the unchecked providers are picked up by the next Fetch All / Autofetch pass (coverage fields).
- Paused jobs stay paused across restarts (user intent); *running* jobs auto-resume.
- “Fetch history” in Settings shows the latest persisted job (summary + retry), not an
  ever-growing log — bounded storage by design.
- Existing pre-feature failure, untouched: `tauriBridge.test.ts` expects tauri.conf version
  `0.2.2` but the repo ships `1.0.0` (1 of 322 tests, pre-existing).
- Onboarding auto-show requires a completely untouched library (zero folders *and* zero
  tracks), not merely zero folders: an install whose folders were removed after scanning is
  not a first launch, and test harnesses with scanned fixtures must never see the flow.
- Autofetch fires when a track starts *playing* (track change while playing, or pressing
  play). A queue restored at launch sits paused; fetching for it before the user presses
  play would spend network — and silently re-populate a just-cleared cache — on every
  startup for lyrics nobody asked for yet. Opening Now Playing still resolves immediately
  regardless of playback state, exactly as before.
- Seamless-upgrade empty handling distinguishes *inconclusive* from *definitive*: an empty
  result while providers timed out/errored keeps fallback lyrics on screen, while a
  definitive empty result (true Not Found, or the user disabling the on-screen provider)
  clears to the empty state, stale source rows included.
- Clearing the lyrics cache or removing an entry in Settings invalidates the renderer's
  resolution memo (`invalidateLyricsResolution`), so deleted candidates stop being served
  from the in-memory session on the next resolve; on-screen lyrics are untouched until then.
