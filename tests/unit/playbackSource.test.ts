import { describe, expect, it, vi } from "vitest";
import { resolvePlaybackSource } from "../../src/renderer/audio/playbackSource";

describe("resolvePlaybackSource", () => {
  it("uses the native bridge only for metadata-identified ALAC", async () => {
    const prepare = vi.fn(async (path: string) => `cadence-media://file/${encodeURIComponent(path)}.wav`);
    const alac = await resolvePlaybackSource(
      { path: "/music/album.m4a", streamUrl: "cadence-media://source/alac", codec: "Apple Lossless (ALAC)" },
      prepare
    );

    expect(prepare).toHaveBeenCalledWith("/music/album.m4a");
    expect(alac).toBe("cadence-media://file/%2Fmusic%2Falbum.m4a.wav");
  });

  it("does not infer ALAC from an M4A path or route AAC through the native bridge", async () => {
    const prepare = vi.fn(async () => "cadence-media://decoded.wav");
    const aac = await resolvePlaybackSource(
      { path: "/music/album.m4a", streamUrl: "cadence-media://source/aac", codec: "MPEG-4/AAC" },
      prepare
    );

    expect(aac).toBe("cadence-media://source/aac");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("shares one native decode between concurrent requests for the same file", async () => {
    let release: (url: string) => void = () => undefined;
    const prepare = vi.fn(
      () => new Promise<string>(resolve => {
        release = resolve;
      })
    );
    const track = { path: "/music/hires.m4a", streamUrl: "cadence-media://source/alac", codec: "ALAC" };

    // A double click, a queue change and a decode scan can all ask for the same file at once; the
    // bridge decodes the whole file per call and cannot join them, so the renderer must.
    const first = resolvePlaybackSource(track, prepare);
    const second = resolvePlaybackSource(track, prepare);
    const third = resolvePlaybackSource(track, prepare);
    expect(prepare).toHaveBeenCalledTimes(1);

    release("cadence-media://file/hires.wav");
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "cadence-media://file/hires.wav",
      "cadence-media://file/hires.wav",
      "cadence-media://file/hires.wav",
    ]);

    // Once the decode has settled, a later request is a fresh call (the bridge decides whether its
    // cache still matches the file).
    prepare.mockResolvedValueOnce("cadence-media://file/hires-2.wav");
    await resolvePlaybackSource(track, prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("keeps files and rejected decodes independent", async () => {
    const prepare = vi.fn(async (path: string) => {
      if (path.includes("broken")) throw new Error("decode failed");
      return `cadence-media://file/${path.split("/").pop()}.wav`;
    });
    const a = { path: "/music/a.m4a", streamUrl: "cadence-media://source/a", codec: "ALAC" };
    const b = { path: "/music/b.m4a", streamUrl: "cadence-media://source/b", codec: "ALAC" };
    const broken = { path: "/music/broken.m4a", streamUrl: "cadence-media://source/x", codec: "ALAC" };

    await expect(Promise.all([resolvePlaybackSource(a, prepare), resolvePlaybackSource(b, prepare)])).resolves.toEqual([
      "cadence-media://file/a.m4a.wav",
      "cadence-media://file/b.m4a.wav",
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);

    // A failed decode must not poison the next attempt for that file.
    await expect(resolvePlaybackSource(broken, prepare)).rejects.toThrow(/decode failed/);
    await expect(resolvePlaybackSource(broken, prepare)).rejects.toThrow(/decode failed/);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("reports missing ALAC preparation prerequisites instead of silently using Chromium", async () => {
    await expect(
      resolvePlaybackSource({ streamUrl: "cadence-media://source/alac", codec: "ALAC" }, vi.fn())
    ).rejects.toThrow(/no source path/i);
    await expect(
      resolvePlaybackSource({ path: "/music/album.m4a", streamUrl: "cadence-media://source/alac", codec: "ALAC" }, undefined)
    ).rejects.toThrow(/native ALAC decoder is not available/i);
  });
});
