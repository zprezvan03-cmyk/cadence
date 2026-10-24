# Upstream attribution

Cadence is GPL-3.0 (see `LICENSE`). It contains code ported from two upstream projects, plus two
published packages used unmodified. Every ported file carries the upstream repository, commit,
original path and license in its header.

## Pinned upstream revisions

| Project | URL | Commit | Version | License |
| --- | --- | --- | --- | --- |
| Better Lyrics | https://github.com/better-lyrics/better-lyrics | `18be32089343ec721fbead38c082117e4d44871f` | v3.0.1.1 | GPL-3.0 |
| Better Lyrics (current `main`, provider taxonomy reference) | https://github.com/better-lyrics/better-lyrics | `fd0c4b7d17cbc9f711a726f26e1a9693e723c066` | — | GPL-3.0 |
| Better Lyrics API | https://github.com/better-lyrics/api | `8b0ac346ac90ae38be0636611fcadbe8fe351106` | — | GPL-3.0 |
| Unison | https://github.com/better-lyrics/unison | `71e23cb799fa2e1ad0c81ba3216cc71af51a0b0e` | 1.1.0 | AGPL-3.0-only |
| Better Lyrics Shaders | https://github.com/better-lyrics/shaders | `d878877cb225e1bcfef205c2937141a26112ebec` | v1.5.0 | GPL-3.0 |

Revisions were resolved with `git ls-remote`/`git log -1` against shallow clones of `main` on
2026-10-23 (lyrics API/Unison re-verified 2026-10-24) and pinned in this document and in every
ported file header. Public HTTP contracts were additionally checked against
https://docs.betterlyrics.org (`/reference/get-lyrics`, `/unison`).

## File-by-file mapping

### Ported from Better Lyrics (GPL-3.0)

| Cadence file | Upstream original | Changes |
| --- | --- | --- |
| `src/shared/upstream/better-lyrics/constants.ts` | `src/core/constants.ts` (provider + translation sections) | Typed for strict mode; YT-Music-only constants dropped. Cadence additionally defines the Better Lyrics API/Unison source keys (names and priorities mirroring current upstream `PROVIDER_CONFIGS`), base URLs and timeouts |
| `src/shared/upstream/better-lyrics/providerList.ts` | `src/modules/lyrics/providers/providerList.ts` | Type annotations only |
| `src/shared/upstream/better-lyrics/nonLatinScript.ts` | `src/modules/lyrics/nonLatinScript.ts` | Type annotations only |
| `src/shared/upstream/better-lyrics/utils.ts` | `src/core/utils.ts` (language helpers) | Only the language helpers are ported |
| `src/renderer/upstream/better-lyrics/themes.ts` | `src/options/themes.ts` | Theme registry kept; store/CDN lookups replaced by in-repo themes |
| `src/renderer/upstream/better-lyrics/themes/Default.css` | `public/css/themes/default.css` | Copied verbatim |
| `src/renderer/upstream/better-lyrics/themes/HDR.css` | `public/css/themes/hdr.css` | Copied verbatim |
| `src/renderer/features/lyrics/translationLanguages.ts` | `src/core/translationLanguages.ts` | Generated table, unmodified data |

### Ported from Better Lyrics Shaders (GPL-3.0)

| Cadence file | Upstream original | Changes |
| --- | --- | --- |
| `src/shared/upstream/shaders/gradientSettings.ts` | `shared/constants/gradientSettings.ts` | Interface + defaults; no behaviour change |
| `src/renderer/upstream/shaders/beatAnalysis.ts` | `contents/lib/audioGraph.ts` (analysis loop) + `contents/lib/audioBridge.ts` (clamping) | Host DOM/WebAudio wiring replaced by injected accessors; FFT size, smoothing and 100 ms peak logic preserved |
| `src/renderer/upstream/shaders/artworkBrightness.ts` | `contents/lib/artworkBrightness.ts` | 32×32 percentile sampling and `(1 − 0.8·strength)/highlight` formula preserved |
| `src/renderer/features/shaders/KawarpBackground.tsx` | `contents/lib/kawarpManager.ts` | Extension DOM lookups replaced by props; IntersectionObserver replaced by mount lifetime; added `performanceMode` (resolution/blur scaling only) and a CSS fallback |

### Used unmodified from npm

| Package | Version | License | Role |
| --- | --- | --- | --- |
| `@braccato/core` | 1.16.11 | MIT | The lyrics renderer (`<braccato-lyrics>`): word/letter highlighting, auto-scroll, themes, credits, click-to-seek |
| `@braccato/parsers` | 0.4.0 | MIT | LRC / enhanced LRC / TTML / QRC / SRT parsing |
| `@braccato/types` | 1.0.0 | MIT | Shared lyric types |
| `@kawarp/core` | 1.3.1 | MIT | The Kawarp WebGL shader renderer |

`@braccato/core` and `@kawarp/core` are the same renderers Better Lyrics and Better Lyrics Shaders
ship; they are consumed from npm rather than copied so upstream fixes flow in by version bump.
Versions are pinned (not ranged) because the renderer's CSS class names and element properties are
a public contract.

## Online lyrics providers (new code, not ports)

Cadence's network clients are independent implementations written against the providers' documented
public HTTP APIs. No backend/extension source is copied; only the public request/response contracts
and the extension's source-key taxonomy are reused. All traffic runs in the Electron main process,
carries no credentials, and every provider is keyed on the local file's metadata — a YouTube video
ID is never invented.

| Cadence module | Endpoint(s) | Source keys |
| --- | --- | --- |
| `src/main/lyrics/betterLyrics.ts` | `GET https://api.betterlyrics.org/getLyrics` (`{ ttml }`), `/qq/getLyrics` (QRC), `/kugou/getLyrics` (LRC) — params `s`, `a`, `al`, `d` | `blyrics-richsynced`, `blyrics-wordsynced`, `blyrics-synced` |
| `src/main/lyrics/unison.ts` | `GET https://unison.betterlyrics.org/lyrics?song&artist&album&duration`, then `GET /lyrics/search?…&limit=5` on a clean 404 | `unison-richsynced`, `unison-wordsynced`, `unison-synced`, `unison-plain` |
| `src/main/lyrics/lrclib.ts` | `GET https://lrclib.net/api/get` and `/search` | `lrclib-synced`, `lrclib-plain` |
| `src/main/lyrics/http.ts`, `matching.ts` | — | Shared timeout/error-classification layer and conservative Unicode metadata matching |

Verified behavior and limitations:

- **Unison reads need no key, sign-in or video ID.** Reads accept song/artist metadata; the server
  normalizes the strings, matches duration within ±2 s and prefers album. Writes (submit/vote/report)
  require ECDSA-signed requests and are not implemented. A 404 falls back to the ranked search
  endpoint, whose records are re-validated client-side with the same Sørensen–Dice scoring used for
  LRCLIB plus the ±2 s duration gate, so a fuzzy hit can never be the wrong song. Rate limit is
  120 requests/min/IP; `429` is surfaced as an error, never as a miss or cached.
- **Better Lyrics API is cache-first without a key.** Per the docs and `better-lyrics/api`
  (`handlers.go`, `middleware/apikey.go`), cached songs serve keyless `200`s; an uncached query
  answers `401` because fresh-fetch keys are issued only to the Better Lyrics extension and are not
  redistributed. Cadence sends no `X-API-Key`, treats `401` as a documented limitation (distinct
  from a miss), falls through to the next provider, and never negative-caches it. The QQ/Kugou
  provider endpoints are documented as keyless and still go through the same 401-safe handling.
- The extension's `unified.ts`/Cubey stream remains unusable standalone (Turnstile iframe challenge,
  JWT, cookie credentials, YouTube Music origin, mandatory `videoId`). See *Not ported* below.
- Raw provider text (TTML, QRC, enhanced/LRC, plain) is passed to the renderer untouched; the
  existing `@braccato/parsers` chain preserves syllable/word/line timing and instrumental markers.

## Adaptations (new code, not ports)

These replace the extension's YouTube Music dependencies and are Cadence's own work:

| Cadence module | Replaces |
| --- | --- |
| `src/main/lyrics/service.ts`, `betterLyrics.ts`, `unison.ts`, `lrclib.ts`, `http.ts`, `matching.ts`, `localLyrics.ts`, `cache.ts` | The upstream `unified.ts` provider stream (requires a Turnstile JWT and a `videoId`); keyed on artist/title/album/duration instead |
| `src/main/library/*` | Nothing upstream — local file library, scanning, metadata, artwork, playlists |
| `src/renderer/audio/*`, `player/queue.ts`, `state/*` | The YouTube Music player and DOM; local `<audio>` element and Zustand stores |
| `src/main/index.ts`, `ipc.ts`, `protocol.ts`, `preload/index.ts` | The browser extension's `chrome.*` APIs; Electron main process and IPC |
| `src/renderer/features/lyrics/parseLyrics.ts` | Thin adapter between provider text and the renderer's `Lyric[]` shape |

## Not ported (and why)

| Upstream capability | Reason |
| --- | --- |
| `unified.ts` / Cubey provider stream | Needs a YouTube page origin, a `videoId` and a Turnstile token; not available to a local player. The keyless Better Lyrics API (`api.betterlyrics.org`) and Unison metadata lookups above replace its rich-sync coverage for local files |
| Unison writes (submit, vote, report, revisions) | Require ECDSA P-256 request signing and an extension-held identity; Cadence is a read-only client |
| Better Lyrics API fresh-fetch API key | Keys are exclusive to the Better Lyrics extension and not issued to third parties; Cadence relies on keyless cache hits and documents 401s instead of bundling or bypassing credentials |
| Store-hosted lyric themes (`themes.betterlyrics.org`) | Remote catalog is not reachable from the build environment; the two in-repo themes plus all typography controls ship instead |
| Browser-extension packaging (Plasmo), DOM injection, `MutationObserver` navigation hooks | Extension-only architecture; Cadence owns its own window and routes |
| Video/animated-artwork shader mode | Implemented (`video*` settings, `Kawarp.loadVideo`), but no animated artwork file was available to verify it end to end |

## Third-party licenses of shipped dependencies

| Package | Version | License |
| --- | --- | --- |
| `music-metadata` | 11.x | MIT |
| `react`, `react-dom` | 19.x | MIT |
| `zustand` | 5.x | MIT |
| `lucide-react` | 0.545.0 | ISC |
| `@braccato/core`, `@braccato/parsers`, `@braccato/types` | see above | MIT |
| `@kawarp/core` | 1.3.1 | MIT |

Electron, Chromium and Node.js are distributed under their own licenses (MIT / BSD-style / MIT);
`electron-builder` output includes their notices in `resources/`.

Full license texts for the npm dependencies ship inside each package under `node_modules/*/LICENSE`
and are copied into the packaged app by electron-builder when required.
