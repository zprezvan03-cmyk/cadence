import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { installTauriBridge } from "../../src/tauri/bridge";
import { LibraryStore } from "../../src/main/library/store";
import { emptyDatabase } from "../../src/main/library/storeCore";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { fetchBetterLyrics } from "../../src/main/lyrics/betterLyrics";
import { fetchUnison, toUnisonCandidate } from "../../src/main/lyrics/unison";
import { fetchBinimum, searchBinimum } from "../../src/main/lyrics/binimum";
import { fetchLrclib, searchLrclib } from "../../src/main/lyrics/lrclib";
import { getJson, setRuntimeFetch } from "../../src/main/lyrics/http";
import { inspectLyricsPayload } from "../../src/main/lyrics/syncInspection";
import { SettingsCore } from "../../src/main/settingsCore";
import {
  BETTER_LYRICS_API_BASE_URL,
  BINIMUM_BASE_URL,
  DEFAULT_PROVIDER_ORDER,
  LRCLIB_BASE_URL,
  migrateProviderOrder,
  PROVIDER_CONFIGS,
  UNISON_BASE_URL,
} from "../../src/shared/upstream/better-lyrics/constants";
import {
  embeddedTranslationsForLanguage,
  parseLyricsText,
  translationGaps,
} from "../../src/renderer/features/lyrics/parseLyrics";
import { resolveSearchFields, parseYouTubeVideoId } from "../../src/shared/youtube";
import type { LyricsResolveRequest } from "../../src/shared/types";

const ALL_KEYS = new Set(PROVIDER_CONFIGS.map(c => c.key));

const TTML_SYLLABLE_WITH_META = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    xml:lang="ja">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <itunes:metadata>
        <songwriters>
          <songwriter>Composer One</songwriter>
          <songwriter>Lyricist Two</songwriter>
        </songwriters>
        <translations>
          <translation xml:lang="en">
            <text for="L1">Cherry blossoms bloom</text>
          </translation>
        </translations>
        <transliterations>
          <transliteration xml:lang="ja-Latn">
            <text for="L1">sakura ga saku</text>
          </transliteration>
        </transliterations>
      </itunes:metadata>
    </metadata>
  </head>
  <body dur="00:30.000">
    <div>
      <p begin="00:06.000" end="00:08.500" itunes:key="L1" ttm:agent="v1"><span begin="00:06.000" end="00:07.200">桜が</span><span begin="00:07.200" end="00:08.500">咲く</span></p>
      <p begin="00:16.000" end="00:19.000" itunes:key="L2" ttm:agent="v1"><span begin="00:16.000" end="00:17.500">風が</span><span begin="00:17.500" end="00:19.000">吹く</span></p>
    </div>
  </body>
</tt>`;

const TTML_LINE_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <body>
    <div>
      <p begin="00:10.000" end="00:13.000">Line one without word spans</p>
      <p begin="00:13.500" end="00:16.500">Line two without word spans</p>
    </div>
  </body>
</tt>`;

const TTML_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div></div></body></tt>`;

const QRC_WORD_WITH_HEADER =
  '<?xml version="1.0"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[ar:Harness Artist]\n[ti:Harness Song]\n[1000,1500]Harness(1000,700) Song - Harness Artist(1700,800)\n[12300,2000]First(12300,800) line(13100,1200)\n[15000,2000]Second(15000,900) line(15900,1100)"/></LyricInfo></QrcInfos>';

const QRC_LINE_ONLY =
  '<?xml version="1.0"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[12300,2000]First line only\n[15000,2000]Second line only"/></LyricInfo></QrcInfos>';

const ENHANCED_LRC_STANDARD = "[00:12.30]<00:12.30>First <00:13.10>line\n[00:15.00]<00:15.00>Second <00:15.80>line";
const ENHANCED_LRC_SHORTHAND = "[00:12.30]<12.30>First <13.10>line\n[00:15.00]<15.00>Second <15.80>line";
const LINE_LRC = "[au:LRC Author]\n[00:12.30]First line\n[00:15.00]Second line";
const SRT_TEXT = "1\n00:00:12,300 --> 00:00:14,500\nFirst subtitle line\n\n2\n00:00:15,000 --> 00:00:17,000\nSecond subtitle line\n";
const PLAIN_TEXT = "First unsynced line\nSecond unsynced line";

const QUERY = {
  title: "Harness Song",
  artist: "Harness Artist",
  album: "Test Bench",
  duration: 200,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const tempDirs: string[] = [];

function makeTestService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-audit-"));
  tempDirs.push(dir);
  const store = new LibraryStore(
    join(dir, "library.db"),
    join(dir, "artwork"),
    path => `media://${path}`,
    { disableSqlite: true }
  );
  const cache = new LyricsCache(join(dir, "lyrics-cache.json"));
  const service = new LyricsService(store, cache);
  return { dir, store, cache, service };
}

function baseResolveRequest(overrides: Partial<LyricsResolveRequest> = {}): LyricsResolveRequest {
  return {
    trackId: 1,
    title: QUERY.title,
    artist: QUERY.artist,
    album: QUERY.album,
    duration: QUERY.duration,
    ...overrides,
  };
}

afterEach(() => {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    clearMocks();
  }
  setRuntimeFetch((...args) => globalThis.fetch(...args));
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("1 & 2. Better Lyrics API contracts, payload validation, and status handling", () => {
  it("unwraps double-encoded TTML, preserves xml:lang/songwriters, and treats NoLyricsSentinel as a miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) {
          return jsonResponse({ ttml: JSON.stringify({ ttml: TTML_SYLLABLE_WITH_META }) });
        }
        if (url.includes("/qq/getLyrics")) {
          return jsonResponse({ lyrics: "NoLyricsSentinel", provider: "qq" });
        }
        return jsonResponse({ error: "not found" }, 404);
      })
    );

    const outcome = await fetchBetterLyrics(QUERY, ALL_KEYS);
    expect(outcome.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "hit" });
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]).toMatchObject({
      source: "blyrics-richsynced",
      syncHint: "richsync",
      language: "ja",
      songwriters: ["Composer One", "Lyricist Two"],
      text: TTML_SYLLABLE_WITH_META,
    });
  });

  it("never advertises line-only LRC on /qq as word-synced, rejects untimed QRC shells, and rejects plain text on /kugou", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) {
          return jsonResponse({ error: "not found" }, 404);
        }
        if (url.includes("/qq/getLyrics")) {
          // QQ sometimes serves line-only LRC when syllable QRC is absent; must be `synced`, not `richsync`.
          return jsonResponse({ lyrics: LINE_LRC, provider: "qq" });
        }
        return jsonResponse({ lyrics: PLAIN_TEXT, provider: "kugou" });
      })
    );

    const outcome = await fetchBetterLyrics(QUERY, ALL_KEYS);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]).toMatchObject({
      source: "blyrics-wordsynced",
      syncHint: "synced",
      text: LINE_LRC,
    });

    // A QRC XML shell with no `(start,dur)` word tokens parses to empty words in `@braccato/parsers`
    // and must be treated as unusable rather than rendering blank lines.
    expect(inspectLyricsPayload(QRC_LINE_ONLY).usable).toBe(false);
  });

  it("skips querying when both song and artist are empty instead of triggering 422", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchBetterLyrics(
      { title: "   ", artist: "", album: "", duration: 180 },
      ALL_KEYS
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "skipped" });
  });

  it("classifies standard DOMException TimeoutError as timeout and 503 as server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    await expect(getJson(`${BETTER_LYRICS_API_BASE_URL}/getLyrics?s=a&a=b`, 50)).rejects.toMatchObject({
      kind: "timeout",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "cache-only miss" }, 503))
    );
    const unavailable = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.statuses[0]).toMatchObject({
      provider: "better-lyrics",
      status: "error",
      detail: "Server error (503)",
    });
  });
});

describe("3. Unison synchronization-precision verification and search fallback", () => {
  it("detects actual synchronization precision instead of trusting mislabeled syncType/format", () => {
    // Line-only TTML mislabeled as richsync must map to unison-synced, never unison-richsynced.
    const mislabeledTtml = toUnisonCandidate(
      { id: 1, format: "ttml", syncType: "richsync", lyrics: TTML_LINE_ONLY },
      ALL_KEYS
    );
    expect(mislabeledTtml).toMatchObject({
      ok: true,
      candidate: { source: "unison-synced", syncHint: "synced" },
    });

    // Line-only LRC mislabeled as richsync must map to unison-synced, never unison-wordsynced.
    const mislabeledLrc = toUnisonCandidate(
      { id: 2, format: "lrc", syncType: "richsync", lyrics: LINE_LRC },
      ALL_KEYS
    );
    expect(mislabeledLrc).toMatchObject({
      ok: true,
      candidate: { source: "unison-synced", syncHint: "synced" },
    });

    // Plain text mislabeled as format "lrc" must map to unison-plain (`none`), never synced.
    const plainLabeledLrc = toUnisonCandidate(
      { id: 3, format: "lrc", syncType: "linesync", lyrics: PLAIN_TEXT },
      ALL_KEYS
    );
    expect(plainLabeledLrc).toMatchObject({
      ok: true,
      candidate: { source: "unison-plain", syncHint: "none" },
    });

    // SRT subtitles map to line-synced unison-synced.
    const srtEntry = toUnisonCandidate(
      { id: 4, format: "srt", syncType: "linesync", lyrics: SRT_TEXT },
      ALL_KEYS
    );
    expect(srtEntry).toMatchObject({
      ok: true,
      candidate: { source: "unison-synced", syncHint: "synced" },
    });

    // Empty TTML shell is rejected as invalid rather than advertised as synced.
    const emptyTtml = toUnisonCandidate(
      { id: 5, format: "ttml", syncType: "richsync", lyrics: TTML_EMPTY },
      ALL_KEYS
    );
    expect(emptyTtml).toEqual({ ok: false, reason: "invalid" });
  });

  it("picks an enabled fallback entry in /lyrics/search even when a higher-scored format is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/lyrics/search")) {
          return jsonResponse({
            success: true,
            data: [
              {
                id: 10,
                song: "Harness Song",
                artist: "Harness Artist",
                album: "Test Bench",
                duration: 200,
                format: "plain",
                syncType: "plain",
                lyrics: PLAIN_TEXT,
              },
              {
                id: 11,
                song: "Harness Song",
                artist: "Harness Artist",
                album: "Test Bench",
                duration: 200,
                format: "lrc",
                syncType: "linesync",
                lyrics: LINE_LRC,
              },
            ],
          });
        }
        return jsonResponse({ success: false, code: "NOT_FOUND" }, 404);
      })
    );

    const enabled = new Set(["unison-synced"]); // `unison-plain` disabled
    const outcome = await fetchUnison(QUERY, enabled);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]).toMatchObject({ source: "unison-synced", syncHint: "synced" });
  });

  it("skips cleanly when artist is missing instead of triggering 400 MISSING_QUERY", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchUnison({ title: "Solo Track", artist: "", album: "", duration: 180 }, ALL_KEYS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.statuses[0]).toMatchObject({ provider: "unison", status: "skipped" });
  });
});

describe("4. BiniLyrics payload precision verification and secondary storage resilience", () => {
  it("never advertises line-only TTML as binimum-richsynced even when timing_type is 'word'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BINIMUM_BASE_URL)) {
          return jsonResponse({
            total: 1,
            results: [
              {
                id: "b1",
                track_name: QUERY.title,
                artist_name: QUERY.artist,
                album_name: QUERY.album,
                duration: QUERY.duration,
                timing_type: "word",
                lyricsUrl: "https://lyrics-storage.binimum.org/line-only.ttml",
              },
            ],
          });
        }
        return new Response(TTML_LINE_ONLY, { status: 200 });
      })
    );

    const outcome = await fetchBinimum(QUERY, ALL_KEYS);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]).toMatchObject({
      source: "binimum-synced",
      syncHint: "synced",
      language: "en",
    });
  });

  it("falls through to the second matching record if the first storage file 404s, and treats storage 429/503 as errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BINIMUM_BASE_URL)) {
          return jsonResponse({
            total: 2,
            results: [
              {
                id: "b-missing",
                track_name: QUERY.title,
                artist_name: QUERY.artist,
                duration: QUERY.duration,
                timing_type: "word",
                lyricsUrl: "https://lyrics-storage.binimum.org/missing.ttml",
              },
              {
                id: "b-valid",
                track_name: QUERY.title,
                artist_name: QUERY.artist,
                duration: QUERY.duration,
                timing_type: "word",
                lyricsUrl: "https://lyrics-storage.binimum.org/valid.ttml",
              },
            ],
          });
        }
        if (url.endsWith("missing.ttml")) return new Response("not found", { status: 404 });
        return new Response(TTML_SYLLABLE_WITH_META, { status: 200 });
      })
    );

    const recovered = await fetchBinimum(QUERY, ALL_KEYS);
    expect(recovered.candidates).toHaveLength(1);
    expect(recovered.candidates[0]).toMatchObject({
      source: "binimum-richsynced",
      syncHint: "richsync",
      language: "ja",
    });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BINIMUM_BASE_URL)) {
          return jsonResponse({
            total: 1,
            results: [
              {
                id: "b-503",
                track_name: QUERY.title,
                artist_name: QUERY.artist,
                duration: QUERY.duration,
                timing_type: "word",
                lyricsUrl: "https://lyrics-storage.binimum.org/outage.ttml",
              },
            ],
          });
        }
        return new Response("unavailable", { status: 503 });
      })
    );

    const outage = await fetchBinimum(QUERY, ALL_KEYS);
    expect(outage.candidates).toEqual([]);
    expect(outage.statuses[0]).toMatchObject({ provider: "binimum", status: "error" });

    // Search cancellation also propagates cleanly if aborted during secondary file downloads.
    vi.unstubAllGlobals();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BINIMUM_BASE_URL)) {
          return jsonResponse({
            total: 1,
            results: [{ id: "b-abort", lyricsUrl: "https://lyrics-storage.binimum.org/slow.ttml" }],
          });
        }
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      })
    );
    await expect(searchBinimum(QUERY, ALL_KEYS, controller.signal)).rejects.toMatchObject({
      name: "LyricsHttpError",
      kind: "aborted",
    });
  });
});

describe("5. LRCLIB contract validation, sync detection, and error vs miss classification", () => {
  it("skips /api/get when artist is blank, bounds duration to 1..3600, and sends Lrclib-Client header", async () => {
    const seenRequests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seenRequests.push({ url: String(input), headers: new Headers(init?.headers) });
        return jsonResponse([]);
      })
    );

    // Blank artist must skip `/get` and call `/search` directly.
    await fetchLrclib({ title: "Track Without Artist", artist: "", album: "", duration: 200 });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].url).toContain(`${LRCLIB_BASE_URL}/search?`);
    expect(seenRequests[0].headers.get("Lrclib-Client")).toContain("Cadence Player");

    seenRequests.length = 0;
    // Out-of-range duration (> 3600s) must be omitted from `/get` rather than triggering 400.
    await fetchLrclib({ title: "Long Mix", artist: "DJ Test", album: "", duration: 5400 });
    expect(seenRequests[0].url).toContain(`${LRCLIB_BASE_URL}/get?`);
    expect(seenRequests[0].url).not.toContain("duration=");
  });

  it("detects enhanced LRC as richsync and demotes untimed syncedLyrics to lrclib-plain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: 42,
          trackName: QUERY.title,
          artistName: QUERY.artist,
          albumName: QUERY.album,
          duration: QUERY.duration,
          syncedLyrics: ENHANCED_LRC_STANDARD,
          plainLyrics: null,
        })
      )
    );
    const enhanced = await fetchLrclib(QUERY);
    expect(enhanced.candidates[0]).toMatchObject({
      source: "lrclib-synced",
      syncHint: "richsync",
    });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: 43,
          trackName: QUERY.title,
          artistName: QUERY.artist,
          albumName: QUERY.album,
          duration: QUERY.duration,
          syncedLyrics: PLAIN_TEXT, // untimed text mislabeled as syncedLyrics
          plainLyrics: null,
        })
      )
    );
    const demoted = await fetchLrclib(QUERY);
    expect(demoted.candidates).toHaveLength(1);
    expect(demoted.candidates[0]).toMatchObject({
      source: "lrclib-plain",
      syncHint: "none",
    });
  });

  it("stops on 429 Retry-After without hitting /search, and reports 500/429/malformed as error in both fetch and search", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Too Many Requests" }, 429, { "Retry-After": "45" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const rateLimited = await fetchLrclib(QUERY);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Did NOT call `/search` after `/get` returned 429
    expect(rateLimited.statuses[0]).toMatchObject({
      provider: "lrclib",
      status: "error",
      retryAfterSeconds: 45,
    });
    expect(rateLimited.statuses[0].detail).toContain("45s");

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Server overloaded" }, 503)));
    const searchError = await searchLrclib(QUERY, ALL_KEYS);
    expect(searchError.candidates).toEqual([]);
    expect(searchError.statuses[0]).toMatchObject({
      provider: "lrclib",
      status: "error",
    });

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken json", { status: 200 })));
    const malformed = await searchLrclib(QUERY, ALL_KEYS);
    expect(malformed.statuses[0]).toMatchObject({
      provider: "lrclib",
      status: "error",
      detail: "Malformed response",
    });
  });
});

describe("6, 7 & 8. Provider ordering, caching, Retry-After backoff, deduplication, and cancellation", () => {
  it("honors custom user providerOrder regardless of which endpoint responds faster, and migrates upstream aliases", async () => {
    const migrated = migrateProviderOrder([
      "portato-richsynced",
      "d_legato-synced",
      "bLyrics-richsynced",
    ]);
    expect(
      migrated.filter(k =>
        ["blyrics-wordsynced", "d_blyrics-synced", "blyrics-richsynced"].includes(k)
      )
    ).toEqual(["blyrics-wordsynced", "d_blyrics-synced", "blyrics-richsynced"]);

    const { service } = makeTestService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BETTER_LYRICS_API_BASE_URL)) {
          // Responds immediately with rich TTML
          if (url.includes("/getLyrics") && !url.includes("/qq/") && !url.includes("/kugou/")) {
            return jsonResponse({ ttml: TTML_SYLLABLE_WITH_META });
          }
          return jsonResponse({ error: "not found" }, 404);
        }
        if (url.startsWith(LRCLIB_BASE_URL)) {
          // Responds slower, but user ranked `lrclib-synced` FIRST!
          await new Promise(resolve => setTimeout(resolve, 25));
          return jsonResponse({
            id: 99,
            trackName: QUERY.title,
            artistName: QUERY.artist,
            albumName: QUERY.album,
            duration: QUERY.duration,
            syncedLyrics: LINE_LRC,
            plainLyrics: null,
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const customOrder = [
      "lrclib-synced",
      "blyrics-richsynced",
      ...DEFAULT_PROVIDER_ORDER.filter(k => k !== "lrclib-synced" && k !== "blyrics-richsynced"),
    ];
    const resolved = await service.resolve(baseResolveRequest(), customOrder);
    expect(resolved.candidates.map(c => c.source)).toEqual(["lrclib-synced", "blyrics-richsynced"]);

    // Persisted custom order survives restart via SettingsCore and Restore Default Order resets cleanly.
    const settingsDir = mkdtempSync(join(tmpdir(), "cadence-settings-"));
    tempDirs.push(settingsDir);
    let savedJson: string | null = null;
    const settingsA = new SettingsCore({
      initialJson: null,
      persist: text => {
        savedJson = text;
      },
    });
    settingsA.patch({ lyrics: { providerOrder: customOrder } });
    const settingsB = new SettingsCore({
      initialJson: savedJson,
      persist: text => {
        savedJson = text;
      },
    });
    expect(settingsB.get().lyrics.providerOrder.slice(0, 2)).toEqual([
      "lrclib-synced",
      "blyrics-richsynced",
    ]);
    settingsB.patch({ lyrics: { providerOrder: [...DEFAULT_PROVIDER_ORDER] } });
    expect(settingsB.get().lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("detects honest sync precision on local .txt and line-only .ttml sidecars", async () => {
    const { dir, store, service } = makeTestService();
    const musicDir = join(dir, "music");
    mkdirSync(musicDir, { recursive: true });
    const audioPath = join(musicDir, "song.flac");
    writeFileSync(audioPath, "stub");
    writeFileSync(join(musicDir, "song.txt"), PLAIN_TEXT, "utf8");

    const { id: trackId } = store.upsertTrack({
      path: audioPath,
      mtimeMs: Date.now(),
      fileSize: 4,
      title: "Song",
      artist: "Artist",
      album: "Album",
      albumArtist: "Artist",
      trackNo: 1,
      discNo: 1,
      year: 2026,
      genre: "Pop",
      duration: 180,
      codec: "FLAC",
      container: "FLAC",
      sampleRate: 44100,
      channels: 2,
      bitrate: 900,
      artworkFile: null,
      animatedArtPath: null,
      accentColor: null,
      hasEmbeddedLyrics: false,
      hasSidecarLyrics: true,
      playable: true,
    });

    const plainSidecar = await service.resolve({
      trackId,
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration: 180,
      localOnly: true,
    });
    expect(plainSidecar.candidates[0]).toMatchObject({
      source: "local-lrc",
      syncHint: "none",
    });

    rmSync(join(musicDir, "song.txt"));
    writeFileSync(join(musicDir, "song.ttml"), TTML_LINE_ONLY, "utf8");
    const lineTtmlSidecar = await service.resolve({
      trackId,
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration: 180,
      localOnly: true,
    });
    expect(lineTtmlSidecar.candidates[0]).toMatchObject({
      source: "local-rich",
      syncHint: "synced",
      language: "en",
    });
  });

  it("respects Retry-After cooldown per provider, never negative-caches 401/429/503, and negative-caches clean 404s", async () => {
    const { service } = makeTestService();
    let blyricsHits = 0;
    let lrclibHits = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(BETTER_LYRICS_API_BASE_URL)) {
          blyricsHits += 1;
          return jsonResponse({ error: "rate limited" }, 429, { "Retry-After": "60" });
        }
        if (url.startsWith(LRCLIB_BASE_URL)) {
          lrclibHits += 1;
          return jsonResponse({}, 404);
        }
        return jsonResponse({}, 404);
      })
    );

    const order = DEFAULT_PROVIDER_ORDER.map(key =>
      key === "blyrics-richsynced" || key === "lrclib-synced" ? key : `d_${key}`
    );
    const first = await service.resolve(baseResolveRequest({ title: "Track One" }), order);
    expect(first.candidates).toEqual([]);
    expect(blyricsHits).toBe(1);
    expect(lrclibHits).toBe(2); // `/get` 404 + `/search` 404

    // Immediate lookup for the same track must honor Better Lyrics' 60s Retry-After without hitting
    // api.betterlyrics.org again, while still querying LRCLIB normally, and Track One was NOT negative-cached.
    const second = await service.resolve(baseResolveRequest({ title: "Track One" }), order);
    expect(second.candidates).toEqual([]);
    expect(blyricsHits).toBe(1); // Skipped due to Retry-After cooldown!
    expect(lrclibHits).toBe(4); // Re-queried because Track One was NOT negative-cached!

    // Reset rate limits and verify clean 404s across all enabled providers DO negative-cache.
    service.clearRateLimits();
    vi.unstubAllGlobals();
    let cleanMissCalls = 0;
    const onlyBlyricsOrder = DEFAULT_PROVIDER_ORDER.map(key =>
      key === "blyrics-richsynced" ? key : `d_${key}`
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        cleanMissCalls += 1;
        return jsonResponse({}, 404);
      })
    );
    await service.resolve(baseResolveRequest({ title: "Definitive Miss" }), onlyBlyricsOrder);
    expect(cleanMissCalls).toBe(1);
    await service.resolve(baseResolveRequest({ title: "Definitive Miss" }), onlyBlyricsOrder);
    expect(cleanMissCalls).toBe(1); // Served from negative cache without network traffic!
  });

  it("keeps shared in-flight lookups alive when one of two callers aborts, and cancels HTTP when all callers abort", async () => {
    const { service } = makeTestService();
    let fetchSignalsAborted = 0;
    let releaseNetwork!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseNetwork = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          fetchSignalsAborted += 1;
        });
        return gate.then(() => jsonResponse({ ttml: TTML_SYLLABLE_WITH_META }));
      })
    );

    const order = ["blyrics-richsynced"];
    const c1 = new AbortController();
    const c2 = new AbortController();

    const p1 = service.resolve(baseResolveRequest({ title: "Shared Track" }), order, c1.signal);
    const p2 = service.resolve(baseResolveRequest({ title: "Shared Track" }), order, c2.signal);

    // Caller 1 aborts, Caller 2 remains active: underlying HTTP request must NOT abort!
    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignalsAborted).toBe(0);

    releaseNetwork();
    const resolved2 = await p2;
    expect(resolved2.candidates).toHaveLength(1);
    expect(resolved2.candidates[0].source).toBe("blyrics-richsynced");

    // Now test single/all caller abort: underlying HTTP signal MUST abort immediately.
    let singleSignalAborted = false;
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            singleSignalAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );

    const c3 = new AbortController();
    const p3 = service.resolve(baseResolveRequest({ title: "Cancelled Track" }), order, c3.signal);
    c3.abort();
    await expect(p3).rejects.toMatchObject({ name: "AbortError" });
    expect(singleSignalAborted).toBe(true);
  });
});

describe("9 & 10. Parser fidelity (TTML, QRC, enhanced LRC, translations, instrumentals) & YouTube search isolation", () => {
  it("preserves TTML syllables, xml:lang, songwriters, translations, romanizations, and instrumental breaks", () => {
    const parsed = parseLyricsText(TTML_SYLLABLE_WITH_META, 30_000, {
      title: QUERY.title,
      artist: QUERY.artist,
    });

    expect(parsed.format).toBe("ttml");
    expect(parsed.syncType).toBe("richsync");
    expect(parsed.language).toBe("ja");
    expect(parsed.songwriters).toEqual(["Composer One", "Lyricist Two"]);

    // Intro (0..6s), interlude (8.5s..16s), and `<body dur="00:30.000">` outro (19s..30s) instrumentals survive.
    const instrumentals = parsed.lyrics.filter(l => l.isInstrumental);
    expect(instrumentals.length).toBeGreaterThanOrEqual(3);

    const sung = parsed.lyrics.filter(l => !l.isInstrumental);
    expect(sung).toHaveLength(2);
    expect(sung[0].parts?.map(p => p.words)).toEqual(["桜が", "咲く"]);
    expect(sung[0].romanization).toBe("sakura ga saku");
    expect(sung[0].translations).toEqual({ en: "Cherry blossoms bloom" });

    // Embedded English translation on line 1 is preserved; only line 2 needs machine translation.
    const embeddedEn = embeddedTranslationsForLanguage(parsed.lyrics, "en");
    const gapsEn = translationGaps(parsed.lyrics, "en");
    const line2Index = parsed.lyrics.indexOf(sung[1]);
    expect(embeddedEn[parsed.lyrics.indexOf(sung[0])]).toBe("Cherry blossoms bloom");
    expect(gapsEn).toEqual([line2Index]);
  });

  it("parses QQ QRC word parts, strips Title - Artist echo header when metadata is supplied, and parses shorthand enhanced LRC", () => {
    const parsedQrc = parseLyricsText(QRC_WORD_WITH_HEADER, 25_000, {
      title: QUERY.title,
      artist: QUERY.artist,
    });
    expect(parsedQrc.format).toBe("qrc");
    expect(parsedQrc.syncType).toBe("richsync");
    const sungQrc = parsedQrc.lyrics.filter(l => !l.isInstrumental);
    expect(sungQrc).toHaveLength(2);
    expect(sungQrc[0].words).toBe("First line");
    expect(sungQrc[0].parts?.length).toBe(2);

    const parsedShorthand = parseLyricsText(ENHANCED_LRC_SHORTHAND, 25_000);
    expect(parsedShorthand.format).toBe("lrc");
    expect(parsedShorthand.syncType).toBe("richsync");
    const sungShorthand = parsedShorthand.lyrics.filter(l => !l.isInstrumental);
    expect(sungShorthand[0].parts?.map(p => p.words.trim())).toEqual(["First", "line"]);
    expect(sungShorthand[0].words).not.toContain("<12.30>");

    expect(inspectLyricsPayload(LINE_LRC).songwriters).toEqual(["LRC Author"]);
  });

  it("never sends an extracted or fabricated videoId to providers during manual search with YouTube metadata", async () => {
    const { service } = makeTestService();
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return jsonResponse({}, 404);
      })
    );

    const ytUrl = "https://music.youtube.com/watch?v=dX3k_QDnzHE";
    const videoId = parseYouTubeVideoId(ytUrl);
    expect(videoId).toBe("dX3k_QDnzHE");

    const effective = resolveSearchFields(
      { title: "", artist: "", album: "Hurry Up, We're Dreaming", youtubeUrl: ytUrl },
      {
        videoId: videoId!,
        title: "Midnight City",
        artist: "M83",
        durationSeconds: 243,
        thumbnailUrl: null,
      },
      null
    );
    expect(effective).toMatchObject({
      title: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
      duration: 243,
    });

    await service.searchLyrics({
      title: effective.title,
      artist: effective.artist,
      album: effective.album,
      duration: effective.duration ?? undefined,
    });

    expect(requestedUrls.some(u => u.startsWith(UNISON_BASE_URL))).toBe(true);
    for (const url of requestedUrls) {
      expect(url).not.toContain(videoId!);
      expect(url).not.toMatch(/[?&](v|videoId)=/);
    }
  });

  it("cancels in-flight Tauri cmd_http_fetch via cmd_http_abort on track-change resolve and classifies Rust TIMEOUT accurately", async () => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as unknown as { window: unknown }).window = globalThis;
    }

    const abortedIds: string[] = [];
    const pendingAbortResolvers = new Map<string, (reason: string) => void>();

    mockIPC((cmd, args) => {
      const payload = args as Record<string, any>;
      switch (cmd) {
        case "cmd_bootstrap":
          return {
            appDataDir: "/tmp/cadence-app",
            artworkDir: "/tmp/cadence-app/art",
            platform: "win32",
            arch: "x86_64",
            appVersion: "0.2.0",
            tauriVersion: "2.10.3",
            settingsJson: null,
            lyricsCacheJson: null,
            dbSnapshot: emptyDatabase(),
            startupFiles: [],
            undecorated: true,
          };
        case "cmd_load_lyrics":
          return null;
        case "cmd_write_settings_json":
        case "cmd_write_lyrics_cache_json":
        case "cmd_allowlist_sync":
          return null;
        case "cmd_http_abort": {
          const reqId = String(payload.requestId);
          abortedIds.push(reqId);
          pendingAbortResolvers.get(reqId)?.("ABORTED");
          return true;
        }
        case "cmd_http_fetch": {
          const { requestId, url } = payload.args as { requestId: string; url: string };
          if (url.includes("Slow+Track")) {
            return new Promise((_resolve, reject) => {
              pendingAbortResolvers.set(requestId, reason => reject(reason));
            });
          }
          if (url.includes("Timeout+Track")) {
            return Promise.reject("TIMEOUT");
          }
          if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ttml: TTML_SYLLABLE_WITH_META }),
            };
          }
          return { status: 404, headers: {}, body: "{}" };
        }
        default:
          return null;
      }
    });

    const bridgeSession = await installTauriBridge();
    try {
      const slowTrack = bridgeSession.api.lyrics.resolve({
        trackId: 101,
        title: "Slow Track",
        artist: "Artist A",
        album: "Album A",
        duration: 210,
      });
      await new Promise(resolve => setTimeout(resolve, 15));

      // Changing tracks issues a new `resolve()`, which aborts Track 101's native Rust HTTP calls.
      const fastTrack = await bridgeSession.api.lyrics.resolve({
        trackId: 102,
        title: "Fast Track",
        artist: "Artist B",
        album: "Album B",
        duration: 210,
      });

      await expect(slowTrack).rejects.toMatchObject({ name: "AbortError" });
      expect(abortedIds.length).toBeGreaterThan(0);
      expect(fastTrack.candidates[0]).toMatchObject({
        source: "blyrics-richsynced",
        syncHint: "richsync",
      });

      // Rust `"TIMEOUT"` maps cleanly to `"Request timed out"` (`error`), never `"Network error"`.
      const timedOut = await bridgeSession.api.lyrics.resolve({
        trackId: 103,
        title: "Timeout Track",
        artist: "Artist C",
        album: "Album C",
        duration: 210,
      });
      expect(timedOut.candidates).toEqual([]);
      expect(timedOut.providerStatus.find(s => s.provider === "better-lyrics")).toMatchObject({
        status: "error",
        detail: "Request timed out",
      });
    } finally {
      bridgeSession.dispose();
    }
  });
});
