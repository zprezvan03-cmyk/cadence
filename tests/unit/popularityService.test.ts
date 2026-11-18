import { describe, expect, it, vi } from "vitest";
import {
  DeezerPopularityProvider,
  evaluateGoogleSearchFeasibility,
  GoogleKnowledgeGraphPopularityProvider,
  ItunesPopularityProvider,
  LastFmPopularityProvider,
  scoreCatalogMatch,
  type PopularityProviderConfig,
} from "../../src/shared/popularityProviders";
import {
  POPULARITY_HIT_TTL_MS,
  POPULARITY_NEGATIVE_TTL_MS,
  POPULARITY_NEW_RELEASE_TTL_MS,
  PopularityService,
} from "../../src/shared/popularityService";

const NOW = 1_730_000_000_000;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("popularityProviders — independent feasibility & Google Search guardrails", () => {
  it("evaluates Last.fm, Deezer, iTunes, and Google Knowledge Graph independently and never uses raw Google counts", () => {
    const service = new PopularityService();
    const withoutKeys: PopularityProviderConfig = { enabled: true };
    const reports = service.evaluateAllProviders(withoutKeys);

    expect(reports).toHaveLength(4);
    for (const report of reports) {
      expect(report.usesRawSearchCounts).toBe(false);
    }

    const lastfm = reports.find(r => r.provider === "lastfm")!;
    const deezer = reports.find(r => r.provider === "deezer")!;
    const itunes = reports.find(r => r.provider === "itunes")!;
    const googleKg = reports.find(r => r.provider === "google-kg")!;

    expect(lastfm.feasible).toBe(false);
    expect(deezer.feasible).toBe(true);
    expect(itunes.feasible).toBe(true);
    expect(googleKg.feasible).toBe(false);

    const googleEval = evaluateGoogleSearchFeasibility({
      enabled: true,
      googleKgApiKey: "test-kg-key",
    });
    expect(googleEval.rawSearchCountsAllowed).toBe(false);
    expect(googleEval.knowledgeGraphFeasible).toBe(true);
  });

  it("rejects raw Google Search totalResults payloads if passed to GoogleKnowledgeGraphPopularityProvider", async () => {
    const provider = new GoogleKnowledgeGraphPopularityProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        searchInformation: { totalResults: "1450000000" },
      })
    );

    const res = await provider.lookup(
      { title: "One", artist: "U2", durationSeconds: 276 },
      { enabled: true, googleKgApiKey: "kg-key", fetchFn: fetchMock }
    );

    expect(res.status).toBe("error");
    expect(res.popularity).toBeNull();
    expect(res.detail).toContain("Refusing to use raw Google Search totalResults");
  });

  it("resolves structured MusicRecording entities from Google Knowledge Graph when artist and title match", async () => {
    const provider = new GoogleKnowledgeGraphPopularityProvider();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        itemListElement: [
          {
            resultScore: 850.5,
            result: {
              "@type": ["Thing", "MusicRecording"],
              name: "Bohemian Rhapsody",
              description: "1975 song by Queen",
            },
          },
        ],
      })
    );

    const res = await provider.lookup(
      { title: "Bohemian Rhapsody", artist: "Queen", durationSeconds: 354 },
      { enabled: true, googleKgApiKey: "kg-key", fetchFn: fetchMock }
    );

    expect(res.status).toBe("hit");
    expect(res.popularity).toBeGreaterThan(0.75);
    expect(res.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe("popularityProviders — Deezer non-universality, Last.fm, and iTunes fallback", () => {
  it("falls back to iTunes and extracts genre tags when Deezer misses a regional/anime track", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deezer.com")) {
        // Deezer does not have this niche release
        return jsonResponse({ data: [] });
      }
      if (url.includes("itunes.apple.com")) {
        return jsonResponse({
          results: [
            {
              trackName: "Idol",
              artistName: "YOASOBI",
              trackTimeMillis: 213_000,
              primaryGenreName: "J-Pop",
            },
            {
              trackName: "Idol (English Version)",
              artistName: "YOASOBI",
              trackTimeMillis: 213_000,
              primaryGenreName: "Anime",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const service = new PopularityService();
    const outcome = await service.resolve(
      {
        trackId: 77,
        title: "Idol",
        artist: "YOASOBI",
        durationSeconds: 213,
        year: 2023,
      },
      { enabled: true, fetchFn: fetchMock },
      null,
      { now: NOW }
    );

    expect(outcome.status).toBe("hit");
    expect(outcome.record.popularitySource).toBe("itunes");
    expect(outcome.record.popularity).toBeGreaterThan(0.6);
    expect(outcome.record.externalGenres).toContain("J-Pop");
    expect(outcome.record.expiresAt).toBe(NOW + POPULARITY_HIT_TTL_MS);
  });

  it("combines Last.fm listener count + tags with Deezer rank via confidence-weighted fusion", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ws.audioscrobbler.com")) {
        return jsonResponse({
          track: {
            name: "Weird Fishes/Arpeggi",
            artist: { name: "Radiohead" },
            listeners: "950000",
            playcount: "9800000",
            toptags: {
              tag: [{ name: "alternative rock" }, { name: "art rock" }, { name: "indie" }],
            },
          },
        });
      }
      if (url.includes("api.deezer.com")) {
        return jsonResponse({
          data: [
            {
              title: "Weird Fishes/ Arpeggi",
              artist: { name: "Radiohead" },
              duration: 318,
              rank: 620_000,
            },
          ],
        });
      }
      return jsonResponse({ results: [] });
    });

    const service = new PopularityService([
      new LastFmPopularityProvider(),
      new DeezerPopularityProvider(),
      new ItunesPopularityProvider(),
    ]);

    const outcome = await service.resolve(
      {
        trackId: 12,
        title: "Weird Fishes/Arpeggi",
        artist: "Radiohead",
        durationSeconds: 318,
        year: 2007,
      },
      { enabled: true, lastFmApiKey: "lfm-key", fetchFn: fetchMock },
      null,
      { now: NOW }
    );

    // Since Last.fm hit with high confidence (>= 0.72) and genres, it can even short-circuit unnecessary extra calls
    expect(outcome.status).toBe("hit");
    expect(outcome.record.popularity).toBeGreaterThan(0.8);
    expect(outcome.record.externalGenres).toEqual(["alternative rock", "art rock", "indie"]);
  });

  it("rejects mismatched durations (>15s difference) and skips generic titles ('Track 01', 'Unknown Artist')", async () => {
    expect(
      scoreCatalogMatch(
        { title: "Test Song", artist: "Test Artist", durationSeconds: 200 },
        { title: "Test Song", artist: "Test Artist", durationSeconds: 310 } // 110s difference
      )
    ).toBe(0);

    const fetchMock = vi.fn();
    const service = new PopularityService();
    const genericOutcome = await service.resolve(
      { title: "Track 01", artist: "Unknown Artist", durationSeconds: 180 },
      { enabled: true, fetchFn: fetchMock },
      null,
      { now: NOW }
    );

    expect(genericOutcome.status).toBe("skipped_generic");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("popularityService — local caching, TTL expiration, negative cache, and offline resilience", () => {
  it("returns fresh cached entries without making network requests and re-fetches once expired", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              title: "Digital Love",
              artist: { name: "Daft Punk" },
              duration: 301,
              rank: 780_000,
            },
          ],
        })
      )
    );

    const service = new PopularityService([new DeezerPopularityProvider()]);
    const currentYear = new Date(NOW).getUTCFullYear();

    // First lookup (new release -> 7 day TTL)
    const first = await service.resolve(
      {
        trackId: 1,
        title: "Digital Love",
        artist: "Daft Punk",
        durationSeconds: 301,
        year: currentYear,
      },
      { enabled: true, fetchFn: fetchMock },
      null,
      { now: NOW }
    );

    expect(first.status).toBe("hit");
    expect(first.record.expiresAt).toBe(NOW + POPULARITY_NEW_RELEASE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second lookup 1 day later -> served from cache without calling fetchMock
    const second = await service.resolve(
      {
        trackId: 1,
        title: "Digital Love",
        artist: "Daft Punk",
        durationSeconds: 301,
        year: currentYear,
      },
      { enabled: true, fetchFn: fetchMock },
      first.record,
      { now: NOW + 24 * 3600 * 1000 }
    );

    expect(second.status).toBe("cached");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Third lookup 8 days later (past 7-day TTL) -> re-fetches from network
    const third = await service.resolve(
      {
        trackId: 1,
        title: "Digital Love",
        artist: "Daft Punk",
        durationSeconds: 301,
        year: currentYear,
      },
      { enabled: true, fetchFn: fetchMock },
      first.record,
      { now: NOW + 8 * 24 * 3600 * 1000 }
    );

    expect(third.status).toBe("hit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches definitive misses with a 14-day negative TTL but does not persist transient HTTP 429 / network errors", async () => {
    const missFetch = vi.fn(() => Promise.resolve(jsonResponse({ data: [], results: [] })));
    const service = new PopularityService([
      new DeezerPopularityProvider(),
      new ItunesPopularityProvider(),
    ]);

    const missOutcome = await service.resolve(
      { title: "Obscure Bedroom Recording", artist: "Local Garage Demo", durationSeconds: 145 },
      { enabled: true, fetchFn: missFetch },
      null,
      { now: NOW }
    );

    expect(missOutcome.status).toBe("not_found");
    expect(missOutcome.record.popularitySource).toBe("not_found");
    expect(missOutcome.record.expiresAt).toBe(NOW + POPULARITY_NEGATIVE_TTL_MS);

    // Subsequent call within 14 days uses the negative cache without hitting the network
    const cachedMiss = await service.resolve(
      { title: "Obscure Bedroom Recording", artist: "Local Garage Demo", durationSeconds: 145 },
      { enabled: true, fetchFn: missFetch },
      missOutcome.record,
      { now: NOW + 1000 }
    );
    expect(cachedMiss.status).toBe("cached");
    expect(missFetch).toHaveBeenCalledTimes(2); // 1 deezer + 1 itunes from first call only

    // Transient rate-limit error (HTTP 429) must NOT produce a persistent "not_found" record
    const rateLimitFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Too Many Requests" }, 429, { "Retry-After": "45" }));
    const transientOutcome = await service.resolve(
      { title: "Rate Limited Song", artist: "Some Artist", durationSeconds: 200 },
      { enabled: true, fetchFn: rateLimitFetch },
      null,
      { now: NOW }
    );

    expect(transientOutcome.status).toBe("transient_error");
    expect(transientOutcome.record.popularitySource).toBeNull();
    expect(transientOutcome.record.expiresAt).toBeNull();
  });

  it("remains 100% functional offline without making network calls", async () => {
    const fetchMock = vi.fn();
    const service = new PopularityService();

    const offlineOutcome = await service.resolve(
      { title: "Offline Song", artist: "Offline Artist", durationSeconds: 210 },
      { enabled: false, fetchFn: fetchMock },
      null,
      { now: NOW }
    );

    expect(offlineOutcome.status).toBe("offline");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
