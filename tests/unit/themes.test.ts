import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/main/settings";
import { buildThemeCss } from "../../src/renderer/upstream/better-lyrics/themes";
import type { LyricsSettings } from "../../src/shared/types";

const settings = (patch: Partial<LyricsSettings> = {}): LyricsSettings => ({
  ...DEFAULT_SETTINGS.lyrics,
  ...patch,
});

describe("buildThemeCss secondary font sizes", () => {
  it("uses the renderer's fluid sizes with its own secondary sizes as fallbacks", () => {
    const css = buildThemeCss(settings());
    expect(css).toContain("--blyrics-font-size: var(--np-lyrics-font-size, 3rem);");
    expect(css).toContain(
      "--blyrics-translated-font-size: var(--np-translation-font-size, 32px);"
    );
    expect(css).toContain("font-size: var(--np-romanization-font-size, 26px);");
  });

  it("drives translation and romanization fallbacks independently", () => {
    const translationOnly = buildThemeCss(settings({ translationFontSizePx: 18 }));
    expect(translationOnly).toContain(
      "--blyrics-translated-font-size: var(--np-translation-font-size, 18px);"
    );
    expect(translationOnly).toContain("font-size: var(--np-romanization-font-size, 26px);");

    const romanizationOnly = buildThemeCss(settings({ romanizationFontSizePx: 14 }));
    expect(romanizationOnly).toContain(
      "--blyrics-translated-font-size: var(--np-translation-font-size, 32px);"
    );
    expect(romanizationOnly).toContain("font-size: var(--np-romanization-font-size, 14px);");
  });

  it("keeps the original lyric size as the fluid fallback", () => {
    const css = buildThemeCss(settings({ translationFontSizePx: 12, romanizationFontSizePx: 40 }));
    expect(css).toContain("--blyrics-font-size: var(--np-lyrics-font-size, 3rem);");
    expect(css).toContain("--blyrics-font-weight: var(--np-lyrics-weight, 700);");
  });

  it("exposes the profile karaoke, motion and typography variables with safe fallbacks", () => {
    const css = buildThemeCss(settings({}));
    expect(css).toContain("--blyrics-animate-highlight-swipe: var(--np-karaoke-swipe, 1);");
    expect(css).toContain("--blyrics-letter-wave-emphasis-scale: var(--np-active-word-scale, 1.11);");
    expect(css).toContain("--blyrics-transition-duration: var(--np-motion-duration, 0.166s);");
    expect(css).toContain("--blyrics-active-scale: var(--np-active-line-scale, 1);");
    expect(css).toContain("font-family: var(--np-romanization-font,");
  });

  it("clamps out-of-range fallbacks and replaces invalid ones", () => {
    const clamped = buildThemeCss(settings({ translationFontSizePx: 400, romanizationFontSizePx: 2 }));
    expect(clamped).toContain(
      "--blyrics-translated-font-size: var(--np-translation-font-size, 48px);"
    );
    expect(clamped).toContain("font-size: var(--np-romanization-font-size, 10px);");

    const invalid = buildThemeCss(
      settings({
        translationFontSizePx: Number.NaN,
        romanizationFontSizePx: Number.POSITIVE_INFINITY,
      })
    );
    expect(invalid).toContain(
      "--blyrics-translated-font-size: var(--np-translation-font-size, 32px);"
    );
    expect(invalid).toContain("font-size: var(--np-romanization-font-size, 26px);");
  });
});
