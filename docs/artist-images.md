# Cadence — Multi-Source Artist Profile Pictures

## 1. Architecture

```
┌──────────────┐   request(name)   ┌─────────────────────┐
│  ArtistAvatar │ ────────────────▶ │ artistImageStore     │  renderer: bounded queue,
│  (any view)   │ ◀──────────────── │ (zustand, dedupe)    │  one request per artist
└──────────────┘    url/credit      └─────────────────────┘
                                              │ window.cadence.artistImages.resolve()
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ main process (`src/tauri/bridge.ts`)                                          │
│                                                                              │
│  ArtistImageService  ── cache hit? ─────────────────────────────▶ return      │
│         │                                                                    │
│         ├─▶ provider #1 (priority order) → candidate URL                      │
│         ├─▶ download bytes → validate container + dimensions + MIME            │
│         ├─▶ save bytes into the artwork cache (content-addressed)              │
│         ├─▶ ArtistImageCacheCore.put()  (confidence guard, JSON index)         │
│         └─▶ provider #2 … #n on miss / error / invalid image                   │
│                                                                              │
│  providers: LastFm · Wikidata(+MusicBrainz identity) · Deezer                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Everything provider-specific is behind one interface, so a new source is a new class plus an id:

```ts
export interface ArtistImageProvider {
  readonly id: ArtistImageSourceId;
  readonly name: string;
  readonly requiresCredentials: boolean;
  evaluateFeasibility(config: ArtistImageProviderConfig): ArtistImageProviderFeasibility;
  isAvailable(config: ArtistImageProviderConfig): boolean;
  lookup(query: ArtistImageQuery, config: ArtistImageProviderConfig, signal?: AbortSignal):
    Promise<ArtistImageProviderResult>;
}
```

Provider priority is a setting (`settings.artistImages.providerOrder`), normalized on every load:
unknown ids are dropped, duplicates collapse, and providers shipped by a newer Cadence build are
appended automatically. A provider that throws, times out, rate-limits or answers with a broken
image is recorded and the next one is tried; failures never propagate to the caller or the UI.

## 2. Supported providers and their verified capabilities

Capabilities were checked against the live APIs while implementing this feature; the feasibility
table (`INVESTIGATED_ARTIST_IMAGE_SOURCES`) ships with the app so Settings can show the truth.

| Source | Ships as image source | Artist portraits? | Credentials | Licence / attribution |
| --- | --- | --- | --- | --- |
| **Last.fm** (`artist.getinfo`) | ✅ | Yes — `image[]` in five sizes, up to 300×300/original | user's Last.fm API key (Settings → Scrobbling) | no licence metadata exposed; credit shown as "Last.fm" |
| **Wikidata P18** (via MusicBrainz identity) | ✅ | Yes — Wikimedia Commons files | none | CC0 / public domain / CC BY / CC BY-SA only; author + licence + file page are stored and shown |
| **Deezer** (`search/artist`) | ✅ | Yes — `picture_*` up to 1000×1000 | none | Deezer catalogue art; credit shown as "Deezer" |
| **MusicBrainz** | identity resolver only | ❌ publishes no artist imagery | none | CC0 metadata; 1 req/s + descriptive User-Agent enforced |
| **Cover Art Archive** | ❌ | ❌ release/release-group covers only | none | excluded — `feasible: false` |
| **Apple iTunes Search** | ❌ | ❌ `entity=musicArtist` returns no artwork; only album art, plus undocumented per-IP 403s | none | excluded — `feasible: false` |
| **fanart.tv** | ❌ (documented as feasible future provider) | Yes, MBID-addressable | personal API key | attribution required; implement `ArtistImageProvider` and add an id |

Placeholder filtering is provider-specific and explicit:

* Last.fm's "no image" hashes (`2a96cbd8b46e442fc41c2b86b821562f` and friends) are rejected before the
  URL is ever considered.
* Deezer's anonymous-artist square has an empty image hash (`/images/artist//…`) and is rejected.
* Wikidata files whose licence Cadence cannot credit (e.g. GFDL) and CC BY files without a named
  author are rejected, because showing them would violate their terms.

## 3. Identity handling

* Artist names are matched through `artistNameMatchScore`: exact normalized equality (case,
  accents, punctuation and a leading "The" are ignored) scores 1; a collaboration qualifier
  ("feat.", "&", "with", …) scores 0.95; everything else is capped at 0.85, which is below the 0.9
  acceptance gate. Namesakes such as *Nirvana UK* or a tribute act can therefore never supply the
  real artist's picture.
* MusicBrainz supplies the disambiguating identity (MBID, aliases, disambiguation comment). The
  Wikidata provider only ever follows the `wikidata` URL relation of the matched MBID — it never
  searches Wikidata by name — so a namesake's portrait cannot be picked up.
* A MusicBrainz ID in the library or the Last.fm response is cross-checked when both exist.
* Generic names ("Unknown Artist", "Various Artists", empty) are never queried.

## 4. Caching and persistence

* **One entry per artist identity**, independent of tracks and albums: `artist-images.json`
  next to `settings.json`, written through the existing `cmd_write_user_json` path (the same
  mechanism the lyrics caches use). No new database, no new table, no new Rust command.
* **Picture bytes** live in the existing artwork directory under their SHA-1 content hash, so the
  media protocol already serves them, re-downloads of an identical image write nothing, and an
  artist's photo is never stored on a track row.
* Each entry records the provider, original URL, attribution page, licence, author, dimensions,
  confidence, `savedAt`/`verifiedAt` and a last-access timestamp used for LRU eviction (cap 4000).
* **Never overwrite a verified picture with a lower-confidence result**: `shouldReplaceImage()`
  accepts only a strictly more confident result, or a same-confidence result once the entry has
  gone stale. A manual refresh ("Refresh photo" on an artist page) is an explicit override.
* **Negative answers are remembered** for 3 days (6 hours for transient failures such as timeouts
  or rate limits), so a library with many undocumented artists does not re-query every provider on
  every view. Manual refresh bypasses the record.
* The index tolerates corruption and hand edits: a bad file starts empty, and any file name that is
  not a bare content-hash name is discarded so it can never point outside the artwork directory.

## 5. UI integration

| Surface | Change |
| --- | --- |
| Artist cards (Library → Artists, Search, Home shelves) | circular `ArtistAvatar` |
| Artist page hero | circular portrait instead of album art, plus the licence credit line and a "Refresh photo" action |
| Stats → Top artists | circular avatar per row |
| Player bar | 18 px inline avatar next to the artist name |
| Settings → Cache → Artist images | master switch, automatic fetching, refresh window, provider switches + priority, per-source capability, cached count, refresh-all and confirmed clear |

`ArtistAvatar` is a thin wrapper over the existing `Artwork` component: same sizes, same fade-in,
same gradient fallback (now a person glyph), circular frame. Every size already reserves square
space (`aspect-ratio: 1`), so a picture arriving late causes no layout shift. Nothing else in the
design language changed.

## 6. Settings (Settings → Cache → Artist images)

Everything lives in the existing settings schema (`settings.artistImages`) and the existing settings
store/UI conventions — no second settings system, no new page:

| Control | Setting | Behaviour |
| --- | --- | --- |
| Show artist pictures | `enabled` | Master switch: pictures are hidden and no lookups happen. Cached files are untouched. |
| Fetch missing pictures automatically | `autoFetch` | Off = "cached pictures only". The resolver answers from the index and never contacts a provider; nothing cached is deleted and no negative answer is recorded, so switching it back on takes effect on the next request. Manual refresh still works. |
| Refresh cached pictures | `refreshAfterDays` | Background staleness refresh window (0 = never). |
| Provider switches | `providerOrder` with `d_` slots | A disabled provider keeps its priority slot (the same convention as the lyrics provider order) and is never instantiated, so it cannot be queried. Restoring it returns it to the same position. |
| Provider priority | `providerOrder` | ↑/↓ move active providers; disabled slots stay in place. |
| Refresh | action | Re-queries every artist in the index, sequentially, with progress and a Stop button. Disabled providers are skipped automatically. |
| Clear cache | action | Confirmation required; empties the index so pictures are fetched again on demand. |

Changes apply immediately: the bridge rebuilds its `ArtistImageService` whenever `enabled`,
`autoFetch`, the provider order, the refresh window or the Last.fm key changes, and the renderer
drops its in-memory entries so mounted avatars resolve against the new settings.

## 7. Fetching strategy and performance

1. Renderer store: terminal state per artist, one queued request per artist, at most **3** lookups
   in flight, queue capped at 48 — a fast scroll cannot swamp the network.
2. Main service: at most **3** concurrent provider/download operations (semaphore), one in-flight
   promise per artist shared by every caller.
3. Providers: per-source request spacing (Last.fm/Deezer ≈ 220 ms, Wikidata/Commons ≈ 320 ms,
   MusicBrainz 1 request/s as its terms require) and a 6 s timeout.
4. Nothing is fetched at startup: only artists that actually render request a picture.
5. Cache hits (memory + persisted index) are answered without any network access; `cached()` exists
   for instant first paint if a view wants it.

## 8. Diagnostics

With **Settings → Appearance → … → Advanced logging** enabled, the main process logs one line per
resolution: artist, status, provider, confidence, elapsed time, every provider attempt and its
reason (`no-image`, `artist-name-mismatch`, `license-not-allowed`, `too-small`,
`non-image-content-type`, `http-404`, …). `refused-downgrade` events are logged when a weaker
result was correctly rejected. Settings → Cache → Artist pictures also lists each source's live
status (`needs setup` for Last.fm without a key, `excluded` reasons for the sources that publish
no artist imagery).

## 9. Files

| File | Purpose |
| --- | --- |
| `src/shared/artistImageProviders.ts` | provider interface, Last.fm/Deezer/Wikidata providers, MusicBrainz identity resolver, feasibility table |
| `src/shared/artistImageCache.ts` | persistent per-artist index, confidence guard, negative cache, LRU |
| `src/shared/artistImageService.ts` | resolution pipeline, validation, dedupe, bounded concurrency, diagnostics |
| `src/shared/imageInspection.ts` | dependency-free image sniffing (PNG/JPEG/WebP/GIF/BMP) + validation |
| `src/renderer/state/artistImageStore.ts` | renderer queue/state, one request per artist |
| `src/renderer/components/ArtistAvatar.tsx` | avatar + credit line components |
| `src/renderer/components/Artwork.tsx` | optional `fallbackIcon` / `title` props |
| `src/renderer/components/Cards.tsx`, `features/library/DetailViews.tsx`, `features/stats/StatsView.tsx`, `features/player/PlayerBar.tsx` | surfaces |
| `src/renderer/features/settings/ArtistImagesSettings.tsx`, `SettingsView.tsx` | Settings panel |
| `src/tauri/bridge.ts` | `window.cadence.artistImages`, bootstrap index, artwork writes |
| `src-tauri/src/commands.rs` | `artist-images.json` in the bootstrap payload and writer whitelist |
| `src/shared/types.ts`, `src/main/settingsCore.ts` | settings + IPC contracts |
| `tests/unit/artistImageProviders.test.ts`, `tests/unit/artistImageService.test.ts`, `tests/unit/settings.test.ts` | tests |

Migration: none. The settings section is added with defaults on load, the index file is created on
first use, and every existing artwork/listening path is untouched.

## 10. Known limitations

* **Last.fm requires the user's own API key.** Without one the provider reports `not-configured`
  and is skipped; Wikidata and Deezer still work.
* **Coverage is uneven for small/regional artists**: Wikidata needs a P18 image, Last.fm needs a
  community upload, Deezer needs a catalogue entry. The default avatar is a first-class outcome.
* **Refresh-all is sequential by design**: it walks the whole picture index one artist at a time so
  a large library does not burst every API at once; on a large index it takes a while and can be
  stopped at any point (already-refreshed artists keep their new pictures).
* **Clearing the cache leaves content-addressed files behind.** There is no artwork-delete command
  today; the index is cleared and files are reused (not duplicated) if the same image is fetched
  again. A future `cmd_delete_artwork` can reclaim them.
* **Last.fm and Deezer publish no licence metadata**, so those pictures carry a provider credit
  ("Photo via Last.fm") rather than author/licence details; only Wikimedia Commons content carries
  full licensing.
* **MusicBrainz's one-request-per-second rule** makes the Wikidata path slower (two or three
  sequential requests the first time an artist is resolved); results are cached afterwards.
* A manually mistagged artist name can still resolve to the wrong portrait if the *provider itself*
  maps that exact name to a different act; the refresh action is the escape hatch.
