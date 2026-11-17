/**
 * Artist profile-picture provider verification.
 *
 * Every provider is exercised against the exact payload shapes its live API returns (Last.fm
 * `artist.getinfo`, Deezer `search/artist`, MusicBrainz `artist` + `url-rels`, Wikidata `P18` and
 * the Commons `imageinfo` call), including the failure modes that matter in practice: placeholder
 * images, autocorrected namesakes, unusable licences and missing credentials.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ARTIST_IMAGE_PROVIDER_IDS,
  type ArtistIdentity,
  type ArtistIdentityResolver,
  DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER,
  DeezerArtistImageProvider,
  INVESTIGATED_ARTIST_IMAGE_SOURCES,
  LastFmArtistImageProvider,
  MusicBrainzArtistIdentityResolver,
  WikidataArtistImageProvider,
  artistNameMatchScore,
  createArtistImageProviderConfig,
  isPlaceholderArtistImageUrl,
  isUnresolvableArtistName,
  normalizeArtistImageProviderOrder,
} from "../../src/shared/artistImageProviders";

const LASTFM_PLACEHOLDER = "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png";

function configWith(fetchFn: typeof fetch, overrides: Partial<Parameters<typeof createArtistImageProviderConfig>[0]> = {}) {
  return createArtistImageProviderConfig({
    lastFmApiKey: "test-key",
    fetchFn,
    // Tests must not wait out MusicBrainz's one-request-per-second politeness delay.
    minProviderIntervalMs: { lastfm: 0, deezer: 0, wikidata: 0, musicbrainz: 0 },
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastFmBody(overrides: {
  name?: string;
  mbid?: string;
  images?: { size: string; url: string }[];
} = {}) {
  const images = overrides.images ?? [
    { size: "small", url: "https://lastfm.freetls.fastly.net/i/u/34s/abc123.png" },
    { size: "large", url: "https://lastfm.freetls.fastly.net/i/u/174s/abc123.png" },
    { size: "mega", url: "https://lastfm.freetls.fastly.net/i/u/300x300/abc123.png" },
  ];
  return {
    artist: {
      name: overrides.name ?? "Nagorizakura",
      mbid: overrides.mbid ?? "0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f",
      url: "https://www.last.fm/music/Nagorizakura",
      image: images.map(entry => ({ "#text": entry.url, size: entry.size })),
    },
  };
}

describe("artist image provider registry", () => {
  it("exposes exactly the implemented image sources, in a stable default order", () => {
    expect([...ARTIST_IMAGE_PROVIDER_IDS]).toEqual(["lastfm", "wikidata", "deezer"]);
    expect([...DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER]).toEqual(["lastfm", "wikidata", "deezer"]);
  });

  it("normalizes stored provider orders: drops unknown ids, de-duplicates and appends new providers", () => {
    expect(normalizeArtistImageProviderOrder(["deezer", "deezer", "lastfm"])).toEqual([
      "deezer",
      "lastfm",
      "wikidata",
    ]);
    expect(normalizeArtistImageProviderOrder(["fanart-tv", "wikidata"])).toEqual([
      "wikidata",
      "lastfm",
      "deezer",
    ]);
    expect(normalizeArtistImageProviderOrder(undefined)).toEqual(["lastfm", "wikidata", "deezer"]);
  });

  it("documents the actual capability of every investigated source", () => {
    const byId = new Map(INVESTIGATED_ARTIST_IMAGE_SOURCES.map(source => [source.provider, source]));
    // Verified live: Last.fm, Wikidata/Commons and Deezer publish artist portraits.
    expect(byId.get("lastfm")?.feasible).toBe(true);
    expect(byId.get("wikidata")?.feasible).toBe(true);
    expect(byId.get("deezer")?.feasible).toBe(true);
    // Verified live: these publish no artist imagery at all, so they must not be claimed as sources.
    expect(byId.get("musicbrainz")?.feasible).toBe(false);
    expect(byId.get("cover-art-archive")?.feasible).toBe(false);
    expect(byId.get("itunes")?.feasible).toBe(false);
    // Feasible, but not shipped (needs a personal key + attribution terms).
    expect(byId.get("fanart-tv")?.feasible).toBe(true);
    expect(byId.get("fanart-tv")?.implemented).toBe(false);
    for (const source of INVESTIGATED_ARTIST_IMAGE_SOURCES) {
      expect(source.statusReason.length).toBeGreaterThan(0);
    }
  });
});

describe("artist identity helpers", () => {
  it("matches exact names and article variants but not unrelated namesakes", () => {
    expect(artistNameMatchScore("The Beatles", "Beatles")).toBe(1);
    expect(artistNameMatchScore("Nagorizakura", "Nagorizakura")).toBe(1);
    expect(artistNameMatchScore("Nagorizakura", "Nogizaka46")).toBeLessThan(0.9);
    expect(artistNameMatchScore("Nirvana", "Nirvana UK")).toBeGreaterThan(0.7);
    expect(artistNameMatchScore("Nirvana", "Nirvana UK")).toBeLessThan(0.9);
  });

  it("never resolves generic placeholders to a real artist", () => {
    expect(isUnresolvableArtistName("Unknown Artist")).toBe(true);
    expect(isUnresolvableArtistName("Various Artists")).toBe(true);
    expect(isUnresolvableArtistName("  ")).toBe(true);
    expect(isUnresolvableArtistName("Nagorizakura")).toBe(false);
  });

  it("recognizes every Last.fm placeholder hash", () => {
    expect(isPlaceholderArtistImageUrl(LASTFM_PLACEHOLDER)).toBe(true);
    expect(isPlaceholderArtistImageUrl("https://lastfm.freetls.fastly.net/i/u/174s/c6f59c1e5e7240a4c0d427abd71f3dbb.png")).toBe(true);
    expect(isPlaceholderArtistImageUrl("")).toBe(true);
    expect(isPlaceholderArtistImageUrl("https://lastfm.freetls.fastly.net/i/u/300x300/abc123.png")).toBe(false);
  });
});

describe("Last.fm provider", () => {
  it("returns the largest non-placeholder image with attribution and a name match", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(lastFmBody()));
    const provider = new LastFmArtistImageProvider(configWith(fetchFn as unknown as typeof fetch));
    const result = await provider.lookup({ name: "Nagorizakura" }, configWith(fetchFn as unknown as typeof fetch));

    expect(result.status).toBe("hit");
    expect(result.candidate?.imageUrl).toBe("https://lastfm.freetls.fastly.net/i/u/300x300/abc123.png");
    expect(result.candidate?.provider).toBe("lastfm");
    expect(result.candidate?.pageUrl).toBe("https://www.last.fm/music/Nagorizakura");
    expect(result.candidate?.attribution).toBe("Last.fm");
    expect(result.candidate?.confidence).toBeGreaterThan(0.85);
    expect(result.candidate?.confidence).toBeLessThanOrEqual(1);
  });

  it("treats Last.fm's own placeholder image as 'no image' instead of caching a star icon", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(lastFmBody({ images: [{ size: "mega", url: LASTFM_PLACEHOLDER }] }))
    );
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new LastFmArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("no-image");
    expect(result.candidate).toBeNull();
  });

  it("rejects an autocorrected namesake instead of showing the wrong artist", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(lastFmBody({ name: "Nogizaka46" })));
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new LastFmArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("artist-name-mismatch");
  });

  it("rejects a conflicting MusicBrainz identity", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(lastFmBody()));
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new LastFmArtistImageProvider(config).lookup(
      { name: "Nagorizakura", mbid: "11111111-2222-3333-4444-555555555555" },
      config
    );
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("mbid-mismatch");
  });

  it("reports missing credentials instead of calling the API", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(lastFmBody()));
    const config = configWith(fetchFn as unknown as typeof fetch, { lastFmApiKey: "" });
    const provider = new LastFmArtistImageProvider(config);
    expect(provider.isAvailable(config)).toBe(false);
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("not-configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps rate limiting to a retryable status", async () => {
    const fetchFn = vi.fn(async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }));
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new LastFmArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("rate-limited");
    expect(result.retryAfterSeconds).toBe(7);
  });

  it("reports a transport failure as an error instead of throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new LastFmArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("error");
    expect(result.detail).toBe("Network request failed");
  });
});

describe("Deezer provider", () => {
  const deezerBody = (overrides: Record<string, unknown> = {}) => ({
    data: [
      {
        id: 42,
        name: "Nagorizakura",
        nb_fan: 1200,
        picture_medium: "https://cdn-images.dzcdn.net/images/artist/abc/264x264-000000-80-0-0.jpg",
        picture_xl: "https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg",
        ...overrides,
      },
    ],
    total: 1,
  });

  it("returns the largest artist picture without credentials", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(deezerBody()));
    const config = configWith(fetchFn as unknown as typeof fetch, { lastFmApiKey: "" });
    const provider = new DeezerArtistImageProvider(config);
    expect(provider.evaluateFeasibility().requiresCredentials).toBe(false);
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("hit");
    expect(result.candidate?.provider).toBe("deezer");
    expect(result.candidate?.imageUrl).toContain("1000x1000");
    expect(result.candidate?.pageUrl).toBe("https://www.deezer.com/artist/42");
    expect(result.candidate?.attribution).toBe("Deezer");
  });

  it("rejects Deezer's anonymous-artist placeholder square", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(deezerBody({ picture_xl: "https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg" }))
    );
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new DeezerArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("no-image");
  });

  it("rejects a different artist with a similar name", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(deezerBody({ name: "Nogizaka46" })));
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new DeezerArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("artist-name-mismatch");
  });

  it("reports an empty result set as a miss", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [], total: 0 }));
    const config = configWith(fetchFn as unknown as typeof fetch);
    const result = await new DeezerArtistImageProvider(config).lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("artist-not-found");
  });
});

describe("MusicBrainz identity resolver", () => {
  const searchBody = {
    artists: [
      {
        id: "0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f",
        name: "Nagorizakura",
        score: 100,
        disambiguation: "Japanese idol group",
        aliases: [{ name: "なごりざくら" }],
      },
    ],
  };
  const lookupBody = {
    id: "0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f",
    name: "Nagorizakura",
    disambiguation: "Japanese idol group",
    aliases: [{ name: "なごりざくら" }],
    relations: [
      { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q123456" } },
      { type: "official homepage", url: { resource: "https://example.com" } },
    ],
  };

  it("resolves an MBID and its Wikidata relation", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/artist/?query=")) return jsonResponse(searchBody);
      return jsonResponse(lookupBody);
    });
    const config = configWith(fetchFn as unknown as typeof fetch);
    const resolver = new MusicBrainzArtistIdentityResolver(config);
    const identity = await resolver.resolve({ name: "Nagorizakura" }, config);
    expect(identity?.mbid).toBe("0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f");
    expect(identity?.wikidataId).toBe("Q123456");
    expect(identity?.matchScore).toBeCloseTo(1, 5);
  });

  it("ignores a loose Lucene match for a different artist", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ artists: [{ id: "11111111-2222-3333-4444-555555555555", name: "Nogizaka46", score: 60 }] })
    );
    const config = configWith(fetchFn as unknown as typeof fetch);
    const resolver = new MusicBrainzArtistIdentityResolver(config);
    expect(await resolver.resolve({ name: "Nagorizakura" }, config)).toBeNull();
  });

  it("sends the descriptive User-Agent MusicBrainz requires", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ artists: [] }));
    const config = configWith(fetchFn as unknown as typeof fetch);
    await new MusicBrainzArtistIdentityResolver(config).resolve({ name: "Nagorizakura" }, config);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(String((init.headers as Record<string, string>)["User-Agent"])).toContain("Cadence");
  });
});

describe("Wikidata / Wikimedia Commons provider", () => {
  const baseIdentity: ArtistIdentity = {
    mbid: "0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f",
    name: "Nagorizakura",
    matchScore: 1,
    disambiguation: null,
    aliases: [],
    wikidataId: "Q123456",
    musicBrainzUrl: "https://musicbrainz.org/artist/0f9c1b26-16c6-4a9b-97b1-7f4bb3c03a1f",
  };

  const identityResolver: ArtistIdentityResolver = {
    resolve: vi.fn(async () => baseIdentity),
    lookupByMbid: vi.fn(async () => null),
  };

  const entityBody = {
    entities: {
      Q123456: {
        labels: { en: { value: "Nagorizakura" } },
        claims: { P18: [{ mainsnak: { datavalue: { value: "File:Nagorizakura 2024.jpg" } } }] },
      },
    },
  };

  const commonsBody = (metadata: Record<string, { value: string }>) => ({
    query: {
      pages: [
        {
          title: "File:Nagorizakura 2024.jpg",
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/full.jpg",
              thumburl: "https://upload.wikimedia.org/thumb/640px-Nagorizakura_2024.jpg",
              thumbwidth: 640,
              thumbheight: 640,
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Nagorizakura_2024.jpg",
              extmetadata: metadata,
            },
          ],
        },
      ],
    },
  });

  const allowedLicence = {
    LicenseShortName: { value: "CC BY-SA 4.0" },
    LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
    Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Someone">Someone</a>' },
  };

  function providerWith(commons: unknown, resolver: ArtistIdentityResolver = identityResolver) {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikidata.org")) return jsonResponse(entityBody);
      return jsonResponse(commons);
    });
    const config = configWith(fetchFn as unknown as typeof fetch);
    return { provider: new WikidataArtistImageProvider(config, resolver), config, fetchFn };
  }

  it("returns a freely licensed Commons picture with the credit its licence requires", async () => {
    const { provider, config } = providerWith(commonsBody(allowedLicence));
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("hit");
    expect(result.candidate?.imageUrl).toBe("https://upload.wikimedia.org/thumb/640px-Nagorizakura_2024.jpg");
    expect(result.candidate?.author).toBe("Someone");
    expect(result.candidate?.license).toBe("CC BY-SA 4.0");
    expect(result.candidate?.licenseUrl).toContain("creativecommons.org");
    expect(result.candidate?.attribution).toBe("Someone · CC BY-SA 4.0");
    expect(result.candidate?.pageUrl).toContain("commons.wikimedia.org");
    expect(result.candidate?.confidence).toBeGreaterThan(0.9);
  });

  it("rejects a file whose licence Cadence cannot credit", async () => {
    const { provider, config } = providerWith(
      commonsBody({ ...allowedLicence, LicenseShortName: { value: "GFDL" } })
    );
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("license-not-allowed");
  });

  it("rejects a CC BY file without a named author, because the credit would be incomplete", async () => {
    const { provider, config } = providerWith(commonsBody({ ...allowedLicence, Artist: { value: "" } }));
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("missing-attribution");
  });

  it("reports a missing Wikidata entity instead of falling back to a name search", async () => {
    const resolver: ArtistIdentityResolver = {
      resolve: vi.fn(async () => ({ ...baseIdentity, wikidataId: null })),
      lookupByMbid: vi.fn(async () => null),
    };
    const { provider, config } = providerWith(commonsBody(allowedLicence), resolver);
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("no-wikidata-entity");
  });

  it("reports an entity with no P18 image claim as a miss", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ entities: { Q123456: { labels: {}, claims: {} } } })
    );
    const config = configWith(fetchFn as unknown as typeof fetch);
    const provider = new WikidataArtistImageProvider(config, identityResolver);
    const result = await provider.lookup({ name: "Nagorizakura" }, config);
    expect(result.status).toBe("miss");
    expect(result.detail).toBe("no-image-claim");
  });
});
