/**
 * Artist profile-picture pipeline: cache, provider fallback, validation, deduplication and
 * persistence. Providers are stubbed so the tests describe the *pipeline* contract; their real API
 * payloads are covered by artistImageProviders.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ARTIST_IMAGE_CACHE_VERSION,
  ArtistImageCacheCore,
  DEFAULT_ARTIST_IMAGE_MISS_TTL_MS,
  artistImageKey,
  shouldReplaceImage,
  type ArtistImageFileRecord,
} from "../../src/shared/artistImageCache";
import {
  ArtistImageService,
  type ArtistImageDiagnosticEvent,
  type ArtistImageFetchFn,
  type ArtistImageServiceOptions,
} from "../../src/shared/artistImageService";
import {
  createArtistImageProviderConfig,
  type ArtistImageProvider,
  type ArtistImageProviderResult,
  type ArtistImageSourceId,
} from "../../src/shared/artistImageProviders";

/* ------------------------------------------------------------------ fixtures */

/** A minimal but structurally valid PNG header carrying the requested pixel size. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // RGBA
  return bytes;
}

const HTML_BYTES = new TextEncoder().encode("<!doctype html><html><body>Not an image</body></html>");

class StubProvider implements ArtistImageProvider {
  readonly name = "Stub";
  readonly requiresCredentials = false;
  calls = 0;
  constructor(
    readonly id: ArtistImageSourceId,
    private readonly respond: () => ArtistImageProviderResult | Promise<ArtistImageProviderResult>,
    private readonly available = true
  ) {}

  evaluateFeasibility() {
    return {
      provider: this.id,
      name: this.name,
      implemented: true,
      feasible: true,
      requiresCredentials: false,
      attributionRequired: false,
      license: null,
      strengths: [],
      limitations: [],
      statusReason: "stub",
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  async lookup(): Promise<ArtistImageProviderResult> {
    this.calls += 1;
    return this.respond();
  }
}

function hitResult(provider: ArtistImageSourceId, confidence = 0.9, url = "https://img.test/photo.jpg"): ArtistImageProviderResult {
  return {
    provider,
    status: "hit",
    candidate: {
      provider,
      imageUrl: url,
      matchedArtistName: "Nagorizakura",
      mbid: null,
      width: 640,
      height: 640,
      pageUrl: "https://last.fm/music/Nagorizakura",
      attribution: "Last.fm",
      license: null,
      licenseUrl: null,
      author: null,
      confidence,
    },
  };
}

function missResult(provider: ArtistImageSourceId, detail = "no-image"): ArtistImageProviderResult {
  return { provider, status: "miss", candidate: null, detail };
}

interface Harness {
  service: ArtistImageService;
  cache: ArtistImageCacheCore;
  saved: { bytes: Uint8Array; mimeType: string; extension: string }[];
  diagnostics: ArtistImageDiagnosticEvent[];
  persistCalls: () => number;
}

function makeHarness(options: {
  providers: ArtistImageProvider[];
  fetchImage?: ArtistImageFetchFn;
  cache?: ArtistImageCacheCore;
  enabled?: boolean;
  refreshStaleInBackground?: boolean;
  autoFetch?: boolean;
  maxConcurrentRequests?: number;
  now?: () => number;
  saveImage?: ArtistImageServiceOptions["saveImage"];
}): Harness {
  const now = options.now ?? (() => Date.now());
  let persistCount = 0;
  const cache = options.cache ?? new ArtistImageCacheCore({ now, persist: () => void (persistCount += 1) });
  const saved: Harness["saved"] = [];
  const diagnostics: ArtistImageDiagnosticEvent[] = [];
  let fileCounter = 0;
  const service = new ArtistImageService({
    cache,
    providers: options.providers,
    config: createArtistImageProviderConfig({
      enabled: options.enabled ?? true,
      minProviderIntervalMs: { lastfm: 0, wikidata: 0, deezer: 0, musicbrainz: 0 },
    }),
    refreshStaleInBackground: options.refreshStaleInBackground ?? false,
    autoFetch: options.autoFetch ?? true,
    maxConcurrentRequests: options.maxConcurrentRequests,
    now,
    saveImage:
      options.saveImage ??
      (async (bytes, mimeType, extension) => {
        saved.push({ bytes, mimeType, extension });
        fileCounter += 1;
        return `photo-${fileCounter}${extension}`;
      }),
    fetchImage:
      options.fetchImage ??
      (async () => ({ ok: true, status: 200, contentType: "image/png", bytes: pngBytes(640, 640) })),
    onDiagnostic: event => diagnostics.push(event),
  });
  return { service, cache, saved, diagnostics, persistCalls: () => persistCount };
}

function drainMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/* --------------------------------------------------------------------- tests */

describe("artist image resolution pipeline", () => {
  it("fetches from the first provider, validates the bytes and caches the picture", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [lastfm] });

    const result = await harness.service.resolve({ name: "Nagorizakura" });

    expect(result.status).toBe("fetched");
    expect(result.record?.fileName).toBe("photo-1.png");
    expect(result.record?.provider).toBe("lastfm");
    expect(result.record?.width).toBe(640);
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0].mimeType).toBe("image/png");
    expect(harness.persistCalls()).toBeGreaterThan(0);
  });

  it("serves a second request from the cache without any provider work", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [lastfm] });

    await harness.service.resolve({ name: "Nagorizakura" });
    const again = await harness.service.resolve({ name: "Nagorizakura" });

    expect(again.status).toBe("cached");
    expect(lastfm.calls).toBe(1);
    expect(harness.saved).toHaveLength(1);
  });

  it("falls through to the next provider when one throws", async () => {
    const broken = new StubProvider("lastfm", () => {
      throw new Error("socket hang up");
    });
    const deezer = new StubProvider("deezer", () => hitResult("deezer", 0.8, "https://img.test/deezer.jpg"));
    const harness = makeHarness({ providers: [broken, deezer] });

    const result = await harness.service.resolve({ name: "Nagorizakura" });

    expect(result.status).toBe("fetched");
    expect(result.record?.provider).toBe("deezer");
    expect(broken.calls).toBe(1);
    expect(deezer.calls).toBe(1);
    expect(result.providers.map(attempt => `${attempt.provider}:${attempt.status}`)).toEqual([
      "lastfm:error",
      "deezer:hit",
    ]);
  });

  it("rejects an HTML error page returned in place of an image and tries the next provider", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm", 0.9, "https://img.test/html"));
    const deezer = new StubProvider("deezer", () => hitResult("deezer", 0.8, "https://img.test/real.jpg"));
    const fetchImage: ArtistImageFetchFn = async url =>
      url.endsWith("/html")
        ? { ok: true, status: 200, contentType: "text/html", bytes: HTML_BYTES }
        : { ok: true, status: 200, contentType: "image/png", bytes: pngBytes(640, 640) };
    const harness = makeHarness({ providers: [lastfm, deezer], fetchImage });

    const result = await harness.service.resolve({ name: "Nagorizakura" });

    expect(result.status).toBe("fetched");
    expect(result.record?.provider).toBe("deezer");
    // The unusable payload was never written into the artwork cache.
    expect(harness.saved).toHaveLength(1);
    expect(harness.diagnostics.some(event => event.type === "provider-invalid-image")).toBe(true);
  });

  it("rejects a 1×1 tracking pixel as too small", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({
      providers: [lastfm],
      fetchImage: async () => ({ ok: true, status: 200, contentType: "image/png", bytes: pngBytes(1, 1) }),
    });

    const result = await harness.service.resolve({ name: "Nagorizakura" });

    expect(result.status).toBe("unavailable");
    expect(result.record).toBeNull();
    expect(harness.saved).toHaveLength(0);
    expect(result.providers[0]).toEqual({ provider: "lastfm", status: "invalid-image", detail: "too-small" });
  });

  it("rejects a payload whose declared content type is not an image", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({
      providers: [lastfm],
      fetchImage: async () => ({ ok: true, status: 200, contentType: "text/html", bytes: pngBytes(640, 640) }),
    });

    const result = await harness.service.resolve({ name: "Nagorizakura" });
    expect(result.providers[0].detail).toBe("non-image-content-type");
    expect(harness.saved).toHaveLength(0);
  });

  it("survives a 404 on the image URL by trying the next provider", async () => {
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm", 0.9, "https://img.test/gone"));
    const deezer = new StubProvider("deezer", () => hitResult("deezer", 0.8, "https://img.test/ok"));
    const fetchImage: ArtistImageFetchFn = async url =>
      url.endsWith("/gone")
        ? { ok: false, status: 404, contentType: "text/plain", bytes: new Uint8Array() }
        : { ok: true, status: 200, contentType: "image/png", bytes: pngBytes(400, 400) };
    const harness = makeHarness({ providers: [lastfm, deezer], fetchImage });

    const result = await harness.service.resolve({ name: "Nagorizakura" });
    expect(result.record?.provider).toBe("deezer");
  });

  it("shares one request between duplicate concurrent callers", async () => {
    const gateControl: { release?: () => void } = {};
    const gate = new Promise<void>(resolve => {
      gateControl.release = resolve;
    });
    const lastfm = new StubProvider("lastfm", async () => {
      await gate;
      return hitResult("lastfm");
    });
    const harness = makeHarness({ providers: [lastfm] });

    const first = harness.service.resolve({ name: "Nagorizakura" });
    const second = harness.service.resolve({ name: "Nagorizakura" });
    // Different casing/punctuation is the same identity, so it must join the same request.
    const third = harness.service.resolve({ name: "  nagorizakura " });
    gateControl.release?.();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(lastfm.calls).toBe(1);
    expect(harness.saved).toHaveLength(1);
    for (const result of [a, b, c]) expect(result.record?.fileName).toBe("photo-1.png");
  });

  it("remembers a negative answer so a large library does not re-query on every view", async () => {
    let now = 1_000_000;
    const lastfm = new StubProvider("lastfm", () => missResult("lastfm"));
    const harness = makeHarness({ providers: [lastfm], now: () => now });

    const first = await harness.service.resolve({ name: "Nagorizakura" });
    expect(first.status).toBe("unavailable");
    expect(first.reason).toBe("no-image-found");
    expect(lastfm.calls).toBe(1);

    const second = await harness.service.resolve({ name: "Nagorizakura" });
    expect(second.status).toBe("unavailable");
    expect(lastfm.calls).toBe(1);

    // Once the miss window has passed a new attempt is allowed.
    now += DEFAULT_ARTIST_IMAGE_MISS_TTL_MS + 1;
    await harness.service.resolve({ name: "Nagorizakura" });
    expect(lastfm.calls).toBe(2);
  });

  it("reports offline behaviour as unavailable and recovers once the network returns", async () => {
    let online = false;
    let now = 2_000_000;
    const provider = new StubProvider("lastfm", () =>
      online ? hitResult("lastfm") : { provider: "lastfm", status: "error", candidate: null, detail: "network-error" }
    );
    const harness = makeHarness({ providers: [provider], now: () => now });

    const offline = await harness.service.resolve({ name: "Nagorizakura" });
    expect(offline.status).toBe("unavailable");
    expect(offline.reason).toBe("providers-unavailable");
    expect(offline.record).toBeNull();

    online = true;
    now += 7 * 60 * 60 * 1000; // past the shorter transient-failure window
    const recovered = await harness.service.resolve({ name: "Nagorizakura" });
    expect(recovered.status).toBe("fetched");
    expect(recovered.record?.provider).toBe("lastfm");
  });

  it("keeps a verified picture when a refresh returns a lower-confidence result", async () => {
    let confidence = 0.95;
    const provider = new StubProvider("lastfm", () => hitResult("lastfm", confidence));
    const harness = makeHarness({ providers: [provider] });

    const strong = await harness.service.resolve({ name: "Nagorizakura" });
    expect(strong.record?.confidence).toBeCloseTo(0.95, 5);

    confidence = 0.4;
    const weaker = await harness.service.resolve({ name: "Nagorizakura" }, { force: true });

    expect(weaker.status).toBe("cached");
    expect(weaker.reason).toBe("kept-higher-confidence");
    expect(weaker.record?.confidence).toBeCloseTo(0.95, 5);
    expect(harness.cache.get(artistImageKey("Nagorizakura"))?.record.fileName).toBe("photo-1.png");
    expect(harness.diagnostics.some(event => event.type === "refused-downgrade")).toBe(true);
  });

  it("produces the same guard from an opportunistic stale-refresh", async () => {
    let now = 3_000_000;
    const seed = new ArtistImageCacheCore({ now: () => now });
    const seededRecord: ArtistImageFileRecord = {
      artistKey: artistImageKey("Nagorizakura"),
      artistName: "Nagorizakura",
      mbid: null,
      fileName: "licensed.png",
      provider: "wikidata",
      sourceUrl: "https://upload.wikimedia.org/photo.jpg",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
      attribution: "Someone · CC BY-SA 4.0",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      author: "Someone",
      width: 640,
      height: 640,
      confidence: 0.95,
      savedAt: now - 400 * 24 * 60 * 60 * 1000,
      verifiedAt: now - 400 * 24 * 60 * 60 * 1000,
      lastAccessAt: now - 400 * 24 * 60 * 60 * 1000,
    };
    seed.put(seededRecord);

    const weak = new StubProvider("lastfm", () => hitResult("lastfm", 0.35, "https://img.test/weak.jpg"));
    const harness = makeHarness({
      providers: [weak],
      cache: seed,
      now: () => now,
      refreshStaleInBackground: true,
    });

    const stale = await harness.service.resolve({ name: "Nagorizakura" });
    expect(stale.status).toBe("cached");
    expect(stale.refreshing).toBe(true);
    await drainMicrotasks();

    const kept = seed.get(artistImageKey("Nagorizakura"))?.record;
    expect(kept?.fileName).toBe("licensed.png");
    expect(weak.calls).toBe(1);
    expect(harness.diagnostics.some(event => event.type === "refused-downgrade")).toBe(true);
  });

  it("replaces the stored picture on an explicit manual refresh", async () => {
    let provider = "lastfm";
    const lastfm = new StubProvider("lastfm", () => hitResult("lastfm", 0.9, "https://img.test/one.jpg"));
    const deezer = new StubProvider("deezer", () => {
      if (provider === "deezer") return hitResult("deezer", 0.5, "https://img.test/two.jpg");
      return missResult("deezer");
    });
    const harness = makeHarness({ providers: [lastfm, deezer] });

    await harness.service.resolve({ name: "Nagorizakura" });
    provider = "deezer";
    // The first provider now misses so the refresh falls through to Deezer.
    (lastfm as unknown as { respond: () => ArtistImageProviderResult }).respond = () => missResult("lastfm");

    const refreshed = await harness.service.refresh({ name: "Nagorizakura" });
    expect(refreshed.status).toBe("fetched");
    expect(refreshed.record?.provider).toBe("deezer");
    expect(refreshed.record?.fileName).toBe("photo-2.png");
  });

  it("bounds how many provider lookups run at once", async () => {
    let active = 0;
    let peak = 0;
    const provider = new StubProvider("lastfm", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return hitResult("lastfm");
    });
    const harness = makeHarness({ providers: [provider], maxConcurrentRequests: 2 });

    const artists = ["A", "B", "C", "D", "E", "F", "G", "H"];
    await Promise.all(artists.map(name => harness.service.resolve({ name })));

    expect(peak).toBeLessThanOrEqual(2);
    expect(harness.saved).toHaveLength(artists.length);
  });

  it("does nothing at all when artist pictures are switched off", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [provider], enabled: false });

    const result = await harness.service.resolve({ name: "Nagorizakura" });
    expect(result.status).toBe("disabled");
    expect(result.record).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it("never queries providers for placeholder artist names", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [provider] });

    const result = await harness.service.resolve({ name: "Unknown Artist" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("unresolvable-artist-name");
    expect(provider.calls).toBe(0);
  });

  it("skips providers that are not configured and still succeeds with the next one", async () => {
    const unconfigured = new StubProvider("lastfm", () => hitResult("lastfm"), false);
    const deezer = new StubProvider("deezer", () => hitResult("deezer", 0.8, "https://img.test/deezer.jpg"));
    const harness = makeHarness({ providers: [unconfigured, deezer] });

    const result = await harness.service.resolve({ name: "Nagorizakura" });
    expect(result.record?.provider).toBe("deezer");
    expect(result.providers[0]).toEqual({ provider: "lastfm", status: "skipped", detail: "not-configured" });
    expect(unconfigured.calls).toBe(0);
  });

  it("persists the index so a restart serves pictures from disk", async () => {
    let json: string | null = null;
    const now = () => 4_000_000;
    const makeCache = () =>
      new ArtistImageCacheCore({
        now,
        initialJson: json,
        persist: next => {
          json = next;
        },
      });

    const firstRun = makeHarness({
      providers: [new StubProvider("lastfm", () => hitResult("lastfm"))],
      cache: makeCache(),
      now,
    });
    await firstRun.service.resolve({ name: "Nagorizakura" });
    expect(json).toBeTruthy();

    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const secondRun = makeHarness({ providers: [provider], cache: makeCache(), now });
    const restored = await secondRun.service.resolve({ name: "Nagorizakura" });

    expect(restored.status).toBe("cached");
    expect(restored.record?.fileName).toBe("photo-1.png");
    expect(restored.record?.attribution).toBe("Last.fm");
    expect(provider.calls).toBe(0);
  });

  it("lists the indexed artists so Settings can offer a refresh of all pictures", async () => {
    let provider = "hit";
    const stub = new StubProvider("lastfm", () =>
      provider === "hit" ? hitResult("lastfm") : missResult("lastfm")
    );
    const harness = makeHarness({ providers: [stub] });

    await harness.service.resolve({ name: "Nagorizakura" });
    provider = "miss";
    await harness.service.resolve({ name: "Nogizaka46" });

    expect(harness.cache.indexedArtists()).toEqual({
      withImage: ["Nagorizakura"],
      withoutImage: ["Nogizaka46"],
    });
  });

  it("clears the index and fetches again afterwards", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [provider] });

    await harness.service.resolve({ name: "Nagorizakura" });
    expect(harness.cache.stats().artists).toBe(1);

    const cleared = harness.service.clearCache();
    expect(cleared.removedImages).toBe(1);
    expect(harness.cache.stats().artists).toBe(0);
    expect(harness.service.cached("Nagorizakura").record).toBeNull();

    await harness.service.resolve({ name: "Nagorizakura" });
    expect(provider.calls).toBe(2);
  });

  it("serves cached pictures without touching the network when automatic fetching is off", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const online = makeHarness({ providers: [provider] });
    await online.service.resolve({ name: "Nagorizakura" });
    expect(provider.calls).toBe(1);

    // Same cache, automatic fetching switched off: the picture keeps showing from disk.
    const offline = makeHarness({ providers: [provider], cache: online.cache, autoFetch: false });
    const cached = await offline.service.resolve({ name: "Nagorizakura" });
    expect(cached.status).toBe("cached");
    expect(cached.record?.fileName).toBe("photo-1.png");
    expect(provider.calls).toBe(1);
  });

  it("stops querying providers but keeps every cached picture when automatic fetching is off", async () => {
    let now = 5_000_000;
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const online = makeHarness({ providers: [provider], now: () => now });
    await online.service.resolve({ name: "Nagorizakura" });
    expect(online.cache.stats().artists).toBe(1);

    const offline = makeHarness({ providers: [provider], cache: online.cache, autoFetch: false, now: () => now });
    const uncached = await offline.service.resolve({ name: "Nogizaka46" });

    expect(uncached.status).toBe("unavailable");
    expect(uncached.reason).toBe("auto-fetch-disabled");
    expect(provider.calls).toBe(1);
    // Nothing was deleted and no permanent "no picture" answer was recorded for the untouched artist.
    expect(online.cache.stats().artists).toBe(1);
    expect(online.cache.stats().misses).toBe(0);
  });

  it("does not record a negative answer for artists skipped by the automatic-fetch switch", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const offline = makeHarness({ providers: [provider], autoFetch: false });
    await offline.service.resolve({ name: "Nagorizakura" });
    expect(offline.cache.stats().misses).toBe(0);

    // Re-enabling automatic fetching must therefore work on the very next request.
    const online = makeHarness({ providers: [provider], cache: offline.cache, autoFetch: true });
    const resolved = await online.service.resolve({ name: "Nagorizakura" });
    expect(resolved.status).toBe("fetched");
    expect(provider.calls).toBe(1);
  });

  it("still honours an explicit manual refresh while automatic fetching is off", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [provider], autoFetch: false });

    const automatic = await harness.service.resolve({ name: "Nagorizakura" });
    expect(automatic.reason).toBe("auto-fetch-disabled");

    const manual = await harness.service.refresh({ name: "Nagorizakura" });
    expect(manual.status).toBe("fetched");
    expect(manual.record?.provider).toBe("lastfm");
  });

  it("answers cached() without any network access for instant first paint", async () => {
    const provider = new StubProvider("lastfm", () => hitResult("lastfm"));
    const harness = makeHarness({ providers: [provider] });

    expect(harness.service.cached("Nagorizakura").record).toBeNull();
    await harness.service.resolve({ name: "Nagorizakura" });
    const cached = harness.service.cached("Nagorizakura");
    expect(cached.status).toBe("cached");
    expect(cached.record?.provider).toBe("lastfm");
    expect(provider.calls).toBe(1);
  });
});

describe("artist image cache core", () => {
  const record = (overrides: Partial<ArtistImageFileRecord> = {}): ArtistImageFileRecord => ({
    artistKey: artistImageKey("Nagorizakura"),
    artistName: "Nagorizakura",
    mbid: null,
    fileName: "abc.png",
    provider: "lastfm",
    sourceUrl: "https://img.test/a.jpg",
    pageUrl: null,
    attribution: "Last.fm",
    license: null,
    licenseUrl: null,
    author: null,
    width: 640,
    height: 640,
    confidence: 0.9,
    savedAt: 1000,
    verifiedAt: 1000,
    lastAccessAt: 1000,
    ...overrides,
  });

  it("keys artists case- and punctuation-insensitively", () => {
    expect(artistImageKey("Nagorizakura")).toBe(artistImageKey("  nagorizakura "));
    expect(artistImageKey("AC/DC")).toBe(artistImageKey("AC DC"));
    expect(artistImageKey("A")).not.toBe(artistImageKey("B"));
  });

  it("refuses to downgrade a verified picture", () => {
    const accepted = shouldReplaceImage(record({ confidence: 0.95 }), record({ confidence: 0.4 }), 2000);
    expect(accepted).toEqual({ stored: false, reason: "kept-higher-confidence" });
    const upgrade = shouldReplaceImage(record({ confidence: 0.4 }), record({ confidence: 0.95 }), 2000);
    expect(upgrade).toEqual({ stored: true, reason: "stored" });
  });

  it("allows a same-confidence refresh only once the entry has gone stale", () => {
    expect(shouldReplaceImage(record(), record({ savedAt: 2000 }), 2000, 10_000).stored).toBe(false);
    expect(shouldReplaceImage(record(), record({ savedAt: 20_000 }), 20_000, 10_000).stored).toBe(true);
  });

  it("discards an index written by an older version", () => {
    // v1 indexes hold the negative answers produced while the image transport corrupted every
    // download, so they must not survive the upgrade.
    const stale = new ArtistImageCacheCore({
      initialJson: JSON.stringify({
        version: ARTIST_IMAGE_CACHE_VERSION - 1,
        artists: { [artistImageKey("Stale")]: record({ artistName: "Stale" }) },
        misses: {
          [artistImageKey("Stale")]: {
            artistKey: artistImageKey("Stale"),
            artistName: "Stale",
            reason: "providers-unavailable",
            attempted: ["deezer"],
            failedAt: 1000,
            retryAfter: 10_000_000,
          },
        },
      }),
    });
    expect(stale.stats().artists).toBe(0);
    expect(stale.get(artistImageKey("Stale"))).toBeNull();
    expect(stale.getMiss(artistImageKey("Stale"))).toBeNull();
  });

  it("ignores corrupt files and unsafe file names instead of throwing", () => {
    const corrupt = new ArtistImageCacheCore({ initialJson: "{not json" });
    expect(corrupt.stats().artists).toBe(0);

    const traversal = new ArtistImageCacheCore({
      initialJson: JSON.stringify({
        version: ARTIST_IMAGE_CACHE_VERSION,
        artists: {
          [artistImageKey("Escape")]: { ...record({ artistName: "Escape" }), artistKey: artistImageKey("Escape"), fileName: "../../secrets.png" },
        },
        misses: {},
      }),
    });
    expect(traversal.stats().artists).toBe(0);
  });

  it("evicts the least recently used artist when the index is full", () => {
    const cache = new ArtistImageCacheCore({ now: () => 1000 }, { maxEntries: 16 });
    for (let index = 0; index < 20; index += 1) {
      cache.put(record({ artistKey: artistImageKey(`Artist ${index}`), artistName: `Artist ${index}` }));
    }
    expect(cache.stats().artists).toBe(16);
    expect(cache.get(artistImageKey("Artist 0"))).toBeNull();
    expect(cache.get(artistImageKey("Artist 19"))).not.toBeNull();
  });

  it("never rewrites a byte-identical index", () => {
    const persist = vi.fn();
    const cache = new ArtistImageCacheCore({ now: () => 1000, persist });
    cache.put(record());
    const callsAfterPut = persist.mock.calls.length;
    cache.save();
    cache.save();
    expect(persist.mock.calls.length).toBe(callsAfterPut);
  });
});
