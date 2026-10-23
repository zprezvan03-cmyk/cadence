import { describe, expect, it, vi } from "vitest";
import {
  codecSupport,
  explainPlaybackFailure,
  extensionSupported,
  isDecoderOrDemuxerMessage,
  probeMediaAccessStatus,
} from "../../src/renderer/audio/codecs";

describe("codecSupport & extensionSupported", () => {
  it("keeps ALAC marked unsupported while allowing standard Chromium codecs", () => {
    expect(codecSupport({ codec: "ALAC", path: "C:\\Music\\song.m4a" })).toBe("unsupported");
    expect(codecSupport({ codec: "Apple Lossless (ALAC)" })).toBe("unsupported");
    expect(codecSupport({ codec: "FLAC" })).toBe("supported");
    expect(codecSupport({ codec: "MPEG 1 Layer 3" })).toBe("supported");
    expect(codecSupport({ codec: "MPEG-4/AAC" })).toBe("supported");
    expect(codecSupport({ codec: "Opus" })).toBe("supported");
    expect(codecSupport({ codec: "" })).toBe("unknown");
  });

  it("handles Windows paths with dots in parent folder names", () => {
    expect(extensionSupported("C:\\Users\\alice.smith\\Music\\song.flac")).toBe(true);
    expect(extensionSupported("C:\\Users\\alice.smith\\Music\\song.wma")).toBe(false);
    expect(extensionSupported("C:\\Users\\alice.smith\\Music\\extensionless")).toBe(true);
  });
});

describe("file-access vs unsupported-codec playback failure separation", () => {
  it("reports HTTP 403 allowlist rejections as blocked file access, never as codec or corrupt-file errors", () => {
    const flac403 = explainPlaybackFailure(
      4,
      { codec: "FLAC", path: "C:\\Users\\Alice\\Music\\song.flac" },
      { httpStatus: 403, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(flac403).toMatch(/outside your configured music folders|blocked/i);
    expect(flac403).not.toMatch(/corrupt|decod/i);

    const alac403 = explainPlaybackFailure(
      4,
      { codec: "ALAC", path: "C:\\Users\\Alice\\Music\\song.m4a" },
      { httpStatus: 403, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(alac403).toBe(flac403);
    expect(alac403).not.toMatch(/ALAC is not decodable/);
  });

  it("reports HTTP 404 and network failures as unreadable disk files, separate from codec errors", () => {
    const flac404 = explainPlaybackFailure(
      4,
      { codec: "FLAC" },
      { httpStatus: 404, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(flac404).toMatch(/could not be read from disk/i);

    const alac404 = explainPlaybackFailure(
      4,
      { codec: "ALAC" },
      { httpStatus: 404, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(alac404).toBe(flac404);

    const unconfirmedFormatErr = explainPlaybackFailure(
      4,
      { codec: "MP3" },
      { httpStatus: null, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(unconfirmedFormatErr).toMatch(/could not be read from disk/i);
  });

  it("reports reachable ALAC files as unsupported codec and reachable broken files as corrupt", () => {
    const alacMsg = "PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams";
    expect(isDecoderOrDemuxerMessage(alacMsg)).toBe(true);
    expect(isDecoderOrDemuxerMessage("MEDIA_ELEMENT_ERROR: Format error")).toBe(false);

    const alacDecode = explainPlaybackFailure(
      4,
      { codec: "ALAC" },
      { httpStatus: 206, mediaMessage: alacMsg }
    );
    expect(alacDecode).toMatch(/ALAC is not decodable.*FLAC/s);

    const brokenFlac = explainPlaybackFailure(
      4,
      { codec: "FLAC" },
      {
        httpStatus: 206,
        mediaMessage: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
      }
    );
    expect(brokenFlac).toMatch(/could not be decoded.*corrupt/i);
  });

  it("probes stream HTTP status via byte-range GET and cancels the body", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchOk = vi.fn(async () => ({
      status: 403,
      body: { cancel },
    })) as unknown as typeof fetch;

    expect(await probeMediaAccessStatus("cadence-media://file/abc", fetchOk)).toBe(403);
    expect(cancel).toHaveBeenCalledTimes(1);

    const fetchFail = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await probeMediaAccessStatus("cadence-media://file/abc", fetchFail)).toBe("network-error");
  });
});
