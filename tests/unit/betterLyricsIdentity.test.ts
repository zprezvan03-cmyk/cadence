/**
 * Better Lyrics vs Better Lyrics Line: provider classification, attribution and configuration.
 *
 * `/getLyrics` serves both syllable-timed and line-timed TTML, so these tests pin the rule that
 * the *parsed payload* decides the provider identity — never the endpoint, the `ttml` field, the
 * MIME type or the provider name. They also cover the two slots being configured, ordered,
 * persisted and restored independently. Every network response is mocked; nothing reaches a live
 * API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsCacheCore } from "../../src/main/lyrics/cacheCore";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import { fetchBetterLyrics, searchBetterLyrics } from "../../src/main/lyrics/betterLyrics";
import { inspectLyricsPayload } from "../../src/main/lyrics/syncInspection";
import { parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";
import { SettingsCore } from "../../src/main/settingsCore";
import {
  BETTER_LYRICS_API_BASE_URL,
  DEFAULT_PROVIDER_ORDER,
  migrateProviderOrder,
  providerConfig,
} from "../../src/shared/upstream/better-lyrics/constants";
import { addProviderToOrder, removeProviderFromOrder } from "../../src/shared/providerOrder";

/** Genuine syllable timing: each `<p>` is split into several independently timed spans. */
const TTML_SYLLABLE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:12.800">Won</span><span begin="00:00:12.800" end="00:00:13.400">der</span><span begin="00:00:13.400" end="00:00:15.000">ful</span></p>
<p begin="00:00:15.000" end="00:00:18.000"><span begin="00:00:15.000" end="00:00:15.600">eve</span><span begin="00:00:15.600" end="00:00:18.000">ning</span></p>
</div></body></tt>`;

/** Line timing: `<p>` elements only, no timed spans at all. */
const TTML_LINE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:12.300" end="00:00:15.000">Wonderful</p>
<p begin="00:00:15.000" end="00:00:18.000">evening</p>
</div></body></tt>`;

/**
 * Line timing wearing a karaoke token: one `<span>` per `<p>` covering the entire line. The
 * parser reports `isWordSynced: true` for this shape even though there is no sub-line timing.
 */
const TTML_LINE_WHOLE_LINE_SPANS = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:15.000">Wonderful</span></p>
<p begin="00:00:15.000" end="00:00:18.000"><span begin="00:00:15.000" end="00:00:18.000">evening</span></p>
</div></body></tt>`;

const KUGOU_LRC = "[00:12.30]Wonderful\n[00:15.00]evening";
const LRCLIB_LRC = "[00:12.30]Wonderful line\n[00:15.00]evening line";

const QUERY = { title: "Harness Song", artist: "Harness Artist", album: "Test Bench", duration: 200 };
const BOTH_BLYRICS_TTML_KEYS = new Set(["blyrics-richsynced", "blyrics-line"]);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes by Better Lyrics endpoint path; anything unrouted answers 404. */
function routedFetch(routes: {
  getLyrics?: () => Response;
  qq?: () => Response;
  kugou?: () => Response;
  lrclib?: () => Response;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("lrclib.net")) return routes.lrclib?.() ?? json({}, 404);
    if (url.includes("/qq/getLyrics")) return routes.qq?.() ?? json({ error: "no" }, 404);
    if (url.includes("/kugou/getLyrics")) return routes.kugou?.() ?? json({ error: "no" }, 404);
    if (url.startsWith(`${BETTER_LYRICS_API_BASE_URL}/getLyrics`)) {
      return routes.getLyrics?.() ?? json({ error: "no" }, 404);
    }
    // BiniLyrics answers an empty catalogue; Unison and anything else is a clean 404 miss, so a
    // resolve stays "definitive" and is allowed to populate the cache.
    if (url.includes("binimum.org")) return json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-blyrics-identity-"));
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  const fakeStore = {
    getTrack: () => undefined,
    getLyrics: () => null,
  } as unknown as LibraryStore;
  return { dir, cache, service: new LyricsService(fakeStore, cache) };
}

const resolveRequest = {
  trackId: 1,
  title: QUERY.title,
  artist: QUERY.artist,
  album: QUERY.album,
  duration: QUERY.duration,
} as Parameters<LyricsService["resolve"]>[0];

afterEach(() => vi.unstubAllGlobals());

describe("1 & 2. Better Lyrics classification is driven by the parsed payload", () => {
  it("attributes genuine syllable-timed TTML to Better Lyrics", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_SYLLABLE }) }));

    const result = await fetchBetterLyrics(QUERY, BOTH_BLYRICS_TTML_KEYS);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      source: "blyrics-richsynced",
      provider: "Better Lyrics",
      syncHint: "richsync",
      text: TTML_SYLLABLE,
    });
    expect(result.statuses[0]).toMatchObject({ provider: "better-lyrics", status: "hit", detail: "Better Lyrics" });
  });

  it("attributes line-timed TTML to Better Lyrics Line", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_LINE }) }));

    const result = await fetchBetterLyrics(QUERY, BOTH_BLYRICS_TTML_KEYS);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      source: "blyrics-line",
      provider: "Better Lyrics Line",
      syncHint: "synced",
      text: TTML_LINE,
    });
    expect(result.statuses[0]).toMatchObject({ status: "hit", detail: "Better Lyrics Line" });
  });

  it("does not call TTML syllable-level just because every <p> carries one whole-line <span>", async () => {
    // The parser's own `isWordSynced` flag is true here; the part structure says otherwise.
    const inspected = inspectLyricsPayload(TTML_LINE_WHOLE_LINE_SPANS, { durationSeconds: QUERY.duration });
    expect(inspected).toMatchObject({ usable: true, format: "ttml", syncType: "synced" });

    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_LINE_WHOLE_LINE_SPANS }) }));
    const result = await fetchBetterLyrics(QUERY, BOTH_BLYRICS_TTML_KEYS);

    expect(result.candidates[0]).toMatchObject({ source: "blyrics-line", provider: "Better Lyrics Line" });
    // The renderer agrees, so the dock's badge cannot contradict the provider identity.
    expect(parseLyricsText(TTML_LINE_WHOLE_LINE_SPANS, QUERY.duration * 1000).syncType).toBe("synced");
  });

  it("keeps the raw payload and real syllable parts intact for the renderer", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_SYLLABLE }) }));
    const result = await fetchBetterLyrics(QUERY, BOTH_BLYRICS_TTML_KEYS);

    const parsed = parseLyricsText(result.candidates[0].text, QUERY.duration * 1000);
    expect(parsed.format).toBe("ttml");
    expect(parsed.syncType).toBe("richsync");
    expect(parsed.lyrics.find(line => (line.parts?.length ?? 0) > 1)?.parts?.length).toBeGreaterThan(1);
  });

  it("classifies manual search rows by payload too", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_LINE }) }));
    const result = await searchBetterLyrics(QUERY, BOTH_BLYRICS_TTML_KEYS);
    expect(result.candidates[0]).toMatchObject({
      source: "blyrics-line",
      provider: "Better Lyrics Line",
      matchTitle: QUERY.title,
    });
  });
});

describe("3. Both provider types appear under their own identity", () => {
  it("keeps syllable TTML and line-synced Kugou lyrics as separate candidates", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        getLyrics: () => json({ ttml: TTML_SYLLABLE }),
        kugou: () => json({ lyrics: KUGOU_LRC, provider: "kugou" }),
      })
    );

    const { service } = makeService();
    const result = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);

    expect(result.candidates.map(candidate => [candidate.source, candidate.provider])).toEqual([
      ["blyrics-richsynced", "Better Lyrics"],
      ["blyrics-synced", "Better Lyrics (Kugou)"],
    ]);
  });

  it("keeps line TTML separate from the other enabled line providers", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        getLyrics: () => json({ ttml: TTML_LINE }),
        lrclib: () =>
          json({
            id: 7,
            trackName: QUERY.title,
            artistName: QUERY.artist,
            albumName: QUERY.album,
            duration: QUERY.duration,
            syncedLyrics: LRCLIB_LRC,
            plainLyrics: null,
          }),
      })
    );

    const { service } = makeService();
    const result = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);

    const sources = result.candidates.map(candidate => candidate.source);
    expect(sources).toContain("blyrics-line");
    expect(sources).toContain("lrclib-synced");
    // Line-level lyrics from Better Lyrics are never dropped for lacking syllable timing…
    expect(result.candidates.find(candidate => candidate.source === "blyrics-line")?.text).toBe(TTML_LINE);
    // …and never relabelled as the syllable provider.
    expect(sources).not.toContain("blyrics-richsynced");
  });
});

describe("4. The two slots are configured independently", () => {
  it("honours each slot's own position in the priority order", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        getLyrics: () => json({ ttml: TTML_LINE }),
        lrclib: () =>
          json({
            id: 7,
            trackName: QUERY.title,
            artistName: QUERY.artist,
            albumName: QUERY.album,
            duration: QUERY.duration,
            syncedLyrics: LRCLIB_LRC,
            plainLyrics: null,
          }),
      })
    );

    const lineFirst = makeService();
    const high = await lineFirst.service.resolve(resolveRequest, [
      "blyrics-line",
      "lrclib-synced",
      "blyrics-richsynced",
    ]);
    expect(high.candidates.map(candidate => candidate.source).slice(0, 2)).toEqual([
      "blyrics-line",
      "lrclib-synced",
    ]);

    // Moving only Better Lyrics Line down reorders that slot alone.
    const lineLast = makeService();
    const low = await lineLast.service.resolve(resolveRequest, [
      "blyrics-richsynced",
      "lrclib-synced",
      "blyrics-line",
    ]);
    expect(low.candidates.map(candidate => candidate.source).slice(0, 2)).toEqual([
      "lrclib-synced",
      "blyrics-line",
    ]);
  });

  it("drops a payload whose slot the user disabled instead of relabelling it", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_LINE }) }));

    // Only the syllable slot is enabled, and the payload is line level: no candidate at all.
    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced"]));
    expect(result.candidates).toEqual([]);
    expect(result.statuses[0]).toMatchObject({ status: "miss" });
    expect(result.statuses[0].detail).toContain("Better Lyrics Line");
  });

  it("withholds a cached result whose slot was switched off afterwards", async () => {
    const getLyrics = vi.fn(() => json({ ttml: TTML_LINE }));
    vi.stubGlobal("fetch", routedFetch({ getLyrics }));
    const { service } = makeService();

    const first = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(first.candidates.map(candidate => candidate.source)).toEqual(["blyrics-line"]);
    const callsAfterFetch = getLyrics.mock.calls.length;

    // Settings switches the line slot off; the cached payload must not resurface under the
    // sibling's identity, and the provider row must say why it is gone.
    const withoutLine = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line");
    const second = await service.resolve(resolveRequest, withoutLine);
    expect(second.candidates).toHaveLength(0);
    expect(second.providerStatus.find(entry => entry.provider === "better-lyrics")).toMatchObject({
      status: "miss",
      detail: "Better Lyrics Line disabled for this track",
    });
    expect(getLyrics.mock.calls.length).toBe(callsAfterFetch);

    // Switching it back on serves the same cached payload under its own identity again.
    const third = await service.resolve(resolveRequest, addProviderToOrder(withoutLine, "blyrics-line"));
    expect(third.candidates[0]).toMatchObject({
      source: "blyrics-line",
      provider: "Better Lyrics Line",
      cached: true,
    });
  });

  it("still fetches line lyrics when only Better Lyrics Line is enabled", async () => {
    const fetchMock = routedFetch({ getLyrics: () => json({ ttml: TTML_LINE }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-line"]));
    expect(result.candidates[0]).toMatchObject({ source: "blyrics-line", provider: "Better Lyrics Line" });
  });

  it("never queries /getLyrics when both of its slots are disabled", async () => {
    const fetchMock = routedFetch({ getLyrics: () => json({ ttml: TTML_SYLLABLE }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-synced"]));
    expect(result.candidates).toEqual([]);
    const paths = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call =>
      new URL(String(call[0])).pathname
    );
    expect(paths).not.toContain("/getLyrics");
  });
});

describe("5 & 6. Settings persistence and restart", () => {
  it("persists independent positions for both slots and restores them after a restart", () => {
    let savedJson: string | null = null;
    const persist = (text: string) => {
      savedJson = text;
    };

    const first = new SettingsCore({ initialJson: null, persist });
    const defaults = first.get().lyrics.providerOrder;
    expect(defaults).toContain("blyrics-richsynced");
    expect(defaults).toContain("blyrics-line");

    // Move Better Lyrics Line to the very front; leave Better Lyrics where it is.
    const reordered = ["blyrics-line", ...defaults.filter(key => key !== "blyrics-line")];
    first.patch({ lyrics: { providerOrder: reordered } });

    // "Restart": a fresh core reading the persisted file.
    const restarted = new SettingsCore({ initialJson: savedJson, persist });
    const restored = restarted.get().lyrics.providerOrder;
    expect(restored[0]).toBe("blyrics-line");
    expect(restored.indexOf("blyrics-richsynced")).toBeGreaterThan(0);
    expect(restored.filter(key => key === "blyrics-line")).toHaveLength(1);
    expect(restored.filter(key => key === "blyrics-richsynced")).toHaveLength(1);

    // Unrelated patches (what page navigation triggers) never reset the order.
    restarted.patch({ lyrics: { offsetMs: 120 } });
    expect(restarted.get().lyrics.providerOrder[0]).toBe("blyrics-line");
    expect(restarted.get().lyrics.offsetMs).toBe(120);
  });

  it("keeps one slot's removal from touching the other", () => {
    const withoutSyllable = migrateProviderOrder(
      DEFAULT_PROVIDER_ORDER.filter(key => key !== "blyrics-richsynced").map(key => key)
    );
    // An order that simply lacks a key predates that provider, so the registry merge re-offers it
    // at its canonical position — never merged into the sibling entry. (Settings itself never
    // produces such an order: removing a slot writes the `d_` form, asserted below.)
    expect(withoutSyllable.filter(key => key === "blyrics-richsynced")).toHaveLength(1);
    expect(withoutSyllable.filter(key => key === "blyrics-line")).toHaveLength(1);

    const removedInSettings = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line");
    expect(migrateProviderOrder(removedInSettings)).toEqual(removedInSettings);
    expect(migrateProviderOrder(removedInSettings)).toContain("blyrics-richsynced");

    const disabledLine = migrateProviderOrder(["blyrics-richsynced", "d_blyrics-line", "lrclib-synced"]);
    expect(disabledLine).toContain("blyrics-richsynced");
    expect(disabledLine).toContain("d_blyrics-line");
    expect(disabledLine).not.toContain("blyrics-line");
  });

  it("exposes both slots to Settings and the lyrics selector from one registry", () => {
    expect(providerConfig("blyrics-richsynced")?.displayName).toBe("Better Lyrics");
    expect(providerConfig("blyrics-line")?.displayName).toBe("Better Lyrics Line");
    expect(providerConfig("d_blyrics-line")?.displayName).toBe("Better Lyrics Line");
  });
});

describe("7. Fallbacks never inherit the previous identity", () => {
  it("attributes a Kugou fallback to Kugou after /getLyrics fails", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        getLyrics: () => json({ error: "boom" }, 500),
        kugou: () => json({ lyrics: KUGOU_LRC, provider: "kugou" }),
      })
    );

    const result = await fetchBetterLyrics(QUERY, new Set(["blyrics-richsynced", "blyrics-line", "blyrics-synced"]));
    expect(result.candidates.map(candidate => [candidate.source, candidate.provider])).toEqual([
      ["blyrics-synced", "Better Lyrics (Kugou)"],
    ]);
  });

  it("re-classifies per request instead of reusing the previous song's identity", async () => {
    const payloads = [TTML_SYLLABLE, TTML_LINE, TTML_SYLLABLE];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      routedFetch({ getLyrics: () => json({ ttml: payloads[Math.min(call++, payloads.length - 1)] }) })
    );

    const seen: string[] = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const outcome = await fetchBetterLyrics(
        { ...QUERY, title: `${QUERY.title} ${index}` },
        BOTH_BLYRICS_TTML_KEYS
      );
      seen.push(outcome.candidates[0].source);
    }
    expect(seen).toEqual(["blyrics-richsynced", "blyrics-line", "blyrics-richsynced"]);
  });

  it("stores and replays the cached candidate under its own identity", async () => {
    vi.stubGlobal("fetch", routedFetch({ getLyrics: () => json({ ttml: TTML_LINE }) }));
    const { service, dir } = makeService();

    const first = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(first.candidates[0]).toMatchObject({ source: "blyrics-line", cached: false });

    const second = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(second.candidates[0]).toMatchObject({
      source: "blyrics-line",
      provider: "Better Lyrics Line",
      cached: true,
    });

    service.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, "lyrics.json"), "utf8"));
    expect(onDisk.version).toBe(3);
    expect(JSON.stringify(onDisk)).toContain("blyrics-line");
  });

  it("discards pre-fix cache files that recorded the wrong identity", () => {
    const stale = JSON.stringify({
      version: 1,
      entries: {
        "harness artist|harness song||200": {
          savedAt: Date.now(),
          negative: false,
          candidates: [
            {
              source: "blyrics-richsynced",
              provider: "Better Lyrics",
              text: TTML_LINE,
              syncHint: "richsync",
              language: null,
              songwriters: [],
              sourceHref: null,
              cached: true,
            },
          ],
        },
      },
    });

    const cache = new LyricsCacheCore({ initialJson: stale });
    expect(cache.get("harness artist|harness song||200")).toBeNull();
  });
});
