import { describe, expect, it } from "vitest";
import { BeatAnalyser } from "../../src/renderer/upstream/shaders/beatAnalysis";

function harness() {
  let nextFrame = 1;
  const requested: number[] = [];
  const cancelled: number[] = [];
  const analyser = new BeatAnalyser({
    getAnalyser: () => null,
    getVolume: () => 1,
    requestFrame: () => {
      const id = nextFrame++;
      requested.push(id);
      return id;
    },
    cancelFrame: id => cancelled.push(id),
  });
  return { analyser, requested, cancelled };
}

describe("BeatAnalyser background scheduling", () => {
  it("runs only while a shader is subscribed", () => {
    const { analyser, requested, cancelled } = harness();
    const listener = () => undefined;

    analyser.start();
    expect(requested).toEqual([]);

    const unsubscribe = analyser.subscribe(listener);
    expect(requested).toEqual([1]);

    unsubscribe();
    expect(cancelled).toEqual([1]);

    const resubscribe = analyser.subscribe(listener);
    expect(requested).toEqual([1, 2]);
    analyser.stop();
    expect(cancelled).toEqual([1, 2]);
    resubscribe();
  });

  it("does not restart after analysis was stopped", () => {
    const { analyser, requested } = harness();
    analyser.start();
    analyser.stop();
    const unsubscribe = analyser.subscribe(() => undefined);
    expect(requested).toEqual([]);
    unsubscribe();
  });
});
