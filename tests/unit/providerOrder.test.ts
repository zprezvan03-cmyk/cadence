/**
 * Tests for the provider registry, the recommended 13-entry default order, legacy order migration
 * and the service behavior those keys drive (local split, unavailable slots, disabled slots).
 * Network is mocked everywhere — no test reaches a live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import {
  DEFAULT_PROVIDER_ORDER,
  LYRIC_SOURCE_KEYS,
  PROVIDER_CONFIGS,
  isKnownProviderKey,
  migrateProviderOrder,
  providerConfig,
  untoggleProvider,
} from "../../src/shared/upstream/better-lyrics/constants";

const RECOMMENDED_13 = [
  "local-rich",
  "blyrics-richsynced",
  "unison-richsynced",
  "binimum-richsynced",
  "blyrics-wordsynced",
  "local-lrc",
  "blyrics-line",
  "unison-synced",
  "blyrics-synced",
  "qq-line",
  "lrclib-synced",
  "lrclib-plain",
  "embedded-tag",
];

describe("provider registry and default order", () => {
  it("exposes exactly the recommended 13 providers in the mandated order, with no duplicates", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(RECOMMENDED_13);
    expect(new Set(DEFAULT_PROVIDER_ORDER).size).toBe(13);
  });

  it("gives every default slot a registry entry and keeps priorities contiguous", () => {
    DEFAULT_PROVIDER_ORDER.forEach((key, index) => {
      const config = providerConfig(key);
      expect(config).toBeDefined();
      expect(config?.priority).toBe(index + 1);
    });
  });

  it("flags only the two slots without a keyless endpoint as unavailable, with explanations", () => {
    const unavailable = PROVIDER_CONFIGS.filter(config => !config.available).map(config => config.key);
    expect(unavailable).toEqual(["blyrics-line", "qq-line"]);
    for (const key of unavailable) {
      expect(providerConfig(key)?.unavailableReason).toBeTruthy();
    }
  });

  it("keeps implemented variants outside the default but available in the registry", () => {
    for (const key of ["unison-wordsynced", "binimum-synced", "unison-plain"]) {
      expect(DEFAULT_PROVIDER_ORDER).not.toContain(key);
      expect(LYRIC_SOURCE_KEYS).toContain(key);
      expect(providerConfig(key)?.available).toBe(true);
    }
  });

  it("never registers the legacy local-sidecar key as a selectable provider", () => {
    expect(isKnownProviderKey("local-sidecar")).toBe(false);
    expect(LYRIC_SOURCE_KEYS).not.toContain("local-sidecar");
  });
});

describe("migrateProviderOrder", () => {
  it("returns the exact default for missing or empty input", () => {
    expect(migrateProviderOrder(undefined)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder(null)).toEqual(RECOMMENDED_13);
    expect(migrateProviderOrder([])).toEqual(RECOMMENDED_13);
  });

  it("splits the legacy local-sidecar source into local-rich then local-lrc", () => {
    const migrated = migrateProviderOrder(["local-sidecar", "lrclib-plain"]);
    expect(migrated.indexOf("local-rich")).toBeLessThan(migrated.indexOf("local-lrc"));
    expect(migrated).toContain("lrclib-plain");
    expect(migrated).not.toContain("local-sidecar");
    // New slots introduced by the registry are merged in at their canonical positions.
    expect(migrated).toEqual(expect.arrayContaining(RECOMMENDED_13));
  });

  it("preserves a disabled prefix when splitting and for existing slots", () => {
    const migrated = migrateProviderOrder(["d_local-sidecar", "d_lrclib-synced", "lrclib-plain"]);
    expect(migrated).toContain("d_local-rich");
    expect(migrated).toContain("d_local-lrc");
    expect(migrated).toContain("d_lrclib-synced");
    expect(migrated).toContain("lrclib-plain");
  });

  it("drops unknown keys and collapses duplicates", () => {
    const migrated = migrateProviderOrder([
      "lrclib-plain",
      "made-up-provider",
      "lrclib-plain",
      "d_blyrics-richsynced",
      "blyrics-richsynced",
    ]);
    expect(migrated).not.toContain("made-up-provider");
    expect(migrated.filter(key => untoggleProvider(key) === "lrclib-plain")).toHaveLength(1);
    expect(migrated.filter(key => untoggleProvider(key) === "blyrics-richsynced")).toHaveLength(1);
  });

  it("preserves custom relative ordering while filling newly added slots", () => {
    const migrated = migrateProviderOrder(["embedded-tag", "blyrics-richsynced", "lrclib-plain"]);
    expect(migrated.indexOf("embedded-tag")).toBeLessThan(migrated.indexOf("blyrics-richsynced"));
    expect(migrated.indexOf("blyrics-richsynced")).toBeLessThan(migrated.indexOf("lrclib-plain"));
    expect(migrated).toContain("binimum-richsynced");
  });

  it("keeps implemented extra variants that a user had enabled", () => {
    const migrated = migrateProviderOrder(["local-rich", "unison-plain", "binimum-synced"]);
    expect(migrated).toContain("unison-plain");
    expect(migrated).toContain("binimum-synced");
  });
});

const TTML_WORD = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="00:00:12.300" end="00:00:15.000"><span begin="00:00:12.300" end="00:00:12.800">First </span><span begin="00:00:12.800" end="00:00:15.000">line</span></p>
</div></body></tt>`;
const LINE_LRC = "[00:12.30]first line\n[00:15.00]second line";

function makeService(trackPath: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "cadence-order-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  const fakeStore = {
    getTrack: () => (trackPath ? { path: trackPath, title: "Harness Song", trackNo: 1 } : undefined),
    getLyrics: () => null,
  } as unknown as LibraryStore;
  return { service: new LyricsService(fakeStore, cache) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LyricsService provider-order behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  const resolveRequest = { trackId: 1, title: "Harness Song", artist: "Harness Artist", album: "", duration: 100 } as never;

  it("classifies a TTML sidecar as local-rich and an LRC sidecar as local-lrc", async () => {
    const richDir = mkdtempSync(join(tmpdir(), "cadence-rich-"));
    const richTrack = join(richDir, "Song.flac");
    writeFileSync(richTrack, "fake audio");
    writeFileSync(join(richDir, "Song.ttml"), TTML_WORD);
    const rich = makeService(richTrack);
    const richResult = await rich.service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(richResult.candidates[0]!).toMatchObject({ source: "local-rich", syncHint: "richsync" });
    expect(richResult.providerStatus.find(s => s.provider === "local-rich")?.status).toBe("hit");
    expect(richResult.providerStatus.find(s => s.provider === "local-lrc")?.status).toBe("miss");

    const lrcDir = mkdtempSync(join(tmpdir(), "cadence-lrc-"));
    const lrcTrack = join(lrcDir, "Song.flac");
    writeFileSync(lrcTrack, "fake audio");
    writeFileSync(join(lrcDir, "Song.lrc"), LINE_LRC);
    const lrc = makeService(lrcTrack);
    const lrcResult = await lrc.service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);
    expect(lrcResult.candidates[0]!).toMatchObject({ source: "local-lrc", syncHint: "synced" });
    expect(lrcResult.providerStatus.find(s => s.provider === "local-lrc")?.status).toBe("hit");
    expect(lrcResult.providerStatus.find(s => s.provider === "local-rich")?.status).toBe("miss");
  });

  it("skips unavailable slots with an explanation and never sends network traffic for them", async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ error: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, DEFAULT_PROVIDER_ORDER);

    for (const key of ["blyrics-line", "qq-line"]) {
      const status = result.providerStatus.find(entry => entry.provider === key);
      expect(status).toMatchObject({ status: "skipped" });
      expect(status?.detail).toContain("Unavailable");
    }
    // Every real request goes to a documented host; no invented endpoint for the unavailable slots.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/qq-line|blyrics-line/);
    }
  });

  it("does not query a disabled (d_-prefixed) provider but continues through the rest", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("lrclib.net")) {
        return json({
          id: 9,
          trackName: "Harness Song",
          artistName: "Harness Artist",
          albumName: "",
          duration: 100,
          syncedLyrics: LINE_LRC,
          plainLyrics: null,
        });
      }
      return json({ error: "nope" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, [
      "d_blyrics-richsynced",
      "lrclib-synced",
      "embedded-tag",
    ]);

    expect(result.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    // The disabled rich endpoint is never called; remaining enabled Better Lyrics variants (QQ/Kugou)
    // still fan out alongside LRCLIB, so check the specific path rather than the whole host.
    const richCalls = fetchMock.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.includes("api.betterlyrics.org") && new URL(url).pathname === "/getLyrics");
    expect(richCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes("lrclib.net"))).toBe(true);
  });

  it("migrates a legacy order inside the service and resolves with the split local keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "nope" }, 404)));
    const { service } = makeService(null);

    const result = await service.resolve(resolveRequest, ["local-sidecar", "lrclib-plain"]);

    expect(result.providerStatus.some(s => s.provider === "local-rich")).toBe(true);
    expect(result.providerStatus.some(s => s.provider === "local-lrc")).toBe(true);
    expect(result.providerStatus.some(s => s.provider === "local-sidecar")).toBe(false);
  });
});
