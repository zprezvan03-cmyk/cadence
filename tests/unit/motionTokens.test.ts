/**
 * Motion foundation contracts: the JS token mirrors in `app/motion.ts` must stay in sync with
 * the CSS custom properties, exits must remain inside the shared fast-exit budget, and stagger
 * delays must stay capped so large lists never cascade row by row.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXIT_DURATION_MS,
  MOTION_DURATION_MS,
  MOTION_EASING,
  STAGGER_CAP,
  STAGGER_STEP_MS,
  effectiveExitMs,
  staggerDelayMs,
} from "../../src/renderer/app/motion";

const globalCss = readFileSync(new URL("../../src/renderer/styles/global.css", import.meta.url), "utf8");

describe("motion tokens", () => {
  it("mirror the CSS duration scale exactly", () => {
    expect(globalCss).toContain(`--dur-0: ${MOTION_DURATION_MS.press}ms`);
    expect(globalCss).toContain(`--dur-1: ${MOTION_DURATION_MS.fast}ms`);
    expect(globalCss).toContain(`--dur-2: ${MOTION_DURATION_MS.surface}ms`);
    expect(globalCss).toContain(`--dur-3: ${MOTION_DURATION_MS.view}ms`);
    expect(globalCss).toContain(`--dur-4: ${MOTION_DURATION_MS.layout}ms`);
    expect(globalCss).toContain(`--stagger-step: ${STAGGER_STEP_MS}ms`);
  });

  it("mirror the CSS easing family exactly", () => {
    expect(globalCss).toContain(`--ease-out: ${MOTION_EASING.out}`);
    expect(globalCss).toContain(`--ease-in: ${MOTION_EASING.in}`);
    expect(globalCss).toContain(`--ease-in-out: ${MOTION_EASING.inOut}`);
    expect(globalCss).toContain(`--ease-spring: ${MOTION_EASING.spring}`);
  });

  it("keeps exits inside the strictest dismissal budget", () => {
    expect(EXIT_DURATION_MS).toBe(120);
    expect(effectiveExitMs(90, false)).toBe(90);
    expect(effectiveExitMs(240, false)).toBe(EXIT_DURATION_MS);
    expect(effectiveExitMs(120, true)).toBe(0);
    expect(effectiveExitMs(Number.NaN, false)).toBe(0);
    expect(effectiveExitMs(-10, false)).toBe(0);
  });

  it("caps stagger delays and clamps invalid indices", () => {
    expect(staggerDelayMs(0)).toBe(0);
    expect(staggerDelayMs(1)).toBe(STAGGER_STEP_MS);
    expect(staggerDelayMs(3)).toBe(72);
    expect(staggerDelayMs(1000)).toBe(STAGGER_CAP * STAGGER_STEP_MS);
    expect(staggerDelayMs(-5)).toBe(0);
    expect(staggerDelayMs(Number.NaN)).toBe(0);
    expect(staggerDelayMs(10, 4)).toBe(96);
  });

  it("keeps transition timing on the token scale", () => {
    // Static guard for the normalization above: transition declarations must reference the
    // --dur-* tokens instead of literal times. Deliberate non-exceptions: the `0s`/`0ms`
    // visibility-delay idiom and the `0.001ms` reduced-motion collapse sentinel. Continuous
    // `animation:` loop periods (spin/pulse) are cycles, not interaction timing, so the
    // shorthand is intentionally not scanned.
    const allowed = new Set(["0s", "0ms", "0.001ms"]);
    const offenders: string[] = [];
    for (const file of ["global.css", "views.css", "lyrics.css"]) {
      const css = readFileSync(new URL(`../../src/renderer/styles/${file}`, import.meta.url), "utf8");
      for (const match of css.matchAll(/(transition(?:-duration|-delay)?)\s*:\s*([^;}]+);/g)) {
        const declaration = match[2].replace(/\s+/g, " ").trim();
        const times = [...declaration.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?m?s)\b/g)]
          .map(entry => entry[1])
          .filter(time => !allowed.has(time));
        if (times.length) {
          const line = css.slice(0, match.index).split("\n").length;
          offenders.push(`${file}:${line} ${match[1]}: ${declaration}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
