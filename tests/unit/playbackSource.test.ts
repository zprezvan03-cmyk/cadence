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

  it("reports missing ALAC preparation prerequisites instead of silently using Chromium", async () => {
    await expect(
      resolvePlaybackSource({ streamUrl: "cadence-media://source/alac", codec: "ALAC" }, vi.fn())
    ).rejects.toThrow(/no source path/i);
    await expect(
      resolvePlaybackSource({ path: "/music/album.m4a", streamUrl: "cadence-media://source/alac", codec: "ALAC" }, undefined)
    ).rejects.toThrow(/native ALAC decoder is not available/i);
  });
});
