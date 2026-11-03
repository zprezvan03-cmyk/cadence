/**
 * Regression tests for wiring the YouTube Music lyrics provider into the existing lyrics
 * engine (Stage 7 audit): remote items must resolve through `youtube-music` keyed by video id,
 * cache under `remote:<videoId>` (never a shared `track:-1` slot), and local resolves must skip
 * the provider cleanly. The InnerTube provider is mocked — no test reaches the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lyricsMock = vi.fn<(videoId: string) => Promise<string | null>>();

vi.mock("../../src/main/ytmusic/provider", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/main/ytmusic/provider")>();
  return {
    ...original,
    getYouTubeMusicProvider: () => ({ lyrics: lyricsMock }),
  };
});

import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { YtmProviderError } from "../../src/main/ytmusic/provider";
import { LibraryStore } from "../../src/main/library/store";
import { LYRIC_SOURCE_KEYS } from "../../src/shared/upstream/better-lyrics/constants";

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-ytmlyrics-"));
  const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
    disableSqlite: true,
  });
  const cache = new LyricsCache(join(dir, "lyrics.json"));
  return { dir, store, cache, service: new LyricsService(store, cache) };
}

const REMOTE_REQUEST = {
  trackId: -424242,
  remote: { remoteId: "vidABC123", canonicalUrl: "https://music.youtube.com/watch?v=vidABC123" },
  title: "Remote Song",
  artist: "Remote Artist",
  album: "Remote Album",
  duration: 213,
};

// orderFor() merges a stored order with DEFAULT_PROVIDER_ORDER, so to run ONLY the YTM provider
// the other known keys must be explicitly toggled off with the "d_" prefix.
const YTM_ONLY = [
  "youtube-music",
  ...LYRIC_SOURCE_KEYS.filter(key => key !== "youtube-music").map(key => `d_${key}`),
];

afterEach(() => {
  lyricsMock.mockReset();
  vi.unstubAllGlobals();
});

describe("YouTube Music lyrics integration", () => {
  it("resolves a remote item through the youtube-music provider using its video id", async () => {
    const { service } = makeService();
    lyricsMock.mockResolvedValue("first line\nsecond line");

    const result = await service.resolve({ ...REMOTE_REQUEST }, YTM_ONLY);

    expect(lyricsMock).toHaveBeenCalledTimes(1);
    expect(lyricsMock).toHaveBeenCalledWith("vidABC123");
    const hit = result.providerStatus.find(entry => entry.provider === "youtube-music");
    expect(hit).toMatchObject({ status: "hit" });
    const candidate = result.candidates.find(c => c.source === "youtube-music");
    expect(candidate?.text).toBe("first line\nsecond line");
    expect(candidate?.syncHint).toBe("none");
    expect(candidate?.sourceHref).toBe("https://music.youtube.com/watch?v=vidABC123");
  });

  it("caches remote resolutions under remote:<videoId>, not under a shared placeholder track key", async () => {
    const { service, cache } = makeService();
    lyricsMock.mockResolvedValue("cached words");

    await service.resolve({ ...REMOTE_REQUEST }, YTM_ONLY);
    // Second resolve: served from the cache, provider not called again.
    const again = await service.resolve({ ...REMOTE_REQUEST }, YTM_ONLY);
    expect(lyricsMock).toHaveBeenCalledTimes(1);
    expect(again.candidates.some(c => c.source === "youtube-music")).toBe(true);

    expect(cache.getEntry("remote:vidABC123")).not.toBeNull();
    expect(cache.getEntry("track:-424242")).toBeNull();

    // A different video id must not collide with the first one.
    const other = await service.resolve(
      { ...REMOTE_REQUEST, remote: { remoteId: "vidOTHER999", canonicalUrl: "https://music.youtube.com/watch?v=vidOTHER999" }, title: "Other Song" },
      YTM_ONLY
    );
    expect(lyricsMock).toHaveBeenCalledTimes(2);
    expect(lyricsMock).toHaveBeenLastCalledWith("vidOTHER999");
    expect(other.candidates.some(c => c.source === "youtube-music")).toBe(true);
    expect(cache.getEntry("remote:vidOTHER999")).not.toBeNull();
  });

  it("reports a clean skip for local tracks without a remote identity", async () => {
    const { service } = makeService();
    const result = await service.resolve(
      { trackId: 12345, title: "Local Song", artist: "Local Artist", album: "", duration: 180 },
      YTM_ONLY
    );
    expect(lyricsMock).not.toHaveBeenCalled();
    const ytm = result.providerStatus.find(entry => entry.provider === "youtube-music");
    expect(ytm).toMatchObject({ status: "skipped" });
    expect(result.candidates).toHaveLength(0);
  });

  it("reports a definitive miss when YouTube Music has no lyrics for the video", async () => {
    const { service } = makeService();
    lyricsMock.mockResolvedValue(null);
    const result = await service.resolve({ ...REMOTE_REQUEST }, YTM_ONLY);
    const ytm = result.providerStatus.find(entry => entry.provider === "youtube-music");
    expect(ytm).toMatchObject({ status: "miss" });
    expect(result.definitive).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("surfaces provider errors as an error status instead of throwing", async () => {
    const { service } = makeService();
    lyricsMock.mockRejectedValue(new YtmProviderError("InnerTube request failed (403)", "http", 403));
    const result = await service.resolve({ ...REMOTE_REQUEST }, YTM_ONLY);
    const ytm = result.providerStatus.find(entry => entry.provider === "youtube-music");
    expect(ytm?.status).toBe("error");
    expect(ytm?.detail).toContain("403");
    expect(result.definitive).toBe(false);
  });
});
