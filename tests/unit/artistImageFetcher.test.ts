/**
 * Binary image transport (`src/main/media/imageFetch.ts`).
 *
 * Regression cover for the bug that made artist pictures never appear in the desktop app: the shared
 * resolver downloaded pictures through the text-based Tauri transport, which decodes every body as
 * UTF-8. Images survived as a corrupted string, failed the magic-byte check and were discarded, so
 * every provider looked like it had no picture. These tests pin that the bytes reaching the
 * validator are the bytes the network returned — end to end, through the real service.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createArtistImageFetch,
  toByteArray,
  type ImageInvoke,
} from "../../src/main/media/imageFetch";
import { ArtistImageCacheCore } from "../../src/shared/artistImageCache";
import { ArtistImageService } from "../../src/shared/artistImageService";
import {
  createArtistImageProviderConfig,
  type ArtistImageProvider,
  type ArtistImageProviderResult,
} from "../../src/shared/artistImageProviders";

/** Minimal structurally valid PNG carrying the requested pixel size. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

class OneCandidateProvider implements ArtistImageProvider {
  readonly id = "deezer" as const;
  readonly name = "Stub";
  readonly requiresCredentials = false;

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
      statusReason: "test",
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async lookup(): Promise<ArtistImageProviderResult> {
    return {
      provider: this.id,
      status: "hit",
      candidate: {
        provider: this.id,
        imageUrl: "https://cdn.example.test/artist.png",
        matchedArtistName: "Sheila on 7",
        pageUrl: null,
        mbid: null,
        attribution: "Deezer",
        license: null,
        licenseUrl: null,
        author: null,
        width: 640,
        height: 640,
        confidence: 0.8,
      },
    };
  }
}

describe("toByteArray", () => {
  it("keeps an ArrayBuffer's bytes untouched", () => {
    const source = pngBytes(640, 640);
    const copy = toByteArray(source.buffer.slice(0));
    expect(Array.from(copy)).toEqual(Array.from(source));
    expect(Array.from(copy.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("respects the byte offset and length of a typed-array view", () => {
    const padded = new Uint8Array(12);
    padded.set([1, 2, 3, 4], 4);
    const view = padded.subarray(4, 8);
    expect(Array.from(toByteArray(view))).toEqual([1, 2, 3, 4]);
  });

  it("accepts a plain number array", () => {
    expect(Array.from(toByteArray([0xff, 0xd8, 0xff]))).toEqual([0xff, 0xd8, 0xff]);
  });

  it("rejects payloads that are not bytes at all", () => {
    expect(() => toByteArray({ body: "nope" })).toThrow(TypeError);
  });
});

describe("createArtistImageFetch", () => {
  it("downloads through the binary command and returns the bytes unchanged", async () => {
    const bytes = pngBytes(640, 640);
    const invoke = vi.fn<ImageInvoke>(async () => bytes.buffer);

    const fetchImage = createArtistImageFetch(invoke);
    const response = await fetchImage("https://cdn.example.test/artist.png");

    expect(response.ok).toBe(true);
    expect(Array.from(response.bytes)).toEqual(Array.from(bytes));
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = invoke.mock.calls[0];
    expect(command).toBe("cmd_http_fetch_image");
    expect(payload).toMatchObject({
      args: {
        url: "https://cdn.example.test/artist.png",
        headers: { Accept: "image/*" },
      },
    });
  });

  it("turns a non-2xx answer into a response instead of a failure", async () => {
    const invoke = vi.fn<ImageInvoke>(async () => {
      throw "HTTP:404";
    });
    const response = await createArtistImageFetch(invoke)("https://cdn.example.test/missing.png");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(response.bytes.length).toBe(0);
  });

  it("maps transport failures the same way the rest of the app does", async () => {
    const timeout = vi.fn<ImageInvoke>(async () => {
      throw "TIMEOUT";
    });
    await expect(createArtistImageFetch(timeout)("https://x.test/a.png")).rejects.toThrow(
      /timed out/i
    );

    const offline = vi.fn<ImageInvoke>(async () => {
      throw "NETWORK: dns error";
    });
    await expect(createArtistImageFetch(offline)("https://x.test/a.png")).rejects.toThrow(
      /dns error/
    );
  });

  it("does not start a request for an already-aborted signal", async () => {
    const invoke = vi.fn<ImageInvoke>(async () => new ArrayBuffer(0));
    const controller = new AbortController();
    controller.abort();
    await expect(
      createArtistImageFetch(invoke)("https://x.test/a.png", controller.signal)
    ).rejects.toThrow(/abort/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the bytes through the whole pipeline so a downloaded picture is stored intact", async () => {
    const bytes = pngBytes(640, 640);
    const invoke = vi.fn<ImageInvoke>(async () => bytes.buffer);
    const saved: { bytes: Uint8Array; mimeType: string; extension: string }[] = [];
    const service = new ArtistImageService({
      cache: new ArtistImageCacheCore({ persist: () => undefined }),
      providers: [new OneCandidateProvider()],
      config: createArtistImageProviderConfig({
        enabled: true,
        minProviderIntervalMs: { lastfm: 0, wikidata: 0, deezer: 0, musicbrainz: 0 },
      }),
      refreshStaleInBackground: false,
      fetchImage: createArtistImageFetch(invoke),
      saveImage: async (savedBytes, mimeType, extension) => {
        saved.push({ bytes: savedBytes, mimeType, extension });
        return `photo${extension}`;
      },
    });

    const result = await service.resolve({ name: "Sheila on 7" });

    expect(result.status).toBe("fetched");
    expect(result.record?.provider).toBe("deezer");
    expect(result.record?.width).toBe(640);
    expect(saved).toHaveLength(1);
    expect(saved[0].mimeType).toBe("image/png");
    expect(Array.from(saved[0].bytes)).toEqual(Array.from(bytes));
  });
});
