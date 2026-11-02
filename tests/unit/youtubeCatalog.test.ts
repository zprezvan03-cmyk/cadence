/**
 * Official YouTube Data API v3 catalog tests. Every response is a local fixture; these tests
 * prove request construction, mapping, quota/error handling, caching and cancellation, not
 * that Google currently accepts any real user's API key.
 */

import { describe, expect, it, vi } from "vitest";
import {
  YouTubeCatalogCore,
  decodeYouTubeText,
  mapYouTubeVideoResource,
  parseYouTubeDuration,
} from "../../src/main/youtube/catalogCore";
import { mediaItemFromLocalTrack, mediaItemKey, trackSourceKey, youtubeMediaItem } from "../../src/shared/media";
import type { Track, YouTubeCatalogSettings } from "../../src/shared/types";
import {
  parseYouTubeChannelId,
  parseYouTubeLink,
  parseYouTubePlaylistId,
  parseYouTubeVideoLink,
} from "../../src/shared/youtube";
import { hashToRoute, routeToHash } from "../../src/renderer/state/uiStore";

const VIDEO_1 = "video000001";
const VIDEO_2 = "video000002";
const CHANNEL_ID = "UCchannel000000000001";
const UPLOADS_ID = "UUchannel000000000001";
const PLAYLIST_ID = "PLplaylist000001";
const SECRET = "AIza-test-secret-key";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function videoResource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "youtube#video",
    id,
    snippet: {
      title: id === VIDEO_1 ? "Blue &amp; Green &#39;Live&#39;" : "Second Song",
      channelId: CHANNEL_ID,
      channelTitle: "Cadence Artist - Topic",
      publishedAt: "2026-01-02T03:04:05Z",
      liveBroadcastContent: "none",
      thumbnails: {
        default: { url: `https://i.ytimg.com/vi/${id}/default.jpg` },
        medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
        high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
      },
    },
    contentDetails: { duration: id === VIDEO_1 ? "PT3M31S" : "PT1H2M3S" },
    status: { privacyStatus: "public", embeddable: id !== VIDEO_2 },
    ...overrides,
  };
}

function settingsState(
  overrides: Partial<YouTubeCatalogSettings> = {}
): { value: YouTubeCatalogSettings } {
  return {
    value: {
      enabled: true,
      apiKey: SECRET,
      region: "ID",
      ...overrides,
    },
  };
}

function makeCatalog(
  fetchFn: typeof fetch,
  settings = settingsState(),
  nowRef = { value: 1_700_000_000_000 }
) {
  return {
    settings,
    nowRef,
    core: new YouTubeCatalogCore({
      getSettings: () => settings.value,
      fetchFn,
      now: () => nowRef.value,
      localeRegion: () => "en-ID",
    }),
  };
}

describe("YouTube media/link model", () => {
  it("keeps local numeric IDs separate from remote string IDs", () => {
    const local = mediaItemFromLocalTrack({
      id: 42,
      title: "Local",
      artist: "Artist",
      album: "Album",
      duration: 180,
      artworkUrl: null,
      playable: true,
    } as Track);
    const remote = youtubeMediaItem({
      videoId: VIDEO_1,
      title: "Remote",
      artistLabel: "Artist",
    });
    expect(trackSourceKey(local.source)).toBe("local:42");
    expect(mediaItemKey(remote)).toBe(`youtube:${VIDEO_1}`);
    expect(local.source.kind).toBe("local");
    expect(remote.source.kind).toBe("youtube");
  });

  it("only labels an actual music.youtube.com link as YouTube Music", () => {
    expect(parseYouTubeVideoLink(`https://music.youtube.com/watch?v=${VIDEO_1}`)).toMatchObject({
      videoId: VIDEO_1,
      sourceKind: "youtube-music",
      canonicalUrl: `https://music.youtube.com/watch?v=${VIDEO_1}`,
    });
    expect(parseYouTubeVideoLink(`https://www.youtube.com/watch?v=${VIDEO_1}`)).toMatchObject({
      sourceKind: "youtube",
    });
  });

  it("routes public playlist and stable channel links without treating handles as IDs", () => {
    expect(parseYouTubePlaylistId(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`)).toBe(
      PLAYLIST_ID
    );
    expect(parseYouTubeChannelId(`https://www.youtube.com/channel/${CHANNEL_ID}`)).toBe(CHANNEL_ID);
    expect(parseYouTubeChannelId("https://www.youtube.com/@SomeHandle")).toBeNull();
    expect(parseYouTubeLink(`https://music.youtube.com/playlist?list=${PLAYLIST_ID}`)).toMatchObject({
      kind: "playlist",
      playlistId: PLAYLIST_ID,
      sourceKind: "youtube-music",
    });
    expect(parseYouTubeLink(`https://evil.example/channel/${CHANNEL_ID}`)).toBeNull();
  });

  it("round-trips remote detail routes", () => {
    expect(routeToHash({ name: "youtube-channel", channelId: CHANNEL_ID })).toBe(
      `#/youtube-channel/${CHANNEL_ID}`
    );
    expect(hashToRoute(`#/youtube-playlist/${PLAYLIST_ID}`)).toEqual({
      name: "youtube-playlist",
      playlistId: PLAYLIST_ID,
    });
  });

  it("decodes Data API text/entities and ISO-8601 durations", () => {
    expect(decodeYouTubeText("A &amp; B &#x1F600;  &quot;C&quot;")).toBe('A & B 😀 "C"');
    expect(parseYouTubeDuration("PT3M31S")).toBe(211);
    expect(parseYouTubeDuration("P1DT2H3M4S")).toBe(93_784);
    expect(parseYouTubeDuration("not-a-duration")).toBeNull();
    expect(mapYouTubeVideoResource(videoResource(VIDEO_2), 123)?.availability).toBe(
      "not-embeddable"
    );
  });
});

describe("YouTubeCatalogCore settings gates", () => {
  it("does not fetch when disabled or when no user key is configured", async () => {
    const fetchFn = vi.fn(async () => json({ items: [] })) as unknown as typeof fetch;
    const disabled = makeCatalog(fetchFn, settingsState({ enabled: false }));
    await expect(disabled.core.trending()).resolves.toMatchObject({
      ok: false,
      error: { kind: "disabled" },
    });

    const missing = makeCatalog(fetchFn, settingsState({ apiKey: "" }));
    await expect(missing.core.searchMusicVideos({ query: "cadence" })).resolves.toMatchObject({
      ok: false,
      error: { kind: "missing-key" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns an aborted result without fetching for an already-aborted signal", async () => {
    const fetchFn = vi.fn(async () => json({ items: [] })) as unknown as typeof fetch;
    const { core } = makeCatalog(fetchFn);
    const controller = new AbortController();
    controller.abort();
    await expect(core.trending({}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("YouTubeCatalogCore documented endpoint mapping", () => {
  it("searches embeddable Music-category videos, enriches them in order, and caches the page", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.endsWith("/search")) {
        return json({
          kind: "youtube#searchListResponse",
          nextPageToken: "next-1",
          pageInfo: { totalResults: 99, resultsPerPage: 2 },
          items: [
            { id: { kind: "youtube#video", videoId: VIDEO_1 }, snippet: {} },
            { id: { kind: "youtube#video", videoId: VIDEO_2 }, snippet: {} },
          ],
        });
      }
      if (url.pathname.endsWith("/videos")) {
        // Return reverse order to prove the search ordering is restored by ID.
        return json({ items: [videoResource(VIDEO_2), videoResource(VIDEO_1)] });
      }
      throw new Error(`Unexpected URL ${url.pathname}`);
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn);

    const first = await core.searchMusicVideos({ query: " blue green ", maxResults: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.cached).toBe(false);
    expect(first.data.nextPageToken).toBe("next-1");
    expect(first.data.items.map(item => mediaItemKey(item))).toEqual([
      `youtube:${VIDEO_1}`,
      `youtube:${VIDEO_2}`,
    ]);
    expect(first.data.items[0]).toMatchObject({
      title: "Blue & Green 'Live'",
      artistLabel: "Cadence Artist",
      channelId: CHANNEL_ID,
      durationSeconds: 211,
      availability: "ready",
    });
    expect(first.data.items[1].availability).toBe("not-embeddable");

    const searchUrl = new URL(urls[0]);
    expect(searchUrl.origin + searchUrl.pathname).toBe("https://www.googleapis.com/youtube/v3/search");
    expect(searchUrl.searchParams.get("type")).toBe("video");
    expect(searchUrl.searchParams.get("videoCategoryId")).toBe("10");
    expect(searchUrl.searchParams.get("videoEmbeddable")).toBe("true");
    expect(searchUrl.searchParams.get("regionCode")).toBe("ID");
    expect(searchUrl.searchParams.get("q")).toBe("blue green");
    expect(searchUrl.searchParams.get("key")).toBe(SECRET);
    expect(urls).toHaveLength(2);

    const cached = await core.searchMusicVideos({ query: "BLUE   GREEN", maxResults: 2 });
    expect(cached).toMatchObject({ ok: true, data: { cached: true } });
    expect(urls).toHaveLength(2);
  });

  it("maps channel and playlist search results with batch detail calls", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.endsWith("/search") && url.searchParams.get("type") === "channel") {
        return json({
          pageInfo: { totalResults: 1 },
          items: [{ id: { channelId: CHANNEL_ID }, snippet: { title: "Search title" } }],
        });
      }
      if (url.pathname.endsWith("/channels")) {
        return json({
          items: [
            {
              id: CHANNEL_ID,
              snippet: {
                title: "Cadence Artist",
                customUrl: "@CadenceArtist",
                description: "Channel &amp; description",
                thumbnails: { high: { url: "https://yt3.googleusercontent.com/avatar.jpg" } },
              },
              contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID } },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/search") && url.searchParams.get("type") === "playlist") {
        return json({
          pageInfo: { totalResults: 1 },
          items: [{ id: { playlistId: PLAYLIST_ID }, snippet: { title: "Search playlist" } }],
        });
      }
      if (url.pathname.endsWith("/playlists")) {
        return json({
          items: [
            {
              id: PLAYLIST_ID,
              snippet: {
                title: "Public Mix",
                channelId: CHANNEL_ID,
                channelTitle: "Cadence Artist",
                thumbnails: { high: { url: "https://i.ytimg.com/pl.jpg" } },
              },
              contentDetails: { itemCount: 17 },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn);

    const channels = await core.searchChannels({ query: "cadence" });
    expect(channels).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: CHANNEL_ID,
            handle: "@CadenceArtist",
            uploadsPlaylistId: UPLOADS_ID,
          },
        ],
      },
    });
    const playlists = await core.searchPlaylists({ query: "mix" });
    expect(playlists).toMatchObject({
      ok: true,
      data: { items: [{ id: PLAYLIST_ID, itemCount: 17, channelId: CHANNEL_ID }] },
    });
    expect(urls).toHaveLength(4);
  });

  it("loads channel detail plus uploads and public playlists", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/channels")) {
        return json({
          items: [
            {
              id: CHANNEL_ID,
              snippet: { title: "Cadence Artist", thumbnails: {} },
              contentDetails: { relatedPlaylists: { uploads: UPLOADS_ID } },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/playlists")) {
        return json({
          items: [
            {
              id: PLAYLIST_ID,
              snippet: { title: "Artist Picks", channelId: CHANNEL_ID, channelTitle: "Cadence Artist" },
              contentDetails: { itemCount: 3 },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/playlistItems")) {
        expect(url.searchParams.get("playlistId")).toBe(UPLOADS_ID);
        return json({
          pageInfo: { totalResults: 1 },
          items: [
            {
              snippet: {
                title: "Upload snippet",
                resourceId: { kind: "youtube#video", videoId: VIDEO_1 },
              },
              contentDetails: { videoId: VIDEO_1 },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/videos")) return json({ items: [videoResource(VIDEO_1)] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn);
    const result = await core.getChannel({ channelId: CHANNEL_ID });
    expect(result).toMatchObject({
      ok: true,
      data: {
        channel: { id: CHANNEL_ID, uploadsPlaylistId: UPLOADS_ID },
        playlists: [{ id: PLAYLIST_ID }],
        uploads: { items: [{ title: "Blue & Green 'Live'" }] },
      },
    });
  });

  it("preserves unavailable playlist entries instead of silently dropping them", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/playlistItems")) {
        return json({
          nextPageToken: "page-2",
          items: [
            {
              snippet: {
                title: "Deleted video",
                resourceId: { videoId: VIDEO_1 },
                videoOwnerChannelTitle: "Someone - Topic",
              },
              contentDetails: { videoId: VIDEO_1 },
            },
            {
              snippet: { title: "Available", resourceId: { videoId: VIDEO_2 } },
              contentDetails: { videoId: VIDEO_2 },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/videos")) {
        return json({
          items: [
            videoResource(VIDEO_2, {
              status: { privacyStatus: "public", embeddable: true },
            }),
          ],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn);
    const result = await core.getPlaylistItems({ playlistId: PLAYLIST_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.nextPageToken).toBe("page-2");
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0]).toMatchObject({
      title: "Deleted video",
      artistLabel: "Someone",
      availability: "unavailable",
    });
    expect(result.data.items[1].availability).toBe("ready");
  });

  it("bounds concurrent catalog HTTP requests", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn = (async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      active -= 1;
      return json({ items: [], pageInfo: { totalResults: 0 } });
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn);
    await Promise.all([
      core.searchMusicVideos({ query: "alpha" }),
      core.searchChannels({ query: "alpha" }),
      core.searchPlaylists({ query: "alpha" }),
      core.trending(),
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("YouTubeCatalogCore quota/error mapping and cache identity", () => {
  it("maps invalid key, disabled API, quota and rate-limit errors without leaking the key", async () => {
    const cases = [
      {
        status: 400,
        reason: "keyInvalid",
        errorStatus: "INVALID_ARGUMENT",
        message: `API key not valid: ${SECRET}`,
        kind: "invalid-key",
      },
      {
        status: 403,
        reason: "accessNotConfigured",
        errorStatus: "PERMISSION_DENIED",
        message: "YouTube Data API v3 has not been used in project before or it is disabled.",
        kind: "api-not-enabled",
      },
      {
        status: 403,
        reason: "quotaExceeded",
        errorStatus: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded",
        kind: "quota-exceeded",
      },
      {
        status: 429,
        reason: "rateLimitExceeded",
        errorStatus: "RESOURCE_EXHAUSTED",
        message: "Rate limit",
        kind: "rate-limited",
      },
    ] as const;

    for (const testCase of cases) {
      const fetchFn = (async () =>
        json(
          {
            error: {
              code: testCase.status,
              message: testCase.message,
              status: testCase.errorStatus,
              errors: [{ reason: testCase.reason, message: testCase.message }],
            },
          },
          testCase.status
        )) as typeof fetch;
      const { core } = makeCatalog(fetchFn);
      const result = await core.trending();
      expect(result).toMatchObject({ ok: false, error: { kind: testCase.kind, status: testCase.status } });
      if (!result.ok) expect(result.error.message).not.toContain(SECRET);
    }
  });

  it("expires search cache entries and clears them when the API-key identity changes", async () => {
    let searchCalls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) {
        searchCalls += 1;
        return json({ items: [{ id: { videoId: VIDEO_1 } }], pageInfo: { totalResults: 1 } });
      }
      return json({ items: [videoResource(VIDEO_1)] });
    }) as typeof fetch;
    const { core, settings, nowRef } = makeCatalog(fetchFn);

    await core.searchMusicVideos({ query: "cache song" });
    await core.searchMusicVideos({ query: "cache song" });
    expect(searchCalls).toBe(1);

    nowRef.value += 16 * 60_1000;
    await core.searchMusicVideos({ query: "cache song" });
    expect(searchCalls).toBe(2);

    settings.value = { ...settings.value, apiKey: "AIza-a-different-key" };
    expect(core.status().cacheEntries).toBe(0);
    await core.searchMusicVideos({ query: "cache song" });
    expect(searchCalls).toBe(3);
  });

  it("uses the locale region for trending when the setting is blank", async () => {
    let trendingUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      trendingUrl = String(input);
      return json({ items: [videoResource(VIDEO_1)], pageInfo: { totalResults: 1 } });
    }) as typeof fetch;
    const { core } = makeCatalog(fetchFn, settingsState({ region: "" }));
    const result = await core.trending({ maxResults: 1 });
    expect(result.ok).toBe(true);
    expect(new URL(trendingUrl).searchParams.get("regionCode")).toBe("ID");
    expect(core.status()).toMatchObject({ configured: true, region: "ID" });
  });
});
