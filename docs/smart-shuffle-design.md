# Cadence Smart Shuffle & AutoPlay — Updated System Design

## Overview

Cadence's Smart Shuffle and AutoPlay system produces an intentional, varied, and personalized listening experience inspired by Apple Music while operating local-first and offline-capable.

This updated design incorporates six key architectural refinements:
1. **Provider-abstracted Popularity Intelligence** (independent evaluation of Last.fm, Deezer, Apple iTunes, MusicBrainz, and Google Knowledge Graph; zero reliance on raw Google Search result counts).
2. **Realistic Algorithmic Complexity & Two-Tier Horizon Architecture** for 20,000+ track libraries, backed by empirical benchmarks.
3. **Full Multi-Cluster Genre Distributions** ($\mathbf{g}_i \in [0, 1]^{14}$) rather than single-genre assignment, enabling natural cross-genre bridge transitions.
4. **Session-Safe, Idempotent Skip & Completion Telemetry** that distinguishes manual skips, rapid browsing click-throughs, seeks, natural completions, and playback errors.
5. **Strict Queue Partition Invariant** guaranteeing that manually queued tracks (`Play next` / `Add to queue`) always have absolute priority over AutoPlay tracks.
6. **Five-Phase Incremental Architecture**:
   - Phase 1: Smart Shuffle Core
   - Phase 2: Listening Intelligence
   - Phase 3: Popularity Intelligence
   - Phase 4: AutoPlay Integration
   - Phase 5: Benchmarking and Tuning

---

## 1. Multi-Cluster Genre Segmentation (`src/shared/genreCluster.ts`)

### 1.1 Multi-Cluster Vector Representation
A track is never restricted to a single macro genre. Every track $i$ is mapped to a normalized sparse/dense probability distribution across $M = 14$ macro genre clusters:
$$\mathbf{g}_i = (g_{i,0}, g_{i,1}, \dots, g_{i,M-1}) \in [0, 1]^M, \quad \sum_{c=0}^{M-1} g_{i,c} = 1 \text{ (or } 0 \text{ if unknown)}$$

The 14 macro clusters are:
`rock`, `metal`, `pop`, `electronic`, `hip-hop`, `r&b-soul`, `jazz-blues`, `classical-score`, `folk-country`, `latin-world`, `jpop-kpop-anime`, `ambient-chill`, `experimental`, `spoken-other`.

### 1.2 Multi-Tag & Hybrid Subgenre Parsing
- **Multi-tag splitting**: `track.genre` is tokenized on `[,;/|&+]` and cleaned of ID3v1 numeric parens (e.g., `(17)` → `Rock`).
- **Hybrid subgenre mapping**: Individual subgenres can contribute fractional weights to multiple macro clusters simultaneously:
  - `"Synthpop"` → `{ pop: 0.60, electronic: 0.40 }`
  - `"Dream Pop"` → `{ pop: 0.55, rock: 0.25, ambient-chill: 0.20 }`
  - `"Jazz Fusion"` → `{ jazz-blues: 0.65, rock: 0.20, electronic: 0.15 }`
  - `"Lofi Hip Hop"` → `{ hip-hop: 0.55, ambient-chill: 0.45 }`
  - `"Symphonic Metal"` → `{ metal: 0.65, classical-score: 0.35 }`
  - `"Anison"` / `"Vocaloid"` → `{ jpop-kpop-anime: 0.65, pop: 0.20, electronic: 0.15 }`
- **Multi-tag aggregation**: Weights across all tokens in `track.genre` (plus any enriched external genre tags) are summed and $L_1$-normalized into $\mathbf{g}_i$.

### 1.3 Graceful Missing-Tag Fallbacks
When `track.genre` is empty or unparsable:
1. **Enriched external tags** (`track_intelligence.external_genres` from Last.fm/iTunes/MusicBrainz).
2. **Album consensus distribution**: Average genre vector of other tracks on the same `(albumArtist, album)`.
3. **Artist consensus distribution**: Average genre vector of all library tracks by the same `artist` or `albumArtist`.
4. **Folder/path keyword inference**: Inspects parent directory names for known genre tokens.
5. **Neutral unknown vector**: Flagged as `isUnknown = true`, receiving a neutral compatibility score ($0.46$)—positioned below the primary relevance gate ($0.52$) and above the relaxed relevance gate ($0.44$) so incomplete-metadata tracks are preferred over confidently incompatible tracks ($< 0.44$).

### 1.4 Bilinear Compatibility, Shared-Mass Relevance & Bounded Exposure Damping
Let $\mathbf{s} \in [0, 1]^M$ be the session's active genre context vector (anchored to the current seed track so a manual genre switch immediately pivots the context) and $\mathbf{e} \in \mathbb{R}_{\ge 0}^M$ be the continuous cluster exposure streak vector:
- After playing a track with distribution $\mathbf{g}$, for each cluster $c$:
  $$e_c \leftarrow \begin{cases} e_c + g_c & \text{if } g_c \ge 0.20 \\ \max(0, e_c - 0.50) & \text{if } g_c < 0.20 \end{cases}$$
- The damped affinity between session cluster $c_1$ and candidate cluster $c_2$ is bounded at $\ge 0.68$ so consecutive tracks in the same genre never invert below off-diagonal affinities for unrelated genres:
  $$\tilde{A}(c_1, c_2) = A(c_1, c_2) \times \begin{cases} \max(0.68,\; 1.0 - 0.06 \cdot \max(0, e_{c_2} - 2.5)) & \text{if } c_1 = c_2 \\ 1.0 & \text{if } c_1 \ne c_2 \end{cases}$$
- Compatibility is evaluated via the bilinear form:
  $$G_{\text{compat}}(i, \mathcal{S}) = \sum_{c_1=0}^{M-1} \sum_{c_2=0}^{M-1} s_{c_1} \cdot \tilde{A}(c_1, c_2) \cdot g_{i, c_2}$$
- **Shared-Mass Relevance (one rule for every cluster)**: when the session is focused ($\max_c s_c \ge \phi$, $\phi = 0.45$), the bilinear sum is scaled by the *symmetric* shared mass of the two distributions:
  $$d(\mathbf{s}, \mathbf{g}_i) = \sum_{c=0}^{M-1} \min(s_c, g_{i,c}) \qquad
    G_{\text{compat}} = G_{\text{bilinear}} \cdot \big(\phi + (1-\phi)\, d\big)$$
  There is no threshold, no ramp and no per-cluster branch: $d$ is the histogram intersection of the two vectors, so $d = 0$ for distributions with disjoint support and $d = 1$ for identical ones. $\phi = 0.45$ is *derived* from the taxonomy, not tuned: with a maximum off-diagonal affinity of $0.84$ (`hip-hop` $\leftrightarrow$ `r&b-soul`), any $\phi \le 0.523$ keeps every zero-overlap pair below the $0.44$ relaxed gate, and $0.45 \cdot 0.84 = 0.378$ leaves a deliberate margin. For a pure-Pop session this yields $0.780 \cdot 0.45 = 0.351$ for pure Electronic, $0.269$ for Phonk, and $0.234$ for a pure `J-Pop` tag — all rejected, all by the same formula.
  The earlier "dominant-cluster overlap" damping ($0.45 + 0.55 \cdot \min(1, d/0.10)$, $d = \sum_{c: s_c \ge 0.25} g_{i,c}$) was replaced because it was an implicit step function whose $0.10$ knee happened to sit just under one library's J-Pop share ($0.12$): every candidate with more than $10\%$ mass in a dominant cluster was scored as if it were fully aligned, and the asymmetry ($s_c \ge 0.25$ on one side only) made the score depend on argument order.
- **Bridge Track Bonus**: When a dominant cluster $c_1$ is saturated ($e_{c_1} > 2.5$), candidates that blend $c_1$ with a fresh cluster $c_2$ ($g_{i,c_1} \ge 0.25 \land g_{i,c_2} \ge 0.20$) receive a $+0.14$ bridge bonus to encourage smooth genre pivots.

### 1.5 Genre Relevance Gating & Gradual Fallback (`src/shared/smartShuffle.ts`)
Candidates are gated on multi-cluster genre compatibility **before** weighted random selection:
1. **Stage 1 — Primary Gate (`minGenreCompatibility = 0.52`)**: Admits same-genre and compatible neighboring genres (e.g., J-Pop idol $\to$ J-Pop idol, Anime/Anisong, J-Rock, City Pop, Vocaloid).
2. **Stage 2 — Relaxed Gate (`relaxedGenreCompatibility = 0.44`)**: Used when the primary pool is too small; admits broader compatible neighbors while still rejecting unrelated genres (e.g., J-Pop/idol $\to$ Pop at $0.242$, J-Pop/idol $\to$ Phonk at $0.19$).
3. **Stage 3 — Incomplete-Metadata Fallback (`0.46`)**: Used only when no tagged compatible tracks remain; prefers tracks with missing/unknown genre metadata over confidently incompatible tracks.
4. **No Unrestricted Random Fallback**: If zero candidates pass Stages 1–3, `selectAutoPlayTracks` returns `[]` and `selectAutoPlayTracksWithDiagnostics` reports `relaxationStage = "no-compatible-candidates"` with an explicit `noCompatibleCandidatesReason` rather than injecting an unrelated track.
5. **Popularity as a Secondary Signal Only**: Popularity weight ($0.07$–$0.08$) and non-genre terms are modulated by genre compatibility and gated by `passedRelevanceGate`, ensuring an extremely popular incompatible track can never outscore a less-popular compatible track.

---

## 2. Popularity Intelligence & Provider Abstraction (`src/main/shuffle/popularityProviders.ts`)

### 2.1 Provider Abstraction
No single catalog is universal. Popularity estimation is decoupled behind a `PopularityProvider` interface, evaluated by `PopularityService`:

| Provider ID | Source | Auth Required | Popularity Signal | Genre Enrichment | Independent Evaluation & Caveats |
| :--- | :--- | :---: | :--- | :---: | :--- |
| `lastfm` | Last.fm `track.getInfo` | User's `scrobbling.apiKey` | `listeners` & `playcount` ($\log_{10}$ scaled) | `toptags` | Strongest cross-genre signal (indie, rock, electronic, anime, metal); requires user API key. |
| `deezer` | Deezer `api.deezer.com/search/track` | None (keyless) | `rank` ($0 \dots 10^6$, $\log_{10}$ scaled) | Album/artist match | Fast, free, includes exact duration match; incomplete coverage for niche Asian/doujin/indie releases. |
| `itunes` | Apple iTunes `itunes.apple.com/search` | None (keyless) | Catalog relevance rank + release count | `primaryGenreName` | Broad global catalog coverage; provides weak-to-moderate popularity rank ($c \le 0.50$) and reliable genre tag fallback. |
| `google-kg` | Google Knowledge Graph `kgsearch.googleapis.com` | Optional API key | `resultScore` (entity prominence) | Schema.org description | Structured `MusicRecording` entity resolution. **Raw Google web search result counts are strictly prohibited** as they reflect word frequency rather than musical popularity. |

### 2.2 Confidence-Weighted Fusion & Offline Shrinkage
When one or more providers return a hit for a recording $(P_p, c_p)$:
$$P_{\text{combined}} = \frac{\sum_{p} c_p P_p}{\sum_{p} c_p}, \quad C_{\text{combined}} = 1 - \prod_{p} (1 - c_p)$$
$$P_{\text{final}} = C_{\text{combined}} \cdot P_{\text{combined}} + (1 - C_{\text{combined}}) \cdot 0.50$$
- Unmatched, offline, or low-confidence tracks default smoothly to the neutral prior $0.50$, ensuring niche local tracks are never penalized.

### 2.3 Caching & TTL Expiration Policy
Cached in SQLite (`track_intelligence` table, keyed by `recording_key` from `recordingGroupKey`):
- **Positive hit (catalog release)**: 30 days TTL.
- **Positive hit (current-year release)**: 7 days TTL.
- **Negative hit (`not_found`)**: 14 days cooldown.
- **Transient network/rate-limit error**: In-memory backoff only; never written as `not_found`.

---

## 3. Session-Safe, Idempotent Listening Telemetry (`src/shared/listeningTelemetry.ts`)

### 3.1 Session State Machine
Each track load creates an isolated `PlaybackTelemetrySession` keyed by `sessionId = "${occurrenceId}:${loadToken}"`:
- `accumulatedListenSeconds`: Incremented **only** on playing time ticks where $0 < \Delta t \le 2.5\text{s}$. Pauses and forward seeks do not add unheard time.
- `seekCount` & `seekedNearEnd`: Tracks user scrubbing so seeking from $5\%$ to $98\%$ does not fake a full listen.
- `hadPlaybackError`: Set if the audio decoder or file loader reports an error.
- `outcomeRecorded`: Boolean latch ensuring **at most one** terminal outcome (`completed`, `skipped`, `browsed`, `partial`, or `error`) is recorded per `sessionId`.

### 3.2 Terminal Outcomes
1. **`error`**: Decoder/file error occurred → ignored by preference scoring (never penalizes the track).
2. **`completed`**: `accumulatedListenSeconds >= min(240, max(12, duration * 0.50))` (or natural track end with $\ge 40\%$ heard and no end-scrub) → increments `complete_count`, updates `last_completed_at`. Once latched, a subsequent manual `Next` click at $85\%$ of the track cannot record a skip.
3. **`browsed`**: Manual transition when `accumulatedListenSeconds < 2.0s` → user is clicking rapidly through the queue; neutral (does not increment `skip_count`).
4. **`skipped`**: Manual transition when $2.0\text{s} \le \text{accumulatedListenSeconds} < \min(30\text{s}, 0.35 \times \text{duration})$ → increments `skip_count`, updates `last_skipped_at`.
5. **`partial`**: Manual transition after $\ge \min(30\text{s}, 0.35 \times \text{duration})$ but before completion threshold → neutral listen.

---

## 4. Complexity Analysis & Large-Library Architecture (20,000+ Tracks)

### 4.1 Realistic Complexity Analysis
Let $N$ be the number of tracks in the library or shuffle pool, and $M = 14$ be the number of genre clusters:

| Operation | Naive Complexity | Optimized Complexity | Explanation |
| :--- | :---: | :---: | :--- |
| **Static Feature Indexing** (`buildLibraryShuffleIndex`) | $O(N \cdot L_{\text{str}})$ per shuffle | **$O(N)$ once per library change; $O(1)$ cached** | Normalizes artist/title/genre and packs genre vectors into a flat `Float32Array(N * 14)`. Reused across shuffles until library snapshot mutates. |
| **Full Smart Ordering** (all $N$ tracks scored dynamically) | $O(N^2 \cdot M)$ | **$O(H \cdot (M^2 + K \cdot M) + (N - H))$** | Precomputes $\mathbf{p}_{\text{step}} = \mathbf{g}_{\text{session}}^\top W(\mathbf{s}) \in \mathbb{R}^{14}$ once per step ($M^2 = 196$ ops), then evaluates $K=64$ candidates in $O(K \cdot M)$ ($14$ ops/candidate) over $H=250$ active horizon steps; the remaining $N - H$ tail is ordered in $O(N)$ linear time via 4-stratum weighted bucket permutation + single-pass artist de-clumping. |
| **Single Next-Track / AutoPlay Selection** ($B=5$ tracks) | $O(N \cdot M)$ | **$O(B \cdot K \cdot M)$** ($\sim 1\text{--}3\text{ ms}$) | Uses indexed pool + shortlist sampling of $K=96$ candidates. |
| **Memory Footprint** ($N=20,000$) | ~25 MB (nested JS Maps/arrays) | **~1.8 MB** | Flat typed arrays (`Float32Array`, `Int32Array`, `Uint8Array`). |

### 4.2 Empirical Benchmark Results (`tests/unit/smartShuffleBenchmark.test.ts`)

Measured on Node.js / Vitest with realistic multi-genre strings, untagged fallback inference, 200-entry listening history, and `TrackIntelligenceRecord` maps across **1,000**, **5,000**, and **20,000** tracks:

| Library Size ($N$) | Cold Index Build (`buildLibraryShuffleIndex`) | Warm Two-Tier Smart Shuffle (`H=250, K=64`) | Cold Total (Index + Order) | Full-Horizon Dynamic Order (`H=N, K=64`) | AutoPlay Batch (`B=5` tracks) |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **1,000 tracks** | **7.91 ms** | **12.10 ms** | **20.01 ms** | 38.4 ms | **1.10 ms** |
| **5,000 tracks** | **37.37 ms** | **9.96 ms** | **47.33 ms** | 198.2 ms | **0.90 ms** |
| **20,000 tracks** | **116.90 ms** | **17.93 ms** | **134.83 ms** | **821.67 ms** | **3.24 ms** |

**Key Takeaways from Empirical Benchmarks:**
1. **Why uncached $<15\text{ms}$ for 20,000 tracks is unrealistic**: Cold string normalization, Unicode recording key extraction, multi-cluster genre tokenization, and album/artist/folder fallback inference across 20,000 tracks takes **~116.9 ms** on its own, and running full dynamic shortlist scoring across all 20,000 positions takes **~821.7 ms** (nearly a full second on the UI thread).
2. **How caching + two-tier horizon achieves interactive responsiveness**: By memoizing the typed-array `LibraryShuffleIndex` in `useIntelligence` and precomputing the step genre projection $\mathbf{p}_{\text{step}} \in \mathbb{R}^{14}$ once per step over the active horizon ($H=250$) with $O(N)$ stratified bucket permutation for the tail, warm 20,000-track shuffle ordering completes in **~17.93 ms** (**$45.8\times$ faster** than full-horizon dynamic scoring), and 5-track AutoPlay replenishment completes in **~3.24 ms**.

---

## 5. Queue Partition Invariant & AutoPlay Priority

Every queue order maintains strict priority ordering after `orderPosition`:
```
[ Current (orderPosition) ] -> [ Manual ("manual") ] -> [ Context ("context") ] -> [ AutoPlay ("autoplay") ]
```
1. **`playNext(trackIds)`**: Inserts `origin: "manual"` entries immediately at `orderPosition + 1`, ahead of all other upcoming entries.
2. **`addToQueue(trackIds)`**: Inserts `origin: "manual"` entries after existing `"manual"` / `"context"` entries, **strictly before any `"autoplay"` entries**.
3. **`toggleShuffle()`**: Preserves all upcoming `"manual"` entries in their exact positions right after `orderPosition`; smart-shuffles `"context"` entries; keeps `"autoplay"` entries at the tail.
4. **AutoPlay Low-Water Mark (`remaining < 2`)**: When `repeat === "off"` and `settings.playback.autoPlay === true`, appends up to 5 contextually scored library tracks with `origin: "autoplay"` at the tail so `prewarmNext()` and crossfade/gapless transitions work without interruption.
5. **Seed anchor is the playing track, never the queue tail**: `selectAutoPlayTracks` defines `seedTrackIds` as "most recent last" and anchors the genre session on the last known-genre seed, so `replenishAutoPlay` passes only the **current** entry; the listening history still contributes through `recentPlayedTrackIds`, but only when it is compatible with the playing track. Earlier versions seeded the whole upcoming list, which included AutoPlay's own output and therefore re-anchored every batch on the *previous* batch's last recommendation — a feedback loop that let an Electronic/Phonk pick become the context for the next pick.

---

## 6. Architectural Risks & Mitigations

1. **Premature `playCount` increment on play start**: `playerStore` records a play start immediately for History/Recently Played compatibility. Our preference formula uses net effective plays $\max(0, \text{playCount} - \text{skipCount})$ and Bayesian completion ratio $R_{\text{complete}} = \frac{\text{complete} + 2}{\text{complete} + \text{skip} + 3}$ so skipped starts never inflate preference.
2. **Standby Audio Deck Desynchronization**: Any mutation that alters `order[orderPosition + 1]` (`playNext`, `addToQueue` ahead of AutoPlay, `toggleShuffle`, AutoPlay refill) immediately re-invokes `prewarmNext()` so gapless/crossfade preloading always targets the true next track.
3. **SQLite Write Contention**: Telemetry and popularity cache updates are coalesced in memory and flushed asynchronously in batched transactions on Tauri's blocking pool.
4. **Network Stall / Rate-Limit Risk**: Popularity resolution never blocks shuffle or playback; background requests are limited to 1 concurrent request with abort controllers and automatic offline fallback.
