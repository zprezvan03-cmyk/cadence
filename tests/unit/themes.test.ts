import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/main/settings";
import { buildThemeCss } from "../../src/renderer/upstream/better-lyrics/themes";
import type { LyricsSettings } from "../../src/shared/types";

const settings = (patch: Partial<LyricsSettings> = {}): LyricsSettings => ({
  ...DEFAULT_SETTINGS.lyrics,
  ...patch,
});

describe("buildThemeCss secondary font sizes", () => {
  it("defaults to the renderer's own secondary sizes", () => {
    const css = buildThemeCss(settings());
    expect(css).toContain("--blyrics-translated-font-size: 32px;");
    expect(css).toContain("font-size: 26px;");
  });

  it("drives translation and romanization independently", () => {
    const translationOnly = buildThemeCss(settings({ translationFontSizePx: 18 }));
    expect(translationOnly).toContain("--blyrics-translated-font-size: 18px;");
    expect(translationOnly).toContain("font-size: 26px;");

    const romanizationOnly = buildThemeCss(settings({ romanizationFontSizePx: 14 }));
    expect(romanizationOnly).toContain("--blyrics-translated-font-size: 32px;");
    expect(romanizationOnly).toContain("font-size: 14px;");
  });

  it("leaves the original lyric typography alone", () => {
    const css = buildThemeCss(settings({ translationFontSizePx: 12, romanizationFontSizePx: 40 }));
    expect(css).toContain("--blyrics-font-size: 3rem;");
    expect(css).toContain("--blyrics-font-weight: 700;");
  });

  it("clamps out-of-range values and falls back on invalid ones", () => {
    const clamped = buildThemeCss(settings({ translationFontSizePx: 400, romanizationFontSizePx: 2 }));
    expect(clamped).toContain("--blyrics-translated-font-size: 48px;");
    expect(clamped).toContain("font-size: 10px;");

    const invalid = buildThemeCss(
      settings({
        translationFontSizePx: Number.NaN,
        romanizationFontSizePx: Number.POSITIVE_INFINITY,
      })
    );
    expect(invalid).toContain("--blyrics-translated-font-size: 32px;");
    expect(invalid).toContain("font-size: 26px;");
  });
});
