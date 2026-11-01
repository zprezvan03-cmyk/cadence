import type { EqualizerSettings } from "../../shared/types";
import { dbToLinear } from "./replayGain";

export const EQ_BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_BAND_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"] as const;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export interface EqualizerPreset {
  id: string;
  label: string;
  bandsDb: readonly number[];
}

export const EQ_PRESETS: readonly EqualizerPreset[] = [
  { id: "flat", label: "Flat", bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", label: "Bass boost", bandsDb: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: "treble", label: "Treble boost", bandsDb: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: "vocal", label: "Vocal", bandsDb: [-2, -1, 0, 2, 4, 4, 3, 2, 0, -1] },
  { id: "rock", label: "Rock", bandsDb: [4, 3, 2, 0, -1, 0, 2, 3, 4, 4] },
  { id: "pop", label: "Pop", bandsDb: [-1, 1, 2, 3, 4, 3, 2, 1, 0, -1] },
  { id: "jazz", label: "Jazz", bandsDb: [3, 2, 1, 2, 1, 1, 0, 1, 2, 3] },
  { id: "classical", label: "Classical", bandsDb: [3, 2, 1, 0, 0, 0, -1, 1, 3, 4] },
  { id: "electronic", label: "Electronic", bandsDb: [5, 4, 3, 1, 0, 0, 1, 3, 4, 5] },
];

function clampDb(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, number)) : 0;
}

/** Always returns a fresh ten-band array, independent of what older settings files contain. */
export function normalizeEqBandsDb(values: readonly number[] | null | undefined): number[] {
  return EQ_BAND_FREQUENCIES.map((_, index) => clampDb(values?.[index] ?? 0));
}

export function equalizerPresetById(id: string | null | undefined): EqualizerPreset | null {
  return EQ_PRESETS.find(preset => preset.id === id) ?? null;
}

export function matchingEqualizerPresetId(bandsDb: readonly number[]): string {
  const normalized = normalizeEqBandsDb(bandsDb);
  return (
    EQ_PRESETS.find(preset => preset.bandsDb.every((value, index) => value === normalized[index]))?.id ??
    "custom"
  );
}

export interface EqualizerChain {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly preamp: GainNode;
  readonly bands: readonly BiquadFilterNode[];
  apply(settings: EqualizerSettings): void;
  describe(): {
    frequencies: number[];
    bandGainsDb: number[];
    preampLinear: number;
    types: string[];
  };
}

/**
 * Builds the shared ten-band chain inserted after the per-deck ReplayGain/fade gains and before
 * the analyser. Disabling leaves the nodes connected at unity/zero gain, which avoids graph
 * rewiring clicks while staying audibly transparent.
 */
export function createEqualizerChain(context: BaseAudioContext): EqualizerChain {
  const input = context.createGain();
  const preamp = context.createGain();
  const output = context.createGain();
  const bands = EQ_BAND_FREQUENCIES.map((frequency, index) => {
    const filter = context.createBiquadFilter();
    filter.type = index === 0 ? "lowshelf" : index === EQ_BAND_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
    filter.frequency.value = frequency;
    filter.Q.value = filter.type === "peaking" ? 1.1 : 0.9;
    filter.gain.value = 0;
    return filter;
  });

  input.connect(preamp);
  let previous: AudioNode = preamp;
  for (const band of bands) {
    previous.connect(band);
    previous = band;
  }
  previous.connect(output);

  return {
    input,
    output,
    preamp,
    bands,
    apply(settings) {
      const normalizedBands = normalizeEqBandsDb(settings.bandsDb);
      const preampDb = settings.enabled ? clampDb(settings.preampDb) : 0;
      const now = context.currentTime;
      preamp.gain.setTargetAtTime(dbToLinear(preampDb), now, 0.03);
      bands.forEach((band, index) => {
        band.gain.setTargetAtTime(settings.enabled ? normalizedBands[index] : 0, now, 0.03);
      });
    },
    describe() {
      return {
        frequencies: bands.map(band => band.frequency.value),
        bandGainsDb: bands.map(band => band.gain.value),
        preampLinear: preamp.gain.value,
        types: bands.map(band => band.type),
      };
    },
  };
}
