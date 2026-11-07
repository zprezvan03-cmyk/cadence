# Stage 7 — Integrated YouTube Music Architecture and Feasibility Gate

**Date:** 2 November 2026; implementation record updated 3 November 2026  
**Status:** **Superseded for the product UI by the user’s removal decision.** The Option A / Native Cadence Integration checkpoint remains recoverable in Git history (`c45b795` code, `7e7703f` build trigger, `a188fb2` artifact, `ea15add` cleanup; `Cadence-7.exe` on Drive), but it was rejected as still feeling like YouTube search/results plus an embedded player. The active product branch therefore removes the YouTube Data API catalog and IFrame experience from Cadence’s main UI. No remote provider is registered in this build, and no further YouTube playback implementation should be attempted unless a documented, appropriately licensed backend contract is supplied.
**Current scope decision:** preserve only reusable provider-ready architecture—source-aware media/queue/history identity, original-vs-mechanism separation, source badges, generic artwork handling, and the provider-agnostic remote playback clock—while keeping local playback, Now Playing, Queue, History/Recently Played, and lyrics as the product.

## Executive decision

### Native ArchiveTune-style playback: **NO-GO under the stated constraints**

ArchiveTune’s anonymous native experience is technically built on YouTube’s undocumented InnerTube interfaces. Its current playback path also depends on some combination of visitor/session context, BotGuard PO tokens, player-response inspection, player JavaScript analysis/deobfuscation of signature or `n` parameters, custom client headers, and short-lived extracted stream URLs.

Those mechanisms conflict with this project’s explicit prohibitions and with YouTube’s documented developer rules. Cadence must therefore not silently reproduce ArchiveTune’s transport or playback resolver.

### What is feasible

1. **Official YouTube Data API v3 for public catalog metadata**, if the user supplies their own API key locally.
   - No Google account login, OAuth flow, password, cookie, or personal account synchronization inside Cadence.
   - The key identifies a Google Cloud project; creating it happens outside Cadence.
   - Cadence cannot ship one shared key in the repository or executable.
   - Results are YouTube **videos, channels, and playlists**, not first-class YouTube Music songs, albums, or artists.
2. **Link-based metadata without an API key** for user-pasted videos, using the metadata/player information already used by the Phase B prototype.
   - This supports genuine user-supplied YouTube Music links.
   - It does not provide catalog search, suggestions, charts, Explore, or album discovery.
3. **The official visible IFrame player as the playback mechanism**, only if explicitly approved as Stage 7’s final playback mechanism.
   - Cadence remains the surrounding UI and owns search presentation, queue, lyrics, history, and playlists.
   - The audiovisual stream does **not** pass through Cadence’s local audio engine.
   - The player must remain visible at compliant sizes while playing.

If neither a user-supplied Data API key nor the official player is approved, Stage 7 should stop at link metadata/discovery research rather than pretending native Catalog + playback parity exists.

## Reference research

Pinned references inspected:

- ArchiveTune: `rukamori/ArchiveTune@c7f0e243c637e039bce4b92fecdf7179804114fb`
- ArchiveTune’s pinned core submodule: `rukamori/core@fefeefa4a8e74d80b262ad944f5adca6b1a897f7`
- ArchiveTune’s pinned stream resolver submodule: `rukamori/morideobfuscator@9dfc70f9b072c681b09acaa993c548f8d3fbced8`
- Standalone `rukamori/core` head at inspection time: `1bc75324170d497887d6676912bdf97626cd352f`; conclusions about the delivered ArchiveTune app use its pinned submodule, not the newer standalone head.
- Both projects declare GPL-3.0. This document uses architectural observations only; no source should be copied into Cadence.

### ArchiveTune patterns worth learning from

- A provider boundary converts network renderers into domain items and page objects.
- Search has summaries, typed filters, and continuations.
- Album, artist, playlist, home, explore, chart, related, and queue pages are separate provider operations rather than UI scraping.
- Queue behavior is abstracted across list queues, playlist queues, radio/automix, and continuations.
- Playback owns stream expiry, failed-client backoff, recovery, preload, and persistent queue state.
- Lyrics are provider-based and driven by a playback clock abstraction.
- Local library entities, search history, lyrics, playlists, and playback history have explicit persistence models.

### ArchiveTune mechanisms Cadence must not adopt

- `InnerTube.browse`, `search`, `player`, `next`, `get_queue`, account, like, subscription, and playlist-write endpoints are undocumented service interfaces, regardless of whether a request carries a login cookie.
- Anonymous operation still creates/persists visitor data and initializes BotGuard. It means “no personal account cookie,” not “no session identifier.”
- When a cookie exists, the core can derive SAPISID-based authorization. Cadence must not collect or store that material.
- `YouTube.player` defaults to a login-capable request path. With no cookie it may send no login headers, but the request still uses visitor/session context.
- The current resolver selects anonymous/authenticated InnerTube clients, creates a session with visitor data and a session PO token, requests a video PO token, accepts only usable audio formats, downloads/analyzes player data when deciphering is needed, applies `pot`, and returns a stream URL plus client-specific headers.
- Playback failures explicitly include login required, unavailable, no format, PO token, decipher, network, HTTP, and timeout cases. Stream expiry can fall back to five minutes; HTTP 403/404/410/416 are treated as retryable stream failures.

## Catalog feasibility

### Officially supported public catalog: YouTube Data API v3

The Data API’s `search.list` returns matching **video, channel, and playlist** resources. It does not return native YouTube Music song, album, or artist objects.

| Requested capability | Official Data API approach | Honest Cadence label | Limitations |
|---|---|---|---|
| Search suggestions | No documented Data API suggestions endpoint found | Not supported | Do not use undocumented suggest endpoints. Submit/debounce full search instead. |
| Song search | `search.list` with `type=video`, Music category, `videoEmbeddable=true`; batch `videos.list` for duration/status | “YouTube tracks” or music-video results | A video is not a song object; artist/album extraction from title/channel is heuristic. |
| Artist search | `search.list` with `type=channel`; `channels.list` for details | “Artists / channels,” with channel detail pages | A channel is not guaranteed to be a canonical YTM artist entity. |
| Channel/artist page | `channels.list`, uploads playlist, `playlists.list`, optional channel-scoped searches | Channel page using Cadence detail layout | Discography ordering and album identity are inferred, not canonical YTM data. |
| Album browsing/pages | No album resource | Not a true album | A public playlist may represent an album, but Cadence must call it a playlist/collection. |
| Public playlists | `playlists.list` by ID/channel and paged `playlistItems.list`; batch `videos.list` | YouTube playlist | Deleted/private items and embed restrictions require per-item handling. |
| Charts | `videos.list` with `chart=mostPopular`, region, Music category | “Trending music videos” | Not the YouTube Music charts product surface. |
| Explore | Compose trending + a small number of cached category searches | Cadence-curated YouTube shelves | Not YTM Explore; avoid many search calls. |
| New releases | `search.list` ordered by date with `publishedAfter`, Music category | “New music videos” | Upload date is not a canonical album/single release date. |
| Related content | Same-channel uploads and explicit follow-up searches | “More from this channel” / “Similar searches” | No equivalent-to-YTM related endpoint should be claimed. |
| Personal library/history/likes | OAuth/account-only surfaces; no YTM listening-history API | Not supported | Explicitly excluded by anonymous-only requirements. |

### Credentials and quota

- A Data API request needs either OAuth or an API key. Stage 7 must use only an **API key**, never OAuth.
- Recommended setup:
  1. The user creates/selects a Google Cloud project outside Cadence.
  2. The user enables YouTube Data API v3.
  3. The user creates an API key and restricts it to YouTube Data API v3.
  4. The user pastes it into a masked Cadence Settings field on their own machine.
  5. The key is never sent to the agent, committed, logged, or included in diagnostics.
- Current documented defaults are **100 `search.list` calls/day** and **10,000 units/day combined for other endpoints**. Typical `videos.list`, `channels.list`, `playlists.list`, and `playlistItems.list` calls cost one unit each.
- Search therefore cannot run on every keystroke. One submitted music-video search plus one batched details call is the default; channel and playlist tabs load lazily.
- A developer-hosted proxy could avoid local key setup, but it adds server cost, abuse controls, privacy/terms review, and quota/audit obligations. It is not recommended for this personal desktop stage.

### Undocumented catalog methods

ArchiveTune’s suggestions, search summaries, filtered search, album songs, artist items, playlist continuations, home, explore, new releases, charts, related, next/queue, library, and history methods are all InnerTube-backed. Some public methods can operate without an account cookie, but “publicly reachable” is not the same as documented or authorized for a third-party client. They are **unsupported for Cadence**.

Account-only ArchiveTune paths include account menu/channels, library synchronization, recent account activity, YTM music history, likes, subscriptions, uploads, and playlist writes. They remain out of scope even beyond the InnerTube issue.

## Native playback feasibility

| Criterion | Extracted InnerTube streams | Official visible IFrame player |
|---|---|---|
| Authorization | Undocumented endpoint plus PO/deobfuscation mechanisms | Documented playback surface |
| Formats | Opus/WebM, AAC/M4A and other muxed/adaptive formats; profile varies | Managed by YouTube player |
| Cadence engine | Would need HTTP/range/header handling and error recovery around expiring URLs | Does not use Cadence EQ/ReplayGain/analyser/crossfade/gapless |
| Seek/duration | Possible only while URL and range behavior remain valid | `seekTo`, `getCurrentTime`, `getDuration`, rate/state APIs |
| Buffering | App must diagnose CDN/client/403/expiry failures | Player reports buffering/error states; internals remain YouTube-managed |
| Expiration | Minutes-scale expiry and client backoff/re-resolution | Player manages media delivery |
| Unsupported content | Login/bot checks, age/private/member/DRM/OTF/no-format failures | Non-embeddable, deleted/private, regional, age/sign-in and policy blocks remain possible |
| Cleanup | Cancel resolvers/requests and invalidate URL/session caches | Pause and `destroy()` on unmount |
| Background use | Would promote separated audio/background playback | Must stop/pause when not visibly presented |
| Verdict | **Unsupported** | **Feasible only with explicit approval and visible-player constraints** |

The IFrame API documents `seekTo`, `getPlayerState`, `getCurrentTime`, and `getDuration`. Required Minimum Functionality requires at least a 200×200 viewport, recommends 480×270 for 16:9, and restricts scripted autoplay until more than half the player is visible.

No documented public YouTube Music catalog/playback API equivalent to ArchiveTune’s InnerTube stack was found in Google’s developer documentation. Content ID/partner music resources are for rights/admin workflows, not an anonymous consumer music client.

## Cadence’s current starting point

### Existing local architecture

- `Track` is intentionally local: numeric `id`, filesystem `path`, local stream URL, tags, ReplayGain, file information, and local artwork.
- `usePlayer` queues `number[]`; all play/queue/session operations resolve numeric local tracks.
- Manual playlists persist `trackIds: number[]` inside a JSON playlist payload in the existing SQLite `playlists` table.
- History uses the same `library.db`; `listening_history.track_id` is currently `INTEGER NOT NULL`, and payloads contain a local track ID/path snapshot.
- Existing Search returns local `Track[]`; Songs/Albums/Artists are projections of the local library snapshot.
- `LyricsView` and `useLyrics` are local numeric-track oriented.
- The Tauri bridge already has runtime-fetch, AbortController, lyrics-service, caching, and user-supplied credential patterns that a catalog core can follow without a new dependency.

### Current Phase B prototype

The branch already contains an isolated paste-link IFrame prototype with:

- validated video IDs and canonical source URLs;
- `youtube:<videoId>` in-memory identity;
- official player controls and player-reported metadata;
- a sampled remote playback clock;
- a remote lyrics hook over the existing metadata-only lyrics search;
- local/remote mutual pause;
- route-unmount destruction and visibility guards.

It is **not** the final integrated Stage 7 UI:

- it has a dedicated YouTube route;
- it is not in the existing Now Playing/Lyrics view;
- it does not participate in the main PlayerBar, Queue, History, playlists, or catalog search;
- real Windows desktop playback with actual YouTube videos was not performed in this sandbox and remains unproven.

## Proposed integrated architecture

### Domain model

Do not extend local `Track` with fake paths or IDs. Add provider-neutral presentation/playback models beside it:

```ts
type TrackSource =
  | { kind: "local"; trackId: number }
  | {
      kind: "youtube-music";
      remoteId: string;
      canonicalUrl: string;
    }
  | {
      kind: "youtube";
      remoteId: string;
      canonicalUrl: string;
    };

interface MediaItem {
  source: TrackSource;
  title: string;
  artistLabel: string;
  albumLabel?: string | null;
  durationSeconds?: number | null;
  artworkUrl?: string | null;
  channel?: { id: string; title: string } | null;
  playlistContextId?: string | null;
  availability: "ready" | "unknown" | "not-embeddable" | "unavailable" | "live";
  fetchedAt?: number;
}
```

Reserve `youtube-music` for user-supplied YouTube Music links or other genuinely music-specific provenance. Generic Data API results should carry `youtube`, even when the UI groups them under a music-focused shelf. A video ID can be reconciled across surfaces without changing its remote identity.

Track origin and actual playback are separate:

```ts
type PlaybackMechanism =
  | { kind: "local-engine"; trackId: number }
  | { kind: "youtube-iframe"; videoId: string }
  | { kind: "unavailable"; reason: string };
```

A remote item may offer **Play local match** only after a conservative local-recording match (normalized artist/title and duration within two seconds). The item still displays its YouTube origin badge, while Now Playing displays a distinct “Playing local file” indicator. Cadence must never silently substitute a different local version.

### Source badge

Add one small `SourceBadge` component used by existing rows/cards and playback surfaces:

- local tracks: no new badge;
- `youtube-music`: “YT Music” badge;
- `youtube`: “YouTube” badge;
- detail surfaces also show the actual playback mechanism when it differs from origin.

Use the badge in search results, track rows, playlist entries, channel/playlist details, queue, History/Recently Played, PlayerBar, and Now Playing.

### Catalog provider

Add a Cadence-owned, runtime-agnostic catalog core and a bridge surface conceptually like:

```ts
interface YouTubeCatalogProvider {
  searchMusicVideos(query, pageToken?, signal?): Promise<CatalogPage<MediaItem>>;
  searchChannels(query, pageToken?, signal?): Promise<CatalogPage<ChannelItem>>;
  searchPlaylists(query, pageToken?, signal?): Promise<CatalogPage<PlaylistItem>>;
  getVideos(ids, signal?): Promise<MediaItem[]>;
  getChannel(id, signal?): Promise<ChannelDetail>;
  getChannelUploads(id, pageToken?, signal?): Promise<CatalogPage<MediaItem>>;
  getPlaylist(id, signal?): Promise<PlaylistDetail>;
  getPlaylistItems(id, pageToken?, signal?): Promise<CatalogPage<MediaItem>>;
  getTrendingMusic(region, signal?): Promise<MediaItem[]>;
  getNewMusicVideos(region, signal?): Promise<MediaItem[]>;
}
```

Implementation rules:

- Fetch through the existing Tauri runtime-fetch/bridge pattern; feature components do not see the API key.
- Maximum two catalog requests in flight; one search in flight.
- Abort obsolete query/detail requests on route or query changes.
- Batch up to 50 video IDs into one `videos.list` request.
- Search at most 25 results initially; paginate only on explicit “Load more.”
- In-memory LRU caches first: searches for 15 minutes, videos/channels/playlists for 24 hours, trending for six hours. Persistent API metadata, if added later, needs `fetchedAt` and refresh/deletion no later than 30 days.
- Do not store channel/view statistics for product metrics unless they are needed for immediate display and refreshed under the same retention rules.
- No requests at app startup. Home shelves load lazily after local Home is visible; search loads only after the user submits or pauses typing.
- Errors are typed: missing key, invalid key, quota exhausted, offline, not found, unavailable, malformed response, aborted.

### Integrated UI mapping

| Existing Cadence surface | Integration |
|---|---|
| Sidebar | Keep current local navigation. Do not make a separate app section. The prototype’s dedicated YouTube entry should be retired once Now Playing integration lands. |
| TopBar/global Search | Keep one Search route. Local results render immediately. A remote section/tabs appears when a key is configured; pasted YT/YTM URLs resolve directly without a catalog search. |
| Home | Optional lazy “Trending on YouTube” shelf among existing shelves when a key is configured. No setup nag on Home. |
| Songs | Remains the local library; remote search results are not inserted into library counts or the local snapshot. |
| Albums | Remains local. YouTube playlists are not relabelled as albums. |
| Artists | Local artists remain local. Remote channel details reuse the existing hero/list layout under a source-aware route and are labelled as channels where appropriate. |
| Playlists | Cadence playlists can eventually contain ordered local and remote references. Public YouTube playlists open in a source-aware detail view reusing `Hero` and track-row patterns. |
| Now Playing (`#/lyrics`) | Becomes source-aware. Local items keep the current artwork/lyrics layout. Remote items place the compliant visible player in the artwork/player area beside the same lyrics surface. |
| PlayerBar | Shows the active `MediaItem`, source badge, and coordinator state. For a remote item outside Now Playing, Play navigates to Now Playing rather than starting hidden playback. |
| Queue | Shows ordered `MediaItem` occurrences with badges. Remote entries can be selected, but playback starts only when the visible player is mounted in Now Playing. |
| History/Recently Played | One store/table eventually renders local and remote play events with source and playback-mechanism badges. |
| Settings | Masked user-supplied Data API key, enable/disable catalog, region, quota-aware status, and clear remote cache. No account/login UI. |

### Playback coordinator

Keep `audioEngine` unchanged. Introduce adapters above the existing stores first, rather than rewriting local playback in one step:

```ts
interface PlaybackAdapter {
  readonly mechanism: "local-engine" | "youtube-iframe";
  load(item: MediaItem, options: { autoplay: boolean }): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setRate(rate: number): void;
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
```

- `LocalAudioAdapter` delegates to the current `usePlayer`/`audioEngine` behavior.
- `YouTubeIframeAdapter` delegates to the Phase B player handle and remote clock.
- A coordinator owns queue item occurrence IDs, order, shuffle/repeat decisions, active item, active adapter, and mutual exclusion.
- Local crossfade/gapless/ReplayGain/EQ apply only to local-engine playback.
- Adapter switches are hard stops: pause/dispose the old adapter before activating the new one.
- Session restore can restore a remote item as cued/paused, never as hidden autoplay.
- Next/previous works across the unified queue, but a remote next item does not begin until Now Playing’s player is visible. Cadence must show “Open Now Playing to continue” instead of silently stalling.
- Mini-player, tray/media commands, and fullscreen must not start remote playback while the official player is not visibly mounted.

### Lyrics

- Reuse existing provider order/settings, TTML/QRC/LRC/plain parsers, translation, romanization, candidate selection, themes, and Braccato rendering.
- Generalize the Phase B `useYouTubeLyrics` hook to accept a remote `MediaItem` and return the same view-model shape needed by the integrated Now Playing surface.
- Feed Braccato from `RemotePlaybackClockSource` only for IFrame playback; keep the local `<audio>` binding untouched for local playback.
- Do not call lyrics synchronized for a real video until seek, pause/resume, rate, buffering, and ad behavior are measured in the Windows app.
- Plain candidates remain explicitly “Unsynchronized.”

### Playlists and History

#### Playlists

Use the existing SQLite database and `playlists` table. Evolve the JSON playlist payload backward-compatibly:

```ts
interface PlaylistRowV2 {
  // existing fields...
  trackIds: number[]; // local projection retained for compatibility
  entries?: Array<{
    source: TrackSource;
    snapshot?: MediaItem; // present for remote entries
  }>;
}
```

- `entries` becomes canonical order when present; absence synthesizes entries from `trackIds`.
- Every write refreshes the local `trackIds` projection.
- Smart playlists remain local-only in the first unified increment.
- Remote snapshots carry `fetchedAt`; stale API metadata is refreshed on view/play when possible.
- No remote entry is inserted into the local `tracks` table.

#### History

History integration is deferred until real IFrame playback is accepted.

A safe same-database migration would:

1. Detect the old schema with `PRAGMA table_info(listening_history)`.
2. In one transaction, create the replacement table with nullable `track_id` plus `source_kind`, `remote_id`, and `canonical_url`.
3. Copy every existing row and ID exactly.
4. Replace the old table and recreate the played-at index.
5. Verify row counts before commit and roll back on any mismatch.

The renderer history model becomes source-discriminated while continuing to normalize old local payloads. A remote row is written:

- only after the official player first reports `PLAYING` for that queue occurrence;
- once per genuine play start, never on cue, pause/resume, seek, or external handoff;
- with both content origin and actual playback mechanism;
- through the same `useHistory` store used by History and Recently Played.

This migration requires seeded old-database tests, restart tests, and a real app check before it can ship. No second database or duplicate history table should be created.

## Performance plan

- Lazy-load remote search/detail components and the IFrame API only when needed.
- No startup catalog polling and no background refresh loop.
- Poll the IFrame clock only while it reports playing, at the existing 250 ms cadence.
- Reuse virtualized track lists and memoized rows; remote pages are capped and paginated.
- Use row-sized thumbnails, browser image caching, and the existing bounded artwork-accent cache.
- Keep catalog state outside the local library snapshot so remote results never trigger full-library projections.
- Keep local playback and lyrics render paths free of catalog subscriptions.
- Measure startup/render behavior against the existing browser harnesses before and after each increment.

## Incremental gates

### Gate 0 — Real desktop player acceptance

Run the existing `Cadence-7-phase-b.exe` on Windows and verify real embeddable/non-embeddable videos, Tauri origin/referrer behavior, controls, seek, error states, and at least one real lyrics result. If the official player fails in Tauri, fix or reject it before any unified queue/database work.

### Phase A — Catalog foundation (no database change)

- Settings for a user-supplied API key and region.
- Data API catalog core, typed errors, cache, cancellation, and quota-aware search behavior.
- `TrackSource`, `MediaItem`, remote registry, and `SourceBadge`.
- Integrated Search remote tabs, Home trending shelf, channel detail, and public-playlist detail.
- Playing a result initially routes to the existing Phase B player; no unified queue/history/playlists yet.

### Phase B — Integrated Now Playing

- Move the official player and remote lyrics into the existing Now Playing/Lyrics route.
- Make PlayerBar source-aware without allowing hidden remote playback.
- Retire the dedicated prototype route and move paste-link handling into Search/Now Playing.
- Repeat real desktop visual QA at compact and expanded player sizes.

### Phase C — Unified queue/coordinator

- Introduce occurrence-based mixed queue items and session migration.
- Preserve every local queue/shuffle/repeat/transition behavior with regression tests.
- Define visible-player behavior for remote next/previous and queue selection.

### Phase D — Unified playlists and History

- Add ordered mixed playlist entries in the existing playlist payload.
- Perform the history schema migration only after seeded migration/restart tests pass.
- Record only observed remote play starts; add source/playback badges to History and Recently Played.

### Phase E — Polish and matching

- Conservative “Play local match.”
- Public playlist URL import/open.
- Channel uploads and clearly labelled related-search shelves.
- Region/language refinement and cache-management UI.

## Implementation record

### 2026-11-02 — Option A / Phase A foundation

Implemented incrementally, without a database/schema change:

- Local Settings for the user's own YouTube Data API v3 key, catalog enablement, blank/system or explicit region, connection test, key removal, and in-memory cache clearing. Cadence still ships no shared API key and contains no Google login/OAuth/cookie flow.
- `YouTubeCatalogCore` over documented Data API endpoints only: Music-category embeddable video search enriched through `videos.list`, channel search/detail, public playlist search/detail/items, channel uploads, and regional `mostPopular` Music-category trending videos.
- Typed handling for disabled/missing/invalid key, API-not-enabled, quota, rate limits, offline/timeout, not-found, server, malformed, unavailable, and aborted requests. API keys are not copied into user-facing error messages.
- Bounded request concurrency (2), bridge-level search/detail/Home cancellation groups, 650 ms Search debounce, one remote Search tab at a time, explicit pagination, and short-lived in-memory TTL caches (search 15 minutes, videos/details 24 hours, trending 6 hours). Catalog metadata is not written to SQLite in Phase A.
- Discriminated `TrackSource`, `MediaItem`, a bounded in-memory remote registry, and `SourceBadge`. Data API items are `youtube`; only genuine `music.youtube.com` links produce `youtube-music`. Remote IDs remain strings and no fake local track/path is created.
- Existing Search now keeps local results/counts first and adds lazy YouTube music-video/channel/public-playlist tabs plus direct video/public-playlist/stable-channel link routing. Home adds a lazy regional trending shelf only when configured. Channel and playlist detail reuse Cadence hero/card/row patterns.
- Opening a playable catalog video cues it in the existing Phase B official visible IFrame view with its catalog metadata/channel/source. The paste-link form now routes playlist/channel links to the integrated detail pages. Phase A deliberately adds no unified queue, mixed playlist entries, remote History, favorites, scrobbling, Play All for remote collections, or background playback.

Offline verification completed on 2026-11-02:

- Web production build and `tsconfig.web.json` typecheck: passed.
- Full Vitest suite: **457/457** tests passed, including Data API request/mapping/cache/quota/cancellation tests and settings migration/persistence tests.
- Lyrics browser decorations suite: **40/40** checks passed.
- Deterministic fake-IFrame/Data API browser suite: **45/45** checks passed, covering local playback before/after remote work, official-player sizes/visibility/cleanup, lyrics clock/decorations, no remote local-history write, catalog setup, settings masking/test, Home trending, Search tabs, source badges, playlist/channel detail, direct YouTube Music provenance, quota isolation, and CSP/page-error checks. Screenshots are in `.artifacts/youtube-phase-b/`.

### 2026-11-03 — Native Cadence integration correction

The isolated Phase B product shape was retired rather than visually patched:

- `playerStore` is the only playback/Now Playing authority. The queue now stores backward-compatible occurrence entries: local entries retain numeric track IDs, while YouTube entries retain string video IDs and canonical URLs. Pre-Stage-7 numeric sessions are normalized instead of being discarded.
- The dedicated `YouTubeNowPlayingView` and second `youtubeStore` were deleted. Legacy `#/youtube` routes open Cadence's existing main Now Playing (`lyrics`) route, and the official player is mounted only inside that surface's integrated stage.
- The stage uses the documented visible IFrame at exactly 480×270 or 200×200, requires more than 50% visibility before scripted play, destroys the player on unmount, and never presents remote audio as Cadence's local engine. Away from Now Playing, PlayerBar remains the shared metadata/transport surface and asks the user to open Now Playing before remote playback can continue.
- Search, Home discovery, channel pages, public playlists, and verified `OLAK5uy…` album collections use Cadence's existing rows, heroes, context actions, queue, PlayerBar, lyrics, History, and Recently Played surfaces. Catalog calls remain documented Data API endpoints with lazy tabs, explicit pagination, ordering where supported, bounded concurrency, cancellation, and TTL/LRU caching.
- Remote lyrics use the existing provider order/settings/parsers and translation/romanization pipeline through a projecting IFrame playback-clock adapter. Local-file lyric actions are hidden for remote items; no fake local audio element or path is created.
- Listening History remains the existing `listening_history` table. Its source-aware migration adds `source_kind`, `remote_id`, and `canonical_url` while preserving local rows; remote rows are written only after the official player reports an observed PLAYING state for a new load. Recently Played reads the same store and deduplicates by full source key, so `youtube:` and `youtube-music:` provenance stay distinct.
- Remote session snapshots older than 30 days are pruned on restore. Cross-origin, `data:`, and `blob:` artwork are loaded through image elements under `img-src` for decorative sampling/shader use instead of broadening `connect-src`.
- User-created Cadence playlists remain local-only in this correction. Public YouTube playlists and verified album collections can be browsed and played as queue contexts, but remote entries are not yet persistable inside a user-created mixed playlist.

Offline verification completed on 2026-11-03:

- Full Vitest suite: **459/459** tests across 36 files, including a same-table SQLite reopen test containing both a local row and a `youtube-music` row with no invented local ID/path.
- Integrated fake-IFrame/Data API browser suite: **67/67** checks, including unified Next/Previous, mixed local↔remote queue crossings, catalog pagination/details, source badges, lyrics clock/decorations, non-embeddable handling, source-aware History/Recently Played, and a reload check that restores the remote session cued (not autoplaying) without adding a duplicate History row.
- Dedicated local regression suites: History **22/22**, lyrics UI **40/40**, Now Playing layout **120/120** with zero CSP errors in its console tail, and audio engine **11/11**.
- The broad legacy `test:ui` harness boots after its settings fixture was updated, but its long fullscreen section remains timing-sensitive: the six-second fixture can advance to the next track before the post-toggle assertions. It is therefore not counted as a passing suite here; the dedicated suites above are the regression evidence for this correction.

Not verified yet:

- A real user-supplied Data API key or a live Google quota/error response.
- Launching the packaged Windows build containing this correction.
- Any real YouTube video, embed restriction, Tauri Referer/origin behavior, provider result, or lyric drift in the desktop runtime (Gate 0 remains open).

### 2026-11-03 — User-selected removal (provider-ready architecture retained)

After reviewing the delivered correction, the user chose **“Remove YouTube, keep provider-ready architecture.”** This supersedes Option A for the shipping UI; the paragraphs above remain the historical feasibility/implementation record for the checkpoint in Git history.

Removed from the active product:

- Data API catalog core/bridge methods, catalog settings (including dropping a stored legacy `youtubeCatalog`/API-key section during settings normalization), Home catalog shelves, Search catalog results, channel/playlist routes and detail pages.
- The official IFrame player/stage/adapter, remote-player mounted/visible/autoplay state and sync callbacks, the Now Playing YouTube link form/stage, remote-item registry, YouTube catalog/player CSS, YouTube script/frame CSP allowances, `test:youtube`, and the fake IFrame/Data API browser suite/catalog unit tests.
- Remote History/Home rows are no longer presented as playable. Their stored rows/artwork remain visible with source badges and an honest **“Remote playback is not available in this build”** outcome. Restored sessions prune legacy non-local queue entries; a non-local queue item that is nevertheless loaded resolves to `playbackMechanism: "unavailable"` without recording a new history play.

Preserved and still tested:

- Source-aware `TrackSource`/`MediaItem`/`QueueEntry` identity with local numeric IDs and remote string IDs/canonical URLs kept distinct; the same `listening_history` table/store, `historyStore.addRemote`, Home Recently Played, and source badges.
- `playerStore` as the single playback coordinator for the local engine and the existing queue/session normalization (including legacy numeric queues and legacy `not-embeddable` availability normalized to `restricted`).
- The provider-agnostic `RemotePlaybackClockSource` and Braccato external-clock plumbing for a possible future licensed provider; the current Now Playing uses the local audio clock only.
- The pre-existing manual lyrics-search YouTube oEmbed metadata helper (`src/main/lyrics/youtube.ts` + the video-ID/search-field helpers it needs). This is not catalog search or playback and was deliberately not removed with Stage 7. Remote source kinds (`youtube`, `youtube-music`) also remain in the stored-history schema for compatibility with existing rows.

Offline verification for the removal on 2026-11-03:

- `npm run typecheck`: passed.
- `npm test`: **437/437** tests passed across 35 files, including source-aware History/library persistence, settings drop of the legacy catalog key, queue/session normalization, manual YouTube metadata for lyrics search, and the extracted provider-agnostic playback-clock tests.
- `npm run build:web`: passed.
- Dedicated browser suites: History **22/22**, lyrics UI **40/40**, Now Playing layout **120/120**, audio engine **11/11**.
- The broad legacy `npm run test:ui` harness is **not** counted as passing: it again aborts on the missing `Repeat: one` fullscreen selector after several fullscreen active-line/layout failures. This is recorded as an unresolved local harness/layout risk, not hidden by the dedicated suites above.
- No new Windows/Tauri package or live-provider verification is claimed for the removal build. A future remote provider must start from a documented/licensed backend contract and re-run desktop acceptance before any remote playback claim.

## Required QA before claiming any phase works

- Unit tests for URL/source identity, Data API mapping, quota/error handling, cache expiry, queue ordering, and history migration.
- Browser harnesses with deterministic catalog/player doubles for wiring, cancellation, empty/error/loading states, and local regressions.
- Actual Windows desktop interaction for every new screen.
- Real Data API requests using the user’s locally entered key; the key must never be shared with the agent.
- Real YouTube videos covering embeddable, non-embeddable, deleted/private, unavailable, long/short, live/upcoming if surfaced, seek, pause/resume, rate, ended, next/previous, and network loss.
- Real TTML, QRC, LRC, plain, translation, and romanization candidates against the IFrame clock, with observed drift recorded honestly.
- Local playback regression: queue, transitions, ReplayGain/EQ availability, lyrics, history persistence across restart, playlists, favorites, and search.
- Responsive checks including 1040×680 and a normal desktop size.

## Approval options

**Originally selected by the user: A. Superseded on 2026-11-03 by the removal decision recorded above.**

### A — Recommended compliant integrated path

Approve all of the following:

- user-supplied YouTube Data API key for public metadata;
- honest YouTube video/channel/playlist modelling, not fake YTM song/album objects;
- official visible IFrame as the actual remote playback mechanism;
- phased integration into existing Cadence surfaces;
- no unified History/database migration until real desktop playback passes Gate 0.

### B — Link-only integrated path

- No Data API key or catalog search.
- Paste/open genuine YT/YTM links from Cadence Search or Now Playing.
- Integrate the official player and lyrics into existing surfaces.
- No Home/Explore/charts/search discovery.

### C — Catalog-only research path

- User-supplied Data API key and integrated discovery.
- Do not approve IFrame playback as the final mechanism.
- Remote items remain non-playable inside Cadence until a permitted native mechanism exists; external handoff must not be counted as playback or history.

### D — Stop

- Do not pursue ArchiveTune/InnerTube playback.
- Keep or remove the isolated Phase B prototype as a separate cleanup decision.

## Sources

- YouTube Data API `search.list`: https://developers.google.com/youtube/v3/docs/search/list
- YouTube Data API `videos.list`: https://developers.google.com/youtube/v3/docs/videos/list
- YouTube Data API `playlists.list`: https://developers.google.com/youtube/v3/docs/playlists/list
- YouTube Data API `playlistItems.list`: https://developers.google.com/youtube/v3/docs/playlistItems/list
- Authorization credentials: https://developers.google.com/youtube/registering_an_application
- Quota and compliance audits: https://developers.google.com/youtube/data/guides/quota_and_compliance_audits
- Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- Required Minimum Functionality: https://developers.google.com/youtube/terms/required-minimum-functionality
- IFrame Player API: https://developers.google.com/youtube/iframe_api_reference
- ArchiveTune: https://github.com/rukamori/ArchiveTune
- ArchiveTune core: https://github.com/rukamori/core
