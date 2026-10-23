import { describe, expect, it } from "vitest";
import { advancePosition, buildOrder, formatTime, nextShuffledPosition } from "../../src/renderer/player/queue";

const seeded = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

describe("buildOrder", () => {
  it("keeps the identity order when shuffle is off", () => {
    expect(buildOrder(5, false, 3)).toEqual([0, 1, 2, 3, 4]);
  });

  it("puts the requested track first when shuffling", () => {
    const order = buildOrder(6, true, 4, seeded([0.1, 0.9, 0.4, 0.7, 0.2]));
    expect(order[0]).toBe(4);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is a no-op for a single track", () => {
    expect(buildOrder(1, true, 0)).toEqual([0]);
  });
});

describe("advancePosition", () => {
  it("advances and reports exhaustion at the end", () => {
    expect(advancePosition(0, 3, "off")).toEqual({ position: 1, exhausted: false, restart: false });
    expect(advancePosition(2, 3, "off", 1, false)).toEqual({ position: 2, exhausted: true, restart: false });
  });

  it("wraps when repeating the queue", () => {
    expect(advancePosition(2, 3, "all")).toEqual({ position: 0, exhausted: false, restart: false });
    expect(advancePosition(0, 3, "all", -1)).toEqual({ position: 2, exhausted: false, restart: false });
  });

  it("restarts the same track when repeating one", () => {
    expect(advancePosition(1, 3, "one")).toEqual({ position: 1, exhausted: false, restart: true });
  });

  it("clamps at the start when stepping back with repeat off", () => {
    expect(advancePosition(0, 3, "off", -1)).toEqual({ position: 0, exhausted: false, restart: false });
  });

  it("handles an empty queue", () => {
    expect(advancePosition(0, 0, "off")).toEqual({ position: 0, exhausted: true, restart: false });
  });
});

describe("nextShuffledPosition", () => {
  it("walks the shuffled order", () => {
    expect(nextShuffledPosition([2, 0, 1], 0, "off")).toEqual({ position: 1, exhausted: false, restart: false });
  });

  it("reshuffles instead of stopping when repeating all", () => {
    const order = [2, 0, 1];
    const result = nextShuffledPosition(order, 2, "all", seeded([0.5, 0.2, 0.8]));
    expect(result.position).toBe(0);
    expect(result.exhausted).toBe(false);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("stops at the end with repeat off", () => {
    expect(nextShuffledPosition([2, 0, 1], 2, "off")).toEqual({ position: 2, exhausted: true, restart: false });
  });
});

describe("formatTime", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9.9)).toBe("0:09");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  it("never prints NaN or negatives", () => {
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(-4)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
