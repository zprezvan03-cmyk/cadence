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
import {
  activeProviderEntries,
  addProviderToOrder,
  moveProviderInOrder,
  removeProviderFromOrder,
} from "../../src/shared/providerOrder";
import { parseSettingsJson } from "../../src/main/settingsCore";

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

  it("flags only the slot without a keyless endpoint as unavailable, with an explanation", () => {
    const unavailable = PROVIDER_CONFIGS.filter(config => !config.available).map(config => config.key);
    expect(unavailable).toEqual(["qq-line"]);
    for (const key of unavailable) {
      expect(providerConfig(key)?.unavailableReason).toBeTruthy();
    }
  });

  it("registers Better Lyrics and Better Lyrics Line as two independent, available slots", () => {
    const syllable = providerConfig("blyrics-richsynced");
    const line = providerConfig("blyrics-line");
    expect(syllable).toMatchObject({ displayName: "Better Lyrics", syncType: "syllable", available: true });
    expect(line).toMatchObject({ displayName: "Better Lyrics Line", syncType: "line", available: true });
    // Separate keys, separate names and separate positions in the recommended order.
    expect(syllable?.key).not.toBe(line?.key);
    expect(syllable?.priority).not.toBe(line?.priority);
    expect(DEFAULT_PROVIDER_ORDER).toContain("blyrics-richsynced");
    expect(DEFAULT_PROVIDER_ORDER).toContain("blyrics-line");
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

describe("Settings edits to the provider order", () => {
  /** What the Settings screen persists after the user presses a button. */
  const reload = (order: readonly string[]): string[] =>
    parseSettingsJson(JSON.stringify({ lyrics: { providerOrder: [...order] } })).lyrics.providerOrder;

  it("keeps a removed provider out of the order across a reload", () => {
    const removed = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line");

    expect(removed).toContain("d_blyrics-line");
    expect(activeProviderEntries(removed)).not.toContain("blyrics-line");
    // The regression this guards: splicing the key out lets migrateProviderOrder merge the default
    // straight back in — enabled — so the removal silently undid itself on the next load.
    expect(reload(DEFAULT_PROVIDER_ORDER.filter(key => key !== "blyrics-line"))).toContain("blyrics-line");
    expect(activeProviderEntries(reload(removed))).not.toContain("blyrics-line");
    expect(reload(removed)).toContain("d_blyrics-line");
  });

  it("removes the two Better Lyrics slots independently of each other", () => {
    const withoutLine = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line");
    expect(activeProviderEntries(withoutLine)).toContain("blyrics-richsynced");
    expect(activeProviderEntries(withoutLine)).not.toContain("blyrics-line");

    const withoutSyllable = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-richsynced");
    expect(activeProviderEntries(withoutSyllable)).toContain("blyrics-line");
    expect(activeProviderEntries(withoutSyllable)).not.toContain("blyrics-richsynced");

    const neither = removeProviderFromOrder(withoutLine, "blyrics-richsynced");
    expect(activeProviderEntries(neither)).not.toContain("blyrics-line");
    expect(activeProviderEntries(neither)).not.toContain("blyrics-richsynced");
  });

  it("re-adds a removed provider at its old priority and appends an unknown-to-the-order one", () => {
    const removed = removeProviderFromOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line");
    const restored = addProviderToOrder(removed, "blyrics-line");
    expect(restored).toEqual([...DEFAULT_PROVIDER_ORDER]);

    const appended = addProviderToOrder(DEFAULT_PROVIDER_ORDER, "unison-plain");
    expect(appended.at(-1)).toBe("unison-plain");
    expect(addProviderToOrder(appended, "unison-plain")).toEqual(appended);
  });

  it("moves an active provider past its active neighbour without disturbing disabled slots", () => {
    const moved = moveProviderInOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line", -1);
    expect(moved.indexOf("blyrics-line")).toBe(DEFAULT_PROVIDER_ORDER.indexOf("blyrics-line") - 1);
    expect(moved.indexOf("blyrics-richsynced")).toBe(DEFAULT_PROVIDER_ORDER.indexOf("blyrics-richsynced"));
    expect([...moved].sort()).toEqual([...DEFAULT_PROVIDER_ORDER].sort());

    // A disabled entry sitting between two active ones keeps its slot.
    const withHole = ["local-rich", "d_blyrics-richsynced", "blyrics-line", "lrclib-synced"];
    expect(moveProviderInOrder(withHole, "blyrics-line", -1)).toEqual([
      "blyrics-line",
      "d_blyrics-richsynced",
      "local-rich",
      "lrclib-synced",
    ]);

    // No-ops at the ends and for a provider that is not in the order.
    expect(moveProviderInOrder(DEFAULT_PROVIDER_ORDER, "local-rich", -1)).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(moveProviderInOrder(DEFAULT_PROVIDER_ORDER, "embedded-tag", 1)).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(moveProviderInOrder(DEFAULT_PROVIDER_ORDER, "unison-plain", 1)).toEqual([...DEFAULT_PROVIDER_ORDER]);
  });

  it("survives a reload with the custom order and the removal both intact", () => {
    const edited = removeProviderFromOrder(
      moveProviderInOrder(DEFAULT_PROVIDER_ORDER, "blyrics-line", -1),
      "blyrics-richsynced"
    );
    const reloaded = reload(edited);
    expect(reloaded).toEqual(edited);
    expect(activeProviderEntries(reloaded)[1]).toBe("unison-richsynced");
    expect(activeProviderEntries(reloaded)).toContain("blyrics-line");
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

    for (const key of ["qq-line"]) {
      const status = result.providerStatus.find(entry => entry.provider === key);
      expect(status).toMatchObject({ status: "skipped" });
      expect(status?.detail).toContain("Unavailable");
    }
    // `blyrics-line` is a real slot now: it is served by /getLyrics through the `better-lyrics`
    // module, so it is never reported as an unavailable slot.
    expect(
      result.providerStatus.some(
        entry => entry.provider === "blyrics-line" && /Unavailable/.test(entry.detail ?? "")
      )
    ).toBe(false);
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
      "d_blyrics-line",
      "lrclib-synced",
      "embedded-tag",
    ]);

    expect(result.candidates.map(c => c.source)).toEqual(["lrclib-synced"]);
    // Both /getLyrics slots are disabled, so that endpoint is never called; remaining enabled
    // Better Lyrics variants (QQ/Kugou) still fan out alongside LRCLIB, so check the specific path
    // rather than the whole host.
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
