import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDecodeExportText,
  classifyDecodeFailure,
  decodeSamplePoints,
  dedupePaths,
  fileNameFromPath,
  problemFromTrack,
  runDecodeScan,
  type DecodeProbeResult,
  type DecodeProbeTrack,
} from "../../src/renderer/audio/decodeProbe";
import { useDecodeTester, visibleDecodeProblems } from "../../src/renderer/state/decodeTesterStore";
import { hashToRoute, routeToHash } from "../../src/renderer/state/uiStore";
import type { DecodeProblem } from "../../src/shared/types";

const track = (path: string, codec = "FLAC"): DecodeProbeTrack => ({
  id: Math.abs([...path].reduce((sum, char) => sum + char.charCodeAt(0), 0)),
  path,
  streamUrl: `cadence-media://file/${encodeURIComponent(path)}`,
  codec,
  duration: 10,
});

describe("classifyDecodeFailure — access, unsupported and corruption stay apart", () => {
  it("reports HTTP 404/403 as inaccessible even for an unsupported codec", () => {
    const missing = classifyDecodeFailure(
      { codec: "ALAC", path: "C:\\Music\\song.m4a" },
      { code: 4, httpStatus: 404, mediaMessage: "MEDIA_ELEMENT_ERROR: Format error" }
    );
    expect(missing.kind).toBe("inaccessible");
    expect(missing.message).toMatch(/could not be read from disk/i);

    const blocked = classifyDecodeFailure(
      { codec: "FLAC", path: "C:\\Music\\song.flac" },
      { code: 4, httpStatus: 403 }
    );
    expect(blocked.kind).toBe("inaccessible");
    expect(blocked.message).toMatch(/outside your configured music folders/i);

    const network = classifyDecodeFailure({ codec: "MP3" }, { code: 2, httpStatus: null });
    expect(network.kind).toBe("inaccessible");
  });

  it("reports ALAC-style demuxer rejections as unsupported codec, never corruption", () => {
    const alac = classifyDecodeFailure(
      { codec: "ALAC", path: "C:\\Music\\song.m4a" },
      {
        code: 4,
        httpStatus: 206,
        mediaMessage: "PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams",
      }
    );
    expect(alac.kind).toBe("unsupported-codec");
    expect(alac.message).toMatch(/ALAC is not decodable.*FLAC/s);

    const unknownCodec = classifyDecodeFailure(
      { codec: "", path: "/music/song.xyz" },
      { code: 4, httpStatus: 200, mediaMessage: "DEMUXER_ERROR_NO_SUPPORTED_STREAMS" }
    );
    expect(unknownCodec.kind).toBe("unsupported-codec");
    expect(unknownCodec.message).toMatch(/no supported audio stream/i);
  });

  it("reports a reachable broken file as a genuine decode error", () => {
    const broken = classifyDecodeFailure(
      { codec: "FLAC", path: "/music/broken.flac" },
      {
        code: 3,
        httpStatus: 206,
        mediaMessage: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
      }
    );
    expect(broken.kind).toBe("decode-error");
    expect(broken.message).toMatch(/could not be decoded.*corrupt/i);
  });

  it("reports late-stream failures as truncated and plain stalls as timeouts", () => {
    const premature = classifyDecodeFailure(
      { codec: "FLAC" },
      { prematureEnd: true, atSeconds: 95, durationSeconds: 200 }
    );
    expect(premature.kind).toBe("truncated");
    expect(premature.message).toContain("1:35");
    expect(premature.message).toContain("3:20");

    const lateSeek = classifyDecodeFailure(
      { codec: "MP3" },
      { code: 3, httpStatus: 206, decodedEarlierSamples: true, atSeconds: 184, durationSeconds: 200 }
    );
    expect(lateSeek.kind).toBe("truncated");

    const stalled = classifyDecodeFailure({ codec: "FLAC" }, { timedOut: true, httpStatus: 206 });
    expect(stalled.kind).toBe("timeout");
  });

  it("reports a decoder that skips over a corrupt region as a decode error at that position", () => {
    const skipped = classifyDecodeFailure(
      { codec: "FLAC" },
      { skippedAhead: true, httpStatus: 206, atSeconds: 62, durationSeconds: 200, decodedEarlierSamples: true }
    );
    expect(skipped.kind).toBe("decode-error");
    expect(skipped.message).toMatch(/skipped over undecodable audio at 1:02 of 3:20/);

    // The same skip in the last fifth of the file reads as truncation instead.
    const skippedLate = classifyDecodeFailure(
      { codec: "FLAC" },
      { skippedAhead: true, httpStatus: 206, atSeconds: 190, durationSeconds: 200, decodedEarlierSamples: true }
    );
    expect(skippedLate.kind).toBe("truncated");
  });
});

describe("decode sample points and path helpers", () => {
  it("samples the beginning, middle and end without over-seeking short files", () => {
    expect(decodeSamplePoints(10)).toEqual([0, 2, 4, 6, 8, 9.3]);
    expect(decodeSamplePoints(6)).toEqual([0, 1.2, 2.4, 3.6, 4.8, 5.58]);
    expect(decodeSamplePoints(2)).toEqual([0, 0.8, 1.6]);
    expect(decodeSamplePoints(1)).toEqual([0, 0.8]);
    expect(decodeSamplePoints(0)).toEqual([0]);
    expect(decodeSamplePoints(Number.NaN)).toEqual([0]);
    expect(decodeSamplePoints(Number.POSITIVE_INFINITY)).toEqual([0]);
  });

  it("extracts file names from Windows, UNC and POSIX paths", () => {
    expect(fileNameFromPath("C:\\Users\\alice.smith\\Music\\song.flac")).toBe("song.flac");
    expect(fileNameFromPath("\\\\NAS\\share\\Music\\track.m4a")).toBe("track.m4a");
    expect(fileNameFromPath("/home/user/Music/track.opus")).toBe("track.opus");
    expect(fileNameFromPath("song.wav")).toBe("song.wav");
    expect(fileNameFromPath("D:\\Music\\Artist — Title (2024).flac")).toBe("Artist — Title (2024).flac");
  });

  it("builds the export text as unique paths, one per line", () => {
    expect(dedupePaths(["a", "", "b", "a"])).toEqual(["a", "b"]);
    expect(buildDecodeExportText(["C:\\Music\\a.flac", "C:\\Music\\b.flac", "C:\\Music\\a.flac"])).toBe(
      "C:\\Music\\a.flac\nC:\\Music\\b.flac\n"
    );
    expect(buildDecodeExportText([])).toBe("");
  });
});

describe("runDecodeScan orchestration", () => {
  it("collects failures without aborting, de-duplicates paths and reports progress", async () => {
    const probed: string[] = [];
    const progress: number[] = [];
    const probe = async (candidate: DecodeProbeTrack): Promise<DecodeProbeResult> => {
      probed.push(candidate.path);
      if (candidate.path.endsWith("broken.flac")) {
        return { ok: false, kind: "decode-error", message: "corrupt" };
      }
      if (candidate.path.endsWith("song.m4a")) {
        return { ok: false, kind: "unsupported-codec", message: "no decoder" };
      }
      if (candidate.path.endsWith("weird.wav")) {
        throw new Error("element exploded");
      }
      return { ok: true };
    };

    const outcome = await runDecodeScan(
      [
        track("C:\\Music\\ok.flac"),
        track("C:\\Music\\broken.flac"),
        track("C:\\Music\\song.m4a", "ALAC"),
        track("C:\\Music\\broken.flac"), // duplicate must not be probed or listed twice
        track("C:\\Music\\weird.wav", "WAV"),
      ],
      probe,
      { concurrency: 2, onProgress: p => progress.push(p.scanned) }
    );

    expect(outcome.total).toBe(4);
    expect(outcome.scanned).toBe(4);
    expect(outcome.canceled).toBe(false);
    expect(new Set(probed).size).toBe(4);
    expect(progress).toEqual([1, 2, 3, 4]);

    const kinds = new Map(outcome.problems.map(problem => [problem.fileName, problem.kind]));
    expect(outcome.problems).toHaveLength(3);
    expect(kinds.get("broken.flac")).toBe("decode-error");
    expect(kinds.get("song.m4a")).toBe("unsupported-codec");
    expect(kinds.get("weird.wav")).toBe("decode-error");
    expect(outcome.problems.find(p => p.fileName === "weird.wav")?.message).toMatch(/element exploded/);
    // Successful files are never reported.
    expect(outcome.problems.some(p => p.fileName === "ok.flac")).toBe(false);
  });

  it("stops between files when canceled and keeps partial results", async () => {
    const controller = new AbortController();
    let calls = 0;
    const probe = async (candidate: DecodeProbeTrack): Promise<DecodeProbeResult> => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        const error = new Error("canceled");
        error.name = "AbortError";
        throw error;
      }
      return candidate.path.includes("bad")
        ? { ok: false, kind: "truncated", message: "cut off" }
        : { ok: true };
    };

    const outcome = await runDecodeScan(
      [track("/m/bad-one.flac"), track("/m/two.flac"), track("/m/three.flac"), track("/m/four.flac")],
      probe,
      { concurrency: 1, signal: controller.signal }
    );

    expect(outcome.canceled).toBe(true);
    expect(outcome.scanned).toBe(1);
    expect(outcome.total).toBe(4);
    expect(outcome.problems.map(p => p.fileName)).toEqual(["bad-one.flac"]);
    expect(calls).toBe(2);
  });

  it("never exceeds the requested concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = async (): Promise<DecodeProbeResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    };
    const tracks = Array.from({ length: 8 }, (_, i) => track(`/m/${i}.flac`));
    const outcome = await runDecodeScan(tracks, probe, { concurrency: 2 });
    expect(outcome.scanned).toBe(8);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("maps a probe failure to a problem with the Windows file name", () => {
    const problem = problemFromTrack(track("C:\\Music\\Sub Folder\\broken.flac"), {
      kind: "decode-error",
      message: "nope",
    });
    expect(problem.fileName).toBe("broken.flac");
    expect(problem.path).toBe("C:\\Music\\Sub Folder\\broken.flac");
    expect(problem.codec).toBe("FLAC");
  });
});

describe("decode tester store — keep, remove, export", () => {
  const problems: DecodeProblem[] = [
    { trackId: 1, path: "C:\\Music\\a.flac", fileName: "a.flac", kind: "decode-error", message: "x", codec: "FLAC" },
    { trackId: 2, path: "C:\\Music\\b.m4a", fileName: "b.m4a", kind: "unsupported-codec", message: "y", codec: "ALAC" },
    { trackId: 3, path: "C:\\Music\\c.mp3", fileName: "c.mp3", kind: "inaccessible", message: "z", codec: "MP3" },
  ];

  beforeEach(() => {
    useDecodeTester.setState({
      status: "done",
      scanned: 3,
      total: 3,
      problems,
      keptPaths: [],
      selectedPaths: [],
      hideKept: false,
      error: null,
      actionMessage: null,
      deleteErrors: {},
      deleting: false,
      exporting: false,
    });
    (globalThis as { window?: unknown }).window = {
      cadence: {
        decodeTester: {
          deleteFiles: vi.fn(async (paths: string[]) =>
            paths.map(path => ({
              path,
              deleted: path !== "C:\\Music\\c.mp3",
              error: path === "C:\\Music\\c.mp3" ? "Permission denied" : null,
            }))
          ),
          exportFileList: vi.fn(async () => ({ canceled: false, path: "C:\\Users\\A\\list.txt" })),
        },
      },
    };
  });

  it("keeps kept files in results unless the explicit filter hides them", () => {
    useDecodeTester.getState().toggleKept("C:\\Music\\a.flac");
    const state = useDecodeTester.getState();
    expect(state.isKept("C:\\Music\\a.flac")).toBe(true);
    expect(state.problems).toHaveLength(3);
    expect(visibleDecodeProblems(state.problems, state.keptPaths, false)).toHaveLength(3);
    expect(visibleDecodeProblems(state.problems, state.keptPaths, true).map(p => p.fileName)).toEqual([
      "b.m4a",
      "c.mp3",
    ]);
    useDecodeTester.getState().toggleKept("C:\\Music\\a.flac");
    expect(useDecodeTester.getState().isKept("C:\\Music\\a.flac")).toBe(false);
  });

  it("removes only successfully deleted files and surfaces per-file failures", async () => {
    const state = useDecodeTester.getState();
    state.selectPaths(problems.map(p => p.path));
    state.toggleKept("C:\\Music\\a.flac");
    await useDecodeTester.getState().removeFiles(useDecodeTester.getState().selectedPaths);

    const next = useDecodeTester.getState();
    expect(next.problems.map(p => p.fileName)).toEqual(["c.mp3"]);
    expect(next.selectedPaths).toEqual(["C:\\Music\\c.mp3"]);
    expect(next.isKept("C:\\Music\\a.flac")).toBe(false);
    expect(next.deleteErrors["C:\\Music\\c.mp3"]).toBe("Permission denied");
    expect(next.actionMessage).toMatch(/Deleted 2 of 3/);
    expect(next.deleting).toBe(false);
  });

  it("exports every problematic path (kept included) and reports where it went", async () => {
    useDecodeTester.getState().toggleKept("C:\\Music\\b.m4a");
    await useDecodeTester.getState().exportFileList();
    const cadence = (globalThis as any).window.cadence;
    expect(cadence.decodeTester.exportFileList).toHaveBeenCalledWith([
      "C:\\Music\\a.flac",
      "C:\\Music\\b.m4a",
      "C:\\Music\\c.mp3",
    ]);
    expect(useDecodeTester.getState().actionMessage).toMatch(/Exported 3 problematic file paths to C:\\Users\\A\\list\.txt/);
  });
});

describe("decode tester routing", () => {
  it("round-trips the decode-tester hash route", () => {
    expect(hashToRoute("#/decode-tester")).toEqual({ name: "decode-tester" });
    expect(routeToHash({ name: "decode-tester" })).toBe("#/decode-tester");
  });
});
