/**
 * Tests for YouTube link parsing, manual-search metadata merging and the keyless main-process
 * YouTube metadata lookup. Every network response is mocked — no test reaches youtube.com.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDurationSeconds,
  normalizeYouTubeArtist,
  parseYouTubeVideoId,
  resolveSearchFields,
  type ManualSearchInput,
  type ResolvedYouTubeMetadata,
} from "../../src/shared/youtube";
import { fetchYouTubeMetadata } from "../../src/main/lyrics/youtube";

const VIDEO_ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId", () => {
  const valid: [string, string][] = [
    [`https://www.youtube.com/watch?v=${VIDEO_ID}`, VIDEO_ID],
    [`https://youtube.com/watch?v=${VIDEO_ID}&list=RDabc&feature=shared`, VIDEO_ID],
    [`http://m.youtube.com/watch?v=${VIDEO_ID}`, VIDEO_ID],
    [`https://music.youtube.com/watch?v=${VIDEO_ID}`, VIDEO_ID],
    [`www.youtube.com/watch?v=${VIDEO_ID}`, VIDEO_ID],
    [`https://youtu.be/${VIDEO_ID}`, VIDEO_ID],
    [`https://youtu.be/${VIDEO_ID}?si=abc123`, VIDEO_ID],
    [`https://www.youtu.be/${VIDEO_ID}`, VIDEO_ID],
    [`https://www.youtube.com/shorts/${VIDEO_ID}`, VIDEO_ID],
    [`https://youtube.com/shorts/${VIDEO_ID}/`, VIDEO_ID],
    [`https://www.youtube.com/embed/${VIDEO_ID}`, VIDEO_ID],
    [`https://www.youtube.com/live/${VIDEO_ID}?feature=share`, VIDEO_ID],
    [`https://www.youtube.com/v/${VIDEO_ID}`, VIDEO_ID],
    [`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`, VIDEO_ID],
  ];

  for (const [url, expected] of valid) {
    it(`accepts ${url}`, () => {
      expect(parseYouTubeVideoId(url)).toBe(expected);
    });
  }

  const invalid = [
    "",
    "   ",
    "not a url",
    "https://vimeo.com/123456789",
    "https://www.youtube.com/feed/library",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ-extra",
    "https://youtu.be/short",
    "https://evil-site.example/youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/short",
  ];

  for (const url of invalid) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(parseYouTubeVideoId(url)).toBeNull();
    });
  }
});

describe("normalizeYouTubeArtist", () => {
  it("strips the YouTube Music ' - Topic' channel suffix", () => {
    expect(normalizeYouTubeArtist("Daft Punk - Topic")).toBe("Daft Punk");
    expect(normalizeYouTubeArtist("Daft Punk - topic")).toBe("Daft Punk");
  });

  it("leaves ordinary channel names untouched", () => {
    expect(normalizeYouTubeArtist("Daft Punk Official")).toBe("Daft Punk Official");
  });

  it("maps empty or missing input to null", () => {
    expect(normalizeYouTubeArtist("")).toBeNull();
    expect(normalizeYouTubeArtist("   ")).toBeNull();
    expect(normalizeYouTubeArtist(null)).toBeNull();
    expect(normalizeYouTubeArtist(undefined)).toBeNull();
  });
});

describe("resolveSearchFields", () => {
  const input = (overrides: Partial<ManualSearchInput> = {}): ManualSearchInput => ({
    title: "Typed Title",
    artist: "Typed Artist",
    album: "Typed Album",
    youtubeUrl: "",
    ...overrides,
  });

  const youtube: ResolvedYouTubeMetadata = {
    videoId: VIDEO_ID,
    title: "Video Title",
    artist: "Video Artist",
    durationSeconds: 211,
    thumbnailUrl: null,
  };

  it("lets explicit user values win over YouTube metadata", () => {
    const result = resolveSearchFields(input(), youtube, 200);
    expect(result).toMatchObject({ title: "Typed Title", artist: "Typed Artist", album: "Typed Album", duration: 200 });
    expect(result.sources).toEqual({ title: "user", artist: "user", album: "user", duration: "track" });
  });

  it("fills only blank fields from YouTube without overwriting anything", () => {
    const result = resolveSearchFields(input({ title: "", artist: "", album: "" }), youtube, null);
    expect(result.title).toBe("Video Title");
    expect(result.artist).toBe("Video Artist");
    expect(result.album).toBe("");
    expect(result.duration).toBe(211);
    expect(result.sources).toEqual({ title: "youtube", artist: "youtube", album: null, duration: "youtube" });
  });

  it("prefers the playing track's duration over the video duration", () => {
    const result = resolveSearchFields(input({ title: "", artist: "" }), youtube, 180);
    expect(result.duration).toBe(180);
    expect(result.sources.duration).toBe("track");
  });

  it("supports a title-only search with no other metadata", () => {
    const result = resolveSearchFields(input({ artist: "", album: "" }), null, null);
    expect(result).toMatchObject({ title: "Typed Title", artist: "", album: "", duration: null });
    expect(result.sources).toEqual({ title: "user", artist: null, album: null, duration: null });
  });

  it("uses the YouTube title when the user left every field blank but pasted a link", () => {
    const result = resolveSearchFields(input({ title: "", artist: "", album: "" }), youtube, null);
    expect(result.title).toBe("Video Title");
    expect(result.sources.title).toBe("youtube");
  });

  it("trims whitespace from typed values", () => {
    const result = resolveSearchFields(input({ title: "  Spaced  ", artist: " ", album: "  " }), null, 0);
    expect(result.title).toBe("Spaced");
    expect(result.artist).toBe("");
    expect(result.album).toBe("");
    expect(result.duration).toBeNull();
  });
});

describe("formatDurationSeconds", () => {
  it("formats minutes and seconds, and hours when needed", () => {
    expect(formatDurationSeconds(211)).toBe("3:31");
    expect(formatDurationSeconds(5)).toBe("0:05");
    expect(formatDurationSeconds(3725)).toBe("1:02:05");
  });

  it("returns an empty string for missing or invalid durations", () => {
    expect(formatDurationSeconds(null)).toBe("");
    expect(formatDurationSeconds(0)).toBe("");
    expect(formatDurationSeconds(Number.NaN)).toBe("");
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchYouTubeMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an invalid link without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeMetadata("https://vimeo.com/123");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves title and normalized artist from keyless oEmbed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("youtube.com/oembed");
      expect(url).toContain("format=json");
      expect(decodeURIComponent(url)).toContain(`watch?v=${VIDEO_ID}`);
      return json({
        title: "Around the World (Official Video)",
        author_name: "Daft Punk - Topic",
        thumbnail_url: "https://img.example/thumb.jpg",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata).toEqual({
        videoId: VIDEO_ID,
        title: "Around the World (Official Video)",
        artist: "Daft Punk",
        durationSeconds: null,
        thumbnailUrl: "https://img.example/thumb.jpg",
      });
    }
  });

  it("reads duration from the watch page while the video ID is never sent elsewhere", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      if (url.includes("/oembed")) {
        return json({ title: "Video Title", author_name: "Channel Name" });
      }
      expect(url).toContain(`/watch?v=${VIDEO_ID}`);
      return new Response(
        `<html><body>{"videoDetails":{"videoId":"${VIDEO_ID}","lengthSeconds":"211"}}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYouTubeMetadata(`https://www.youtube.com/watch?v=${VIDEO_ID}`);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata.durationSeconds).toBe(211);
    // Exactly one oEmbed call and one watch-page call, both keyed on the same extracted ID.
    expect(seenUrls.filter(url => url.includes("/oembed"))).toHaveLength(1);
    expect(seenUrls.filter(url => url.includes("/watch"))).toHaveLength(1);
  });

  it("keeps oEmbed metadata when the watch-page lookup fails or lacks a duration", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oembed")) return json({ title: "Video Title", author_name: "Channel" });
      if (url.includes("no-duration")) return new Response("<html>ok</html>", { status: 200 });
      return new Response("boom", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const failedWatch = await fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`);
    expect(failedWatch.ok).toBe(true);
    if (failedWatch.ok) expect(failedWatch.metadata.durationSeconds).toBeNull();

    const noDuration = await fetchYouTubeMetadata(`https://youtu.be/no-duration`);
    expect(noDuration.ok).toBe(true);
    if (noDuration.ok) expect(noDuration.metadata.durationSeconds).toBeNull();
  });

  it("maps private/unavailable videos and rate limits to typed failures", async () => {
    const cases: [number, "unavailable" | "error"][] = [
      [401, "unavailable"],
      [403, "unavailable"],
      [404, "unavailable"],
      [429, "error"],
      [500, "error"],
    ];
    for (const [status, reason] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));
      const result = await fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
      vi.unstubAllGlobals();
    }
  });

  it("reports an error for malformed JSON or a payload without a title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const malformed = await fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe("error");

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => json({ author_name: "No title here" })));
    const empty = await fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("error");
  });

  it("propagates an abort so a stale lookup cannot resolve", async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", hanging);
    const controller = new AbortController();
    const pending = fetchYouTubeMetadata(`https://youtu.be/${VIDEO_ID}`, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "LyricsHttpError", kind: "aborted" });
  });
});
