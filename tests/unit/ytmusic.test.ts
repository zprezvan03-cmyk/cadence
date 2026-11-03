/**
 * Unit tests for Cadence's InnerTube-based YouTube Music provider: request construction (client
 * profile, headers, context, continuation params), anonymous visitor-data bootstrap, response
 * parsers (search/home/artist/album/playlist/explore/suggestions/next/lyrics/player), caching,
 * in-flight deduplication and stream-resolution policy.
 *
 * Fixtures mirror real music.youtube.com InnerTube response shapes (as modeled by the ArchiveTune
 * reference, rukamori/core @ fefeefa — interface facts only). No network is used; fetch is stubbed.
 */

import { describe, expect, it, vi } from "vitest";
import { InnerTubeClient, InnerTubeError, WEB_REMIX_PROFILE } from "../../src/main/ytmusic/innertube";
import { YouTubeMusicProvider, YTM_BROWSE_IDS, YTM_FILTER_PARAMS, YtmProviderError } from "../../src/main/ytmusic/provider";
import {
  continuationToken,
  parseAlbumPage,
  parseArtistPage,
  parseChartsPage,
  parseExplorePage,
  parseHomePage,
  parseListItem,
  parseLyricsResponse,
  parseMoodsAndGenres,
  parseNextResponse,
  parsePlayerResponse,
  parsePlaylistPage,
  parseSearchResponse,
  parseSuggestions,
  parseTimeText,
  splitBySeparator,
} from "../../src/main/ytmusic/parsers";
import { mediaItemFromYtmTrack } from "../../src/shared/ytmusic";

/* ------------------------------------------------------------------ fixtures */

const VIDEO_ID = "dQw4w9WgXcQ";

function songRenderer(overrides: Record<string, unknown> = {}) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: "Never Gonna Give You Up" }] },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                { text: "Rick Astley", navigationEndpoint: { browseEndpoint: { browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" } } },
                { text: " • " },
                { text: "Whenever You Need Somebody", navigationEndpoint: { browseEndpoint: { browseId: "MPREb_foo" } } },
                { text: " • " },
                { text: "3:32" },
              ],
            },
          },
        },
      ],
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 120, height: 90 }, { url: "https://i.ytimg.com/vi/x/mqdefault.jpg", width: 320, height: 180 }] } } },
      navigationEndpoint: {
        watchEndpoint: {
          videoId: VIDEO_ID,
          playlistId: "OLAK5uy_test",
          watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } },
        },
      },
      playlistItemData: { videoId: VIDEO_ID, playlistId: "OLAK5uy_test", setVideoId: "set123" },
      ...overrides,
    },
  };
}

function albumTwoRow() {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: "Whenever You Need Somebody" }] },
      subtitle: { runs: [{ text: "Rick Astley" }, { text: " • " }, { text: "Album" }, { text: " • " }, { text: "1987" }] },
      thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/a/1.jpg", width: 544, height: 544 }] } } },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: "MPREb_foo",
          browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } },
        },
      },
    },
  };
}

function artistTwoRow() {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: "Rick Astley" }] },
      subtitle: { runs: [{ text: "2.5M subscribers" }] },
      thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/b/1.jpg", width: 544, height: 544 }] } } },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: "UCuAXFkgsw1L7xaCfnd5JJOw",
          browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } },
        },
      },
    },
  };
}

function continuation() {
  return {
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token: "TOKEN_ABC" } },
    },
  };
}

const searchResponse = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            title: "Songs",
            content: {
              sectionListRenderer: {
                contents: [
                  { musicShelfRenderer: { title: { runs: [{ text: "Songs" }] }, contents: [songRenderer()] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Albums" }] } } }, contents: [albumTwoRow()] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Artists" }] } } }, contents: [artistTwoRow()] } },
                ],
                continuations: [continuation()],
              },
            },
          },
        },
      ],
    },
  },
};

const homeResponse = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                header: { chipCloudRenderer: { chips: [{ chipCloudChipRenderer: { text: { runs: [{ text: "All" }] }, isSelected: true, navigationEndpoint: { browseEndpoint: { params: "params_all" } } } }] } },
                contents: [
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Quick picks" }] }, moreContentButton: { buttonRenderer: { navigationEndpoint: { browseEndpoint: { browseId: "FEmusic_new_releases_albums" } } } } } }, contents: [albumTwoRow()] } },
                  { musicShelfRenderer: { title: { runs: [{ text: "Keep listening" }] }, contents: [songRenderer()] } },
                ],
                continuations: [continuation()],
              },
            },
          },
        },
      ],
    },
  },
};

const artistPageResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                header: { musicImmersiveHeaderRenderer: { title: { runs: [{ text: "Rick Astley" }] }, subtitle: { runs: [{ text: "2.5M subscribers" }] }, thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/b/big.jpg" }] } } } } },
                contents: [
                  { musicShelfRenderer: { title: { runs: [{ text: "Popular" }] }, contents: [songRenderer()] } },
                  { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Albums" }] } } }, contents: [albumTwoRow()] } },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

function songRendererSimple(videoId: string, title: string, duration: string) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Rick Astley" }, { text: " \u2022 " }, { text: duration }] } } },
      ],
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/hq.jpg", width: 120, height: 90 }] } } },
      navigationEndpoint: {
        watchEndpoint: {
          videoId,
          watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } },
        },
      },
      playlistItemData: { videoId },
    },
  };
}

const albumPageResponse = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                header: {
                  musicResponsiveHeaderRenderer: {
                    title: { runs: [{ text: "Whenever You Need Somebody" }] },
                    subtitle: { runs: [{ text: "Rick Astley" }, { text: " \u2022 " }, { text: "1987" }, { text: " \u2022 " }, { text: "12 songs" }, { text: " \u2022 " }, { text: "41 min" }] },
                    thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/a/big.jpg" }] },
                  },
                },
                contents: [
                  {
                    musicShelfRenderer: {
                      title: { runs: [{ text: "Songs" }] },
                      contents: [songRenderer(), songRendererSimple("yPYZpwSpKmA", "Together Forever", "3:24")],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const playlistPageResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicPlaylistShelfRenderer: {
                      contents: [songRenderer()],
                      continuations: [continuation()],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
      header: {
        musicEditablePlaylistDetailHeaderRenderer: {
          title: { runs: [{ text: "Top Hits" }] },
          subtitle: { runs: [{ text: "Some DJ", navigationEndpoint: { browseEndpoint: { browseId: "UCdj123", browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } } } } }, { text: " • " }, { text: "100 songs" }, { text: " • " }, { text: "1,234,567 views" }] },
          thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/p/big.jpg" }] },
        },
      },
    },
  },
};

const suggestionsResponse = {
  contents: [
    {
      searchSuggestionsSectionRenderer: {
        contents: [
          { searchSuggestionRenderer: { suggestion: { runs: [{ text: "rick " }, { text: "astley" }] } } },
          { searchSuggestionRenderer: { suggestion: { runs: [{ text: "rick roll" }] } } },
        ],
      },
    },
    {
      searchSuggestionsSectionRenderer: {
        contents: [{ ...songRenderer() }],
      },
    },
  ],
};

const nextResponse = {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [
            { tabRenderer: { title: "Up next", endpoint: { browseEndpoint: { browseId: "RDAMVM" + VIDEO_ID } } } },
            { tabRenderer: { title: "Lyrics", endpoint: { browseEndpoint: { browseId: "LYRICS_BROWSE_ID", params: "lyrics_params" } } } },
          ],
        },
      },
      playlistPanelRenderer: {
        contents: [
          {
            playlistPanelVideoRenderer: {
              videoId: VIDEO_ID,
              title: { runs: [{ text: "Never Gonna Give You Up" }] },
              longBylineText: { runs: [{ text: "Rick Astley" }] },
              lengthText: { runs: [{ text: "3:32" }] },
              selected: true,
              navigationEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
            },
          },
        ],
        continuations: [continuation()],
      },
    },
  },
};

const lyricsResponse = {
  contents: {
    sectionListRenderer: {
      contents: [
        { musicDescriptionShelfRenderer: { title: { runs: [{ text: "Lyrics" }] }, description: { runs: [{ text: "Never gonna give you up\nNever gonna let you down" }] } } },
      ],
    },
  },
};

const playerResponse = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VIDEO_ID, title: "Never Gonna Give You Up", author: "Rick Astley", channelId: "UCuAXFkgsw1L7xaCfnd5JJOw", lengthSeconds: "212" },
  streamingData: {
    adaptiveFormats: [
      { itag: 140, url: "https://rr1---sn.googlevideo.com/videoplayback?itag=140", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129812, contentLength: "3456789", audioQuality: "AUDIO_QUALITY_MEDIUM", approxDurationMs: "212000" },
      { itag: 251, url: "https://rr1---sn.googlevideo.com/videoplayback?itag=251", mimeType: 'audio/webm; codecs="opus"', bitrate: 137000, audioQuality: "AUDIO_QUALITY_MEDIUM", approxDurationMs: "212000" },
      { itag: 18, signatureCipher: "s=abc&sp=sig&url=https%3A%2F%2Frr.googlevideo.com%2Fvideoplayback%3Fitag%3D18", mimeType: 'video/mp4; codecs="avc1"', bitrate: 400000 },
    ],
  },
};

const cipheredOnlyPlayerResponse = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VIDEO_ID, title: "X", lengthSeconds: "10" },
  streamingData: {
    adaptiveFormats: [
      { itag: 140, signatureCipher: "s=abc&sp=sig&url=...", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129812 },
    ],
  },
};

/* ------------------------------------------------------------------ stub fetch */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stubFetch(handler: (req: CapturedRequest) => { status?: number; body: string }) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(req);
    const result = handler(req);
    return new Response(result.body, { status: result.status ?? 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const jsonResponder = (payload: unknown) => () => ({ body: JSON.stringify(payload) });

/* ------------------------------------------------------------------ tests */

describe("InnerTube client", () => {
  it("posts to music.youtube.com with the WEB_REMIX profile headers and context", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponder({ ok: true }));
    const client = new InnerTubeClient({ visitorData: "Cgt_test123", cookie: null, gl: "ID", hl: "id" }, fetchImpl);
    await client.search("rick astley", YTM_FILTER_PARAMS.songs, null);
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.url.startsWith("https://music.youtube.com/youtubei/v1/search")).toBe(true);
    expect(req.url).toContain("prettyPrint=false");
    expect(req.method).toBe("POST");
    expect(req.headers["x-youtube-client-name"]).toBe(WEB_REMIX_PROFILE.clientId);
    expect(req.headers["x-youtube-client-version"]).toBe(WEB_REMIX_PROFILE.clientVersion);
    expect(req.headers["x-origin"]).toBe("https://music.youtube.com");
    expect(req.headers["x-goog-visitor-id"]).toBe("Cgt_test123");
    expect(req.headers["cookie"]).toBeUndefined();
    const body = JSON.parse(req.body!);
    expect(body.context.client.clientName).toBe("WEB_REMIX");
    expect(body.context.client.gl).toBe("ID");
    expect(body.context.client.visitorData).toBe("Cgt_test123");
    expect(body.query).toBe("rick astley");
    expect(body.params).toBe(YTM_FILTER_PARAMS.songs);
  });

  it("sends search continuations as continuation + ctoken query params", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponder({}));
    const client = new InnerTubeClient({ visitorData: "Cgt_x", cookie: null, gl: "US", hl: "en" }, fetchImpl);
    await client.search("q", null, "TOKEN_ABC");
    expect(calls[0].url).toContain("continuation=TOKEN_ABC");
    expect(calls[0].url).toContain("ctoken=TOKEN_ABC");
  });

  it("forwards a connected account cookie verbatim and never derives SAPISIDHASH", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponder({}));
    const client = new InnerTubeClient({ visitorData: null, cookie: "SAPISID=abc; OTHER=1", gl: "US", hl: "en" }, fetchImpl);
    await client.browse({ browseId: "FEmusic_home" });
    expect(calls[0].headers["cookie"]).toBe("SAPISID=abc; OTHER=1");
    expect(calls[0].headers["authorization"]).toBeUndefined();
    expect(calls[0].headers["x-goog-authuser"]).toBeUndefined();
    const body = JSON.parse(calls[0].body!);
    expect(body.context.user?.onBehalfOfUser).toBeUndefined();
  });

  it("player requests carry no PO token / serviceIntegrityDimensions", async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponder({}));
    const client = new InnerTubeClient({ visitorData: null, cookie: null, gl: "US", hl: "en" }, fetchImpl);
    await client.player(VIDEO_ID);
    const body = JSON.parse(calls[0].body!);
    expect(calls[0].url).toContain("/youtubei/v1/player");
    expect(body.videoId).toBe(VIDEO_ID);
    expect(body.serviceIntegrityDimensions).toBeUndefined();
    expect(body.playbackContext).toBeUndefined();
  });

  it("maps HTTP errors to typed InnerTubeError", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: "forbidden" }));
    const client = new InnerTubeClient({ visitorData: null, cookie: null, gl: "US", hl: "en" }, fetchImpl);
    await expect(client.browse({ browseId: "FEmusic_home" })).rejects.toMatchObject({ kind: "http", status: 403 });
    await expect(client.browse({ browseId: "FEmusic_home" })).rejects.toBeInstanceOf(InnerTubeError);
  });

  it("fetches anonymous visitor data from sw.js_data", async () => {
    const swJs = ")]}" + String.fromCharCode(39) + "\n" + JSON.stringify([["x"],["y"],["CgtVISITOR1abc","other"]]);
    const { fetchImpl, calls } = stubFetch(req =>
      req.url.includes("sw.js_data") ? { body: swJs } : { body: "{}" }
    );
    const client = new InnerTubeClient({ visitorData: null, cookie: null, gl: "US", hl: "en" }, fetchImpl);
    const visitor = await client.fetchVisitorData();
    expect(visitor).toBe("CgtVISITOR1abc");
    expect(client.getSession().visitorData).toBe("CgtVISITOR1abc");
    expect(calls[0].url).toBe("https://music.youtube.com/sw.js_data");
  });
});

describe("parsers", () => {
  it("parses time text and separators", () => {
    expect(parseTimeText("3:32")).toBe(212);
    expect(parseTimeText("1:02:07")).toBe(3727);
    expect(parseTimeText("hello")).toBeNull();
    expect(splitBySeparator([{ text: "A" }, { text: " • " }, { text: "B" }])).toEqual(["A", "B"]);
  });

  it("parses a song list item with artists, album, duration and thumbnail", () => {
    const item = parseListItem(songRenderer().musicResponsiveListItemRenderer);
    expect(item?.type).toBe("song");
    if (item?.type === "song") {
      expect(item.track.videoId).toBe(VIDEO_ID);
      expect(item.track.title).toBe("Never Gonna Give You Up");
      expect(item.track.artists[0]).toEqual({ name: "Rick Astley", browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" });
      expect(item.track.album).toEqual({ title: "Whenever You Need Somebody", browseId: "MPREb_foo" });
      expect(item.track.durationSeconds).toBe(212);
      expect(item.track.artworkUrl).toContain("i.ytimg.com");
      expect(item.track.playlistId).toBe("OLAK5uy_test");
      expect(item.track.setVideoId).toBe("set123");
    }
  });

  it("converts a parsed song into a youtube-music MediaItem (never a local id)", () => {
    const item = parseListItem(songRenderer().musicResponsiveListItemRenderer);
    if (item?.type !== "song") throw new Error("expected song");
    const media = mediaItemFromYtmTrack(item.track);
    expect(media.source).toEqual({
      kind: "youtube-music",
      remoteId: VIDEO_ID,
      canonicalUrl: `https://music.youtube.com/watch?v=${VIDEO_ID}&list=OLAK5uy_test`,
    });
    expect(media.durationSeconds).toBe(212);
    expect(media.artistLabel).toBe("Rick Astley");
  });

  it("parses search results with sections and continuation", () => {
    const results = parseSearchResponse(searchResponse, "songs");
    expect(results.continuation).toBe("TOKEN_ABC");
    const songs = results.items.filter(i => i.type === "song");
    const albums = results.items.filter(i => i.type === "album");
    const artists = results.items.filter(i => i.type === "artist");
    expect(songs).toHaveLength(1);
    expect(albums).toHaveLength(1);
    expect(artists).toHaveLength(1);
    if (albums[0].type === "album") {
      expect(albums[0].album.browseId).toBe("MPREb_foo");
      expect(albums[0].album.playlistId).toBe("OLAK5uy_foo");
      expect(albums[0].album.year).toBe(1987);
    }
  });

  it("parses home sections with chips and continuation", () => {
    const home = parseHomePage(homeResponse);
    expect(home.chips[0]?.title).toBe("All");
    expect(home.chips[0]?.params).toBe("params_all");
    expect(home.sections.length).toBe(2);
    expect(home.sections[0].moreBrowseId).toBe("FEmusic_new_releases_albums");
    expect(home.sections[1].items[0]?.type).toBe("song");
    expect(home.continuation).toBe("TOKEN_ABC");
  });

  it("parses artist, album and playlist pages", () => {
    const artist = parseArtistPage(artistPageResponse, "UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(artist.name).toBe("Rick Astley");
    expect(artist.subscriberCountText).toBe("2.5M subscribers");
    expect(artist.shelves.length).toBe(2);

    const album = parseAlbumPage(albumPageResponse, "MPREb_foo");
    expect(album.title).toBe("Whenever You Need Somebody");
    expect(album.year).toBe(1987);
    expect(album.tracks).toHaveLength(2);
    expect(album.tracks[1].videoId).toBe("yPYZpwSpKmA");

    const playlist = parsePlaylistPage(playlistPageResponse, "PL123");
    expect(playlist.title).toBe("Top Hits");
    expect(playlist.author?.name).toBe("Some DJ");
    expect(playlist.trackCountText).toBe("100 songs");
    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.continuation).toBe("TOKEN_ABC");
  });

  it("parses suggestions into queries and items", () => {
    const suggestions = parseSuggestions(suggestionsResponse);
    expect(suggestions.queries).toEqual(["rick astley", "rick roll"]);
    expect(suggestions.items).toHaveLength(1);
    expect(suggestions.items[0].type).toBe("song");
  });

  it("parses next responses: queue tracks, current index, lyrics endpoint", () => {
    const next = parseNextResponse(nextResponse);
    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0].videoId).toBe(VIDEO_ID);
    expect(next.tracks[0].durationSeconds).toBe(212);
    expect(next.currentIndex).toBe(0);
    expect(next.lyricsBrowseId).toBe("LYRICS_BROWSE_ID");
    expect(next.lyricsParams).toBe("lyrics_params");
    expect(next.continuation).toBe("TOKEN_ABC");
  });

  it("parses lyrics browse responses", () => {
    expect(parseLyricsResponse(lyricsResponse)).toContain("Never gonna give you up");
  });

  it("parses explore pages (new releases + moods) and moods grid", () => {
    const exploreResponse = {
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
            { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "New albums" }] }, moreContentButton: { buttonRenderer: { navigationEndpoint: { browseEndpoint: { browseId: "FEmusic_new_releases_albums" } } } } } }, contents: [albumTwoRow()] } },
            { musicCarouselShelfRenderer: { header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Moods" }] }, moreContentButton: { buttonRenderer: { navigationEndpoint: { browseEndpoint: { browseId: "FEmusic_moods_and_genres" } } } } } }, contents: [{ musicNavigationButtonRenderer: { buttonText: { runs: [{ text: "Happy" }] }, navigationEndpoint: { browseEndpoint: { browseId: "FEmusic_moods_and_genres_category_happy", params: "p1" } } } }] } },
          ] } } } }],
        },
      },
    };
    const explore = parseExplorePage(exploreResponse);
    expect(explore.newReleaseAlbums).toHaveLength(1);
    expect(explore.moodAndGenres).toEqual([{ title: "Happy", browseId: "FEmusic_moods_and_genres_category_happy", params: "p1" }]);

    const moods = parseMoodsAndGenres({
      contents: { sectionListRenderer: { contents: [
        { musicNavigationButtonRenderer: { buttonText: { runs: [{ text: "Chill" }] }, navigationEndpoint: { browseEndpoint: { browseId: "FEmusic_chill", params: null } } } },
      ] } },
    });
    expect(moods[0].title).toBe("Chill");
  });

  it("parses charts pages", () => {
    const charts = parseChartsPage(homeResponse);
    expect(charts.shelves.length).toBe(2);
    expect(charts.continuation).toBe("TOKEN_ABC");
  });

  it("parses player responses and prefers the best direct audio stream", () => {
    const result = parsePlayerResponse(playerResponse, VIDEO_ID);
    expect(result.status).toBe("OK");
    expect(result.title).toBe("Never Gonna Give You Up");
    expect(result.durationSeconds).toBe(212);
    expect(result.hasDirectStream).toBe(true);
    expect(result.requiresDeciphering).toBe(false);
    // audio only, best bitrate first: opus 251 (137000) over mp4 140 (129812); the video format is excluded
    expect(result.audioFormats.map(f => f.itag)).toEqual([251, 140]);
    expect(result.audioFormats.every(f => f.url !== null)).toBe(true);
  });

  it("flags ciphered-only player responses as requiring deciphering (never deciphered)", () => {
    const result = parsePlayerResponse(cipheredOnlyPlayerResponse, VIDEO_ID);
    expect(result.hasDirectStream).toBe(false);
    expect(result.requiresDeciphering).toBe(true);
    expect(result.audioFormats[0].url).toBeNull();
    expect(result.audioFormats[0].signatureCipher).toContain("s=abc");
  });

  it("extracts continuation tokens", () => {
    expect(continuationToken({ continuations: [continuation()] })).toBe("TOKEN_ABC");
    expect(continuationToken({})).toBeNull();
  });
});

describe("YouTubeMusicProvider", () => {
  function providerWith(handler: (req: CapturedRequest) => { status?: number; body: string }) {
    const { fetchImpl, calls } = stubFetch(handler);
    const provider = new YouTubeMusicProvider({
      session: { visitorData: "Cgt_test", cookie: null, gl: "US", hl: "en" },
      fetchImpl,
      now: () => 1_000_000,
    });
    return { provider, calls };
  }

  it("home() browses FEmusic_home and parses sections", async () => {
    const { provider, calls } = providerWith(jsonResponder(homeResponse));
    const home = await provider.home();
    expect(calls[0].url).toContain("/youtubei/v1/browse");
    expect(JSON.parse(calls[0].body!).browseId).toBe(YTM_BROWSE_IDS.home);
    expect(home.sections.length).toBe(2);
  });

  it("caches pages: a second identical call does not refetch", async () => {
    const { provider, calls } = providerWith(jsonResponder(homeResponse));
    await provider.home();
    await provider.home();
    expect(calls).toHaveLength(1);
  });

  it("deduplicates concurrent identical calls into one request", async () => {
    const { provider, calls } = providerWith(jsonResponder(searchResponse));
    const [a, b] = await Promise.all([provider.search("rick"), provider.search("rick")]);
    expect(calls).toHaveLength(1);
    expect(a.items.length).toBe(b.items.length);
  });

  it("search() applies the songs filter param; continuations reuse the token", async () => {
    const { provider, calls } = providerWith(jsonResponder(searchResponse));
    await provider.search("rick astley", "songs");
    expect(JSON.parse(calls[0].body!).params).toBe(YTM_FILTER_PARAMS.songs);
    await provider.search("rick astley", "songs", "TOKEN_ABC");
    expect(calls[1].url).toContain("continuation=TOKEN_ABC");
  });

  it("playlist() browses VL<id>; album() and artist() browse their ids", async () => {
    const { provider, calls } = providerWith(req => ({
      body: JSON.stringify(req.body!.includes("VLPL123") ? playlistPageResponse : req.body!.includes("MPREb_foo") ? albumPageResponse : artistPageResponse),
    }));
    const playlist = await provider.playlist("PL123");
    expect(JSON.parse(calls[0].body!).browseId).toBe("VLPL123");
    expect(playlist.id).toBe("PL123");
    const album = await provider.album("MPREb_foo");
    expect(album.tracks.length).toBe(2);
    const artist = await provider.artist("UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(artist.name).toBe("Rick Astley");
  });

  it("lyrics() follows next → lyrics browse endpoint", async () => {
    const { provider, calls } = providerWith(req =>
      req.url.includes("/next") ? { body: JSON.stringify(nextResponse) } : { body: JSON.stringify(lyricsResponse) }
    );
    const text = await provider.lyrics(VIDEO_ID);
    expect(calls.map(c => c.url)).toEqual([
      expect.stringContaining("/youtubei/v1/next"),
      expect.stringContaining("/youtubei/v1/browse"),
    ]);
    expect(JSON.parse(calls[1].body!).browseId).toBe("LYRICS_BROWSE_ID");
    expect(JSON.parse(calls[1].body!).params).toBe("lyrics_params");
    expect(text).toContain("Never gonna give you up");
  });

  it("resolveStream() returns the best direct audio format", async () => {
    const { provider } = providerWith(jsonResponder(playerResponse));
    const stream = await provider.resolveStream(VIDEO_ID);
    expect(stream.itag).toBe(251);
    expect(stream.url).toContain("googlevideo.com");
  });

  it("resolveStream() refuses ciphered-only responses with a policy error", async () => {
    const { provider } = providerWith(jsonResponder(cipheredOnlyPlayerResponse));
    await expect(provider.resolveStream(VIDEO_ID)).rejects.toMatchObject({ kind: "blocked" });
    await expect(provider.resolveStream(VIDEO_ID)).rejects.toBeInstanceOf(YtmProviderError);
  });

  it("resolveStream() surfaces LOGIN_REQUIRED as blocked", async () => {
    const { provider } = providerWith(jsonResponder({
      playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" },
      videoDetails: { videoId: VIDEO_ID },
      streamingData: { adaptiveFormats: [] },
    }));
    await expect(provider.resolveStream(VIDEO_ID)).rejects.toMatchObject({ kind: "blocked" });
  });

  it("surfaces provider errors with friendly messages", async () => {
    const { provider } = providerWith(() => ({ status: 500, body: "boom" }));
    await expect(provider.home()).rejects.toMatchObject({ kind: "http", status: 500 });
  });
});
