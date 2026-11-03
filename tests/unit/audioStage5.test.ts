import { describe, expect, it } from "vitest";
import { replayGainFromNativeTags } from "../../src/main/library/metadataCore";
import { parseSettingsJson } from "../../src/main/settingsCore";
import {
  createEqualizerChain,
  EQ_BAND_FREQUENCIES,
  EQ_PRESETS,
  matchingEqualizerPresetId,
  normalizeEqBandsDb,
} from "../../src/renderer/audio/equalizer";
import {
  computeReplayGain,
  dbToLinear,
  type ReplayGainSettings,
  type ReplayGainTrackFields,
} from "../../src/renderer/audio/replayGain";
import {
  decideTransition,
  effectiveCrossfadeSeconds,
  TransitionGuard,
  type TransitionProbe,
} from "../../src/renderer/player/transitions";

const rgSettings = (overrides: Partial<ReplayGainSettings> = {}): ReplayGainSettings => ({
  replayGainMode: "track",
  replayGainPreampDb: 0,
  replayGainPreventClipping: true,
  ...overrides,
});

const rgTrack = (overrides: Partial<ReplayGainTrackFields> = {}): ReplayGainTrackFields => ({
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  replayGainTrackPeak: null,
  replayGainAlbumPeak: null,
  ...overrides,
});

describe("ReplayGain native tag parsing", () => {
  it("reads Vorbis-comment keys with dB suffixes", () => {
    expect(
      replayGainFromNativeTags({
        vorbis: [
          { id: "REPLAYGAIN_TRACK_GAIN", value: "-6.00 dB" },
          { id: "ReplayGain_Album_Gain", value: "-5.00" },
          { id: "REPLAYGAIN_TRACK_PEAK", value: "0.900000" },
        ],
      })
    ).toEqual({ trackDb: -6, albumDb: -5, trackPeak: 0.9, albumPeak: null });
  });

  it("reads ID3v2 TXXX descriptions and MP4 freeform suffixes", () => {
    expect(
      replayGainFromNativeTags({
        "ID3v2.3": [
          { id: "TXXX", value: { description: "REPLAYGAIN_TRACK_GAIN", text: "-6.00 dB" } },
          { id: "TXXX", value: { description: "REPLAYGAIN_TRACK_PEAK", text: "0.9" } },
        ],
        "MP4": [
          { id: "----:com.apple.iTunes:REPLAYGAIN_ALBUM_GAIN", value: { text: "-5.00 dB" } },
          { id: "----:com.apple.iTunes:REPLAYGAIN_ALBUM_PEAK", value: new TextEncoder().encode("0.95") },
        ],
      })
    ).toEqual({ trackDb: -6, albumDb: -5, trackPeak: 0.9, albumPeak: 0.95 });
  });

  it("ignores malformed buckets and values", () => {
    expect(
      replayGainFromNativeTags({
        nope: "not-tags",
        vorbis: [null, { id: 42, value: "-1" }, { id: "REPLAYGAIN_TRACK_GAIN", value: "loud" }],
      })
    ).toEqual({ trackDb: null, albumDb: null, trackPeak: null, albumPeak: null });
    expect(replayGainFromNativeTags(null)).toEqual({
      trackDb: null,
      albumDb: null,
      trackPeak: null,
      albumPeak: null,
    });
  });
});

describe("ReplayGain gain computation", () => {
  it("converts decibels and applies track gain", () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.501187, 6);
    const result = computeReplayGain(rgTrack({ replayGainTrackDb: -6 }), rgSettings());
    expect(result.linear).toBeCloseTo(0.501187, 6);
    expect(result.source).toBe("track");
  });

  it("is transparent when disabled or untagged, and falls back across gain families", () => {
    expect(computeReplayGain(rgTrack({ replayGainTrackDb: -6 }), rgSettings({ replayGainMode: "off" })).linear).toBe(1);
    expect(computeReplayGain(rgTrack(), rgSettings()).linear).toBe(1);
    const albumFallback = computeReplayGain(
      rgTrack({ replayGainAlbumDb: -5 }),
      rgSettings({ replayGainMode: "track" })
    );
    expect(albumFallback.source).toBe("album");
    expect(albumFallback.linear).toBeCloseTo(dbToLinear(-5), 8);
  });

  it("applies preamp and peak limiting only when requested", () => {
    const track = rgTrack({ replayGainTrackDb: 6, replayGainTrackPeak: 0.9 });
    const limited = computeReplayGain(track, rgSettings({ replayGainPreampDb: 6 }));
    expect(limited.appliedDb).toBe(12);
    expect(limited.linear).toBeCloseTo(1 / 0.9, 8);
    expect(limited.limitedByPeak).toBe(true);

    const unlimited = computeReplayGain(
      track,
      rgSettings({ replayGainPreampDb: 6, replayGainPreventClipping: false })
    );
    expect(unlimited.linear).toBeCloseTo(dbToLinear(12), 8);
    expect(unlimited.limitedByPeak).toBe(false);
  });

  it("bounds nonsensical tags", () => {
    expect(computeReplayGain(rgTrack({ replayGainTrackDb: 1000 }), rgSettings()).linear).toBe(4);
    expect(computeReplayGain(rgTrack({ replayGainTrackDb: -1000 }), rgSettings()).linear).toBeCloseTo(
      dbToLinear(-24),
      10
    );
  });
});

class FakeAudioParam {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
  }
}

class FakeNode {
  readonly connections: unknown[] = [];
  connect(node: unknown) {
    this.connections.push(node);
    return node;
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeNode {
  type = "peaking";
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
  readonly gain = new FakeAudioParam();
}

function fakeAudioContext(): BaseAudioContext {
  return {
    currentTime: 0,
    createGain: () => new FakeGainNode(),
    createBiquadFilter: () => new FakeBiquadFilterNode(),
  } as unknown as BaseAudioContext;
}

describe("equalizer model and chain", () => {
  it("normalizes bands and recognizes presets", () => {
    expect(normalizeEqBandsDb([99, -99, Number.NaN])).toEqual([12, -12, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(EQ_PRESETS.every(preset => preset.bandsDb.length === EQ_BAND_FREQUENCIES.length)).toBe(true);
    expect(matchingEqualizerPresetId(EQ_PRESETS.find(preset => preset.id === "bass")!.bandsDb)).toBe("bass");
    expect(matchingEqualizerPresetId([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe("custom");
  });

  it("builds a ten-band chain and applies/disables settings", () => {
    const chain = createEqualizerChain(fakeAudioContext());
    const bandsDb = [6, 5, 4, 2, 0, 0, 0, 0, 0, 0];
    chain.apply({ enabled: true, preampDb: 6, bandsDb, presetId: "bass" });
    expect(chain.bands).toHaveLength(10);
    expect(chain.describe()).toMatchObject({
      frequencies: [...EQ_BAND_FREQUENCIES],
      bandGainsDb: bandsDb,
      types: ["lowshelf", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "peaking", "highshelf"],
    });
    expect(chain.describe().preampLinear).toBeCloseTo(dbToLinear(6), 8);

    chain.apply({ enabled: false, preampDb: 6, bandsDb, presetId: "bass" });
    expect(chain.describe().bandGainsDb).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(chain.describe().preampLinear).toBe(1);
  });
});

const probe = (overrides: Partial<TransitionProbe> = {}): TransitionProbe => ({
  isPlaying: true,
  position: 176,
  duration: 180,
  crossfadeSeconds: 0,
  gaplessPlayback: false,
  repeat: "off",
  hasNext: true,
  ...overrides,
});

describe("gapless/crossfade scheduling", () => {
  it("keeps the legacy ended path when both features are off", () => {
    expect(decideTransition(probe({ position: 179.9 }))).toEqual({ kind: "none" });
  });

  it("crossfades in the effective window and clamps fades for short tracks", () => {
    expect(decideTransition(probe({ crossfadeSeconds: 5 }))).toEqual({
      kind: "crossfade",
      fadeSeconds: 5,
    });
    expect(effectiveCrossfadeSeconds(6, 12)).toBe(3);
    expect(
      decideTransition(probe({ duration: 6, position: 3.1, crossfadeSeconds: 12 }))
    ).toEqual({ kind: "crossfade", fadeSeconds: 3 });
  });

  it("uses a late gapless cut and a gapless repeat-one loop", () => {
    expect(decideTransition(probe({ position: 179.8, gaplessPlayback: true }))).toEqual({
      kind: "gapless-cut",
    });
    expect(
      decideTransition(probe({ position: 179.8, gaplessPlayback: true, repeat: "one", hasNext: false }))
    ).toEqual({ kind: "repeat-one-loop" });
  });

  it("never schedules before one second, while paused, or without a successor", () => {
    expect(decideTransition(probe({ position: 0.5, duration: 6, crossfadeSeconds: 12 }))).toEqual({ kind: "none" });
    expect(decideTransition(probe({ isPlaying: false, crossfadeSeconds: 5 }))).toEqual({ kind: "none" });
    expect(decideTransition(probe({ hasNext: false, crossfadeSeconds: 5 }))).toEqual({ kind: "none" });
  });

  it("guards an armed transition until playback returns near zero or is reset", () => {
    const guard = new TransitionGuard();
    expect(guard.tryArm("0:42")).toBe(true);
    expect(guard.tryArm("0:42")).toBe(false);
    guard.observe(0.2);
    expect(guard.tryArm("0:42")).toBe(true);
    guard.reset();
    expect(guard.tryArm("0:42")).toBe(true);
  });
});

describe("audio settings normalization", () => {
  it("fills Stage 5 defaults for an older settings file", () => {
    const settings = parseSettingsJson(JSON.stringify({ playback: { volume: 0.5 } }));
    expect(settings.playback).toMatchObject({
      volume: 0.5,
      crossfadeSeconds: 0,
      gaplessPlayback: false,
      replayGainMode: "off",
      replayGainPreampDb: 0,
      replayGainPreventClipping: true,
      equalizer: { enabled: false, preampDb: 0, bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], presetId: "flat" },
    });
  });

  it("clamps invalid audio values without losing valid ones", () => {
    const settings = parseSettingsJson(
      JSON.stringify({
        playback: {
          crossfadeSeconds: 99,
          gaplessPlayback: true,
          replayGainMode: "loud",
          replayGainPreampDb: -99,
          equalizer: { enabled: true, preampDb: 99, bandsDb: [99, -99, "x"], presetId: " bass " },
        },
      })
    );
    expect(settings.playback.crossfadeSeconds).toBe(12);
    expect(settings.playback.gaplessPlayback).toBe(true);
    expect(settings.playback.replayGainMode).toBe("off");
    expect(settings.playback.replayGainPreampDb).toBe(-12);
    expect(settings.playback.equalizer).toEqual({
      enabled: true,
      preampDb: 12,
      bandsDb: [12, -12, 0, 0, 0, 0, 0, 0, 0, 0],
      presetId: "bass",
    });
  });
});
