# Autofetch Lyrics + Onboarding — architecture assessment & implementation notes

Written before implementation (per spec Part 11 / Final Expectations). The user approved proceeding
with the remake, so this file doubles as the implementation record. The Fetch All bulk job and its
onboarding step were later removed; this document records the surviving Autofetch/Onboarding design.

## 1. Existing systems reused (no duplicates created)

| System | Where | How it is reused |
| --- | --- | --- |
| Provider modules (Better Lyrics, Unison, BiniLyrics, LRCLIB) + local sidecar/embedded slots | `src/main/lyrics/{betterLyrics,unison,binimum,lrclib}.ts`, registry in `src/shared/upstream/better-lyrics/constants.ts` | Untouched. All fetching still goes through `LyricsServiceCore.resolve/searchLyrics`. |
| Provider priority (single source of truth) | `settings.lyrics.providerOrder` (+ `d_` disabled prefix, `src/shared/providerOrder.ts`) | Autofetch and manual search resolve with this order; candidates are still sorted by `providerOrderRank`. No second ordering. |
| Provider orchestration: concurrent fan-out, `definitive` detection, Retry-After backoff, per-request HTTP timeouts | `LyricsServiceCore.runNetworkModules/runModule`, `src/main/lyrics/http.ts` | Extended, not replaced: a central concurrency limiter + per-module timeout now wrap `runModule`; subset runs cover newly-enabled providers. |
| In-flight request sharing | `shareInFlight` in `serviceCore.ts` (metadata-keyed, consumer-counted aborts) | This *is* the shared request coordinator (spec Part 4). Autofetch and manual resolve call the same service instance in the bridge, so overlapping work dedupes here. |
| Lyrics cache (schema v3, per-track bundles, Settings → Cache manager) | `src/main/lyrics/cacheCore.ts` | Extended backward-compatibly: network sections gain `queriedModules`/`enabledKeys` coverage; negative TTL becomes configurable (the Not-Found cooldown). No second database. |
| Playback history | `historyStore` + SQLite `cmd_history_list`, `Track.lastPlayedAt/playCount` | Read by the ordinary history/stats UI; no separate tracker was introduced. |
| Player state | `playerStore.currentTrackId`, bridge `lastPlayerState` | Track changes while playing trigger Autofetch. |
| Settings persistence | `SettingsCore` + `settings.json` via `cmd_write_user_json` | New prefs are fields on the existing settings object; old files gain defaults via `mergeSettings`. |
| Atomic user-JSON persistence | Rust `cmd_write_user_json` / `cmd_bootstrap` | Covers settings, lyrics cache, AI cache and artist images. No extra job payload remains. |
| Renderer lyrics session | `lyricsStore` (Zustand) + `useLyrics` | Autofetch writes into the same store through an extracted `ensureLyricsForTrack`; Now Playing renders the same state. TTML/QRC/LRC parsing, translation and romanization passes are untouched. |

## 2. Architectural conflicts found, and the smallest resolutions

1. **`useLyrics` only runs while Now Playing is mounted**, so nothing fetched on track change.
   → The resolve pipeline was extracted from the hook into module-level
   `ensureLyricsForTrack()`; a tiny app-level subscription (`useAutofetchLyrics`, mounted in
   `App`) calls it on every active-track change. The hook keeps owning translation/romanization.
2. **Negative-cache TTL was a fixed 12 h**; the spec wants a 1–30 day configurable cooldown whose
   changes take effect immediately. → The stored timestamp stays `network.savedAt` (last
   definitive attempt — never a pre-computed retry date); `LyricsCacheCore.setNegativeTtlMs()`
   re-interprets it, wired from Settings in the bridge. Default setting: 7 days. Cores constructed
   without settings (Node tests) keep the legacy 12 h interpretation.
3. **The cache did not record which providers had been queried**, so "search only the remaining /
   newly-enabled providers" was impossible. → Network sections now store `queriedModules` +
   `enabledKeys`. Legacy entries without coverage are treated as complete (their previous
   behaviour: serve from cache), so no migration is needed.
4. **No onboarding existed.** Existing installs must not suddenly get a first-run flow.
   → Onboarding auto-shows only when settings say it never completed *and* no music folder is
   configured yet (true first launch). Replay from Settings forces it regardless. The flow is
   Welcome → Music Library Setup → Preferences → Ready.

## 3. New modules (genuinely necessary)

- `src/renderer/features/lyrics/upgrade.ts` — pure candidate-pick / seamless-upgrade decisions.
- `src/renderer/features/lyrics/useAutofetch.ts` — track-change subscription → `ensureLyricsForTrack`.
- `src/renderer/state/onboardingStore.ts` — onboarding visibility + persisted step.
- `src/renderer/features/onboarding/Onboarding.tsx` — first-launch flow.

## 4. Components modified

`shared/types.ts` (settings fields, `forceRefresh`, bridge API),
`settingsCore.ts` (defaults + clamping), `http.ts` (central `ConcurrencyLimiter`),
`cacheCore.ts` (coverage fields, configurable negative TTL), `serviceCore.ts` (limiter +
per-module timeout, coverage-aware/subset network runs), `src/tauri/bridge.ts` (settings
re-apply), renderer: `lyricsStore.ts` (seamless same-track refresh),
`useLyrics.ts` (extracted two-phase resolve: local/cache fallback first, upgrade second),
`LyricsView.tsx` (loader only when there is nothing to show), `App.tsx`, `TopBar.tsx`,
`SettingsView.tsx`, `uiStore.ts`, `harness.tsx`, `views.css`.

## 5. Testing strategy

`tests/unit/lyricsAutofetch.test.ts` covers the track-change driver using the same mocked-`fetch`
service harnesses as the existing provider suites; the full existing suite is re-run for
regressions, plus `typecheck` and `build`. Shared in-flight behavior remains covered in
`tests/unit/lyricsAudit.test.ts`. The former bulk-job suite was removed together with the feature.

## 6. Known limitations / conscious deviations

- The global limiter bounds provider *module runs* (a module may make two sequential HTTP calls
  internally); it is still one central limiter for every consumer.
- A track found via local lyrics while some providers errored keeps its "inconclusive" coverage,
  so newly-enabled providers can be picked up by the next Autofetch or manual pass.
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
