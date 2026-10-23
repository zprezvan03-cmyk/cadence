import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FONT_ID,
  FONT_OPTIONS,
  isFamilyInstalled,
  resolveFontOption,
  unavailableFontFamilies,
  type FontMeasurer,
} from "../../src/shared/fonts";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";

const workDir = mkdtempSync(join(tmpdir(), "cadence-fonts-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const GENERIC_WIDTHS: Record<string, number> = { monospace: 100, serif: 90, "sans-serif": 95 };

/** Stands in for the canvas: a family the machine has measures wider than the generic it falls back to. */
function fakeMeasurer(installed: readonly string[]): FontMeasurer {
  return cssFont => {
    const quoted = /"([^"]+)"/.exec(cssFont)?.[1];
    const generic = /,\s*([a-z-]+)\s*$/.exec(cssFont)?.[1] ?? /^72px\s+([a-z-]+)$/.exec(cssFont)?.[1] ?? "monospace";
    const base = GENERIC_WIDTHS[generic] ?? 100;
    return quoted !== undefined && installed.includes(quoted) ? base + 11 : base;
  };
}

describe("font options", () => {
  it("defaults to the first option, which the settings default names", () => {
    expect(FONT_OPTIONS.length).toBeGreaterThan(3);
    expect(FONT_OPTIONS[0].id).toBe(DEFAULT_FONT_ID);
    expect(DEFAULT_SETTINGS.appearance.fontFamily).toBe(DEFAULT_FONT_ID);
    expect(resolveFontOption(DEFAULT_FONT_ID).id).toBe(DEFAULT_FONT_ID);
  });

  it("keeps ids unique and labels readable", () => {
    const ids = FONT_OPTIONS.map(option => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const option of FONT_OPTIONS) {
      expect(option.label.trim()).not.toBe("");
      expect(option.stack.trim()).not.toBe("");
    }
  });

  it("ends every stack in a generic family so a missing font still renders", () => {
    for (const option of FONT_OPTIONS) {
      expect(option.stack).toMatch(/,\s*(sans-serif|serif|monospace)$/);
    }
  });

  it("resolves unknown ids to the default instead of leaving the app without a font", () => {
    expect(resolveFontOption("comic-sans").id).toBe(DEFAULT_FONT_ID);
    expect(resolveFontOption("").id).toBe(DEFAULT_FONT_ID);
    expect(resolveFontOption(null).id).toBe(DEFAULT_FONT_ID);
    expect(resolveFontOption(undefined).id).toBe(DEFAULT_FONT_ID);
  });
});

describe("font detection", () => {
  it("tells an installed family from one that falls back to the generic", () => {
    const measure = fakeMeasurer(["Georgia"]);
    expect(isFamilyInstalled("Georgia", measure)).toBe(true);
    expect(isFamilyInstalled("Tahoma", measure)).toBe(false);
  });

  it("reports only the probe families this machine lacks", () => {
    const missing = unavailableFontFamilies(FONT_OPTIONS, fakeMeasurer(["Georgia", "Verdana"]));
    expect(missing).toContain("Tahoma");
    expect(missing).not.toContain("Georgia");
    expect(missing).not.toContain("Verdana");
    // Options without a probe (stacks that always resolve) are never reported.
    expect(missing).not.toContain(null);
  });

  it("says nothing when the platform cannot measure", () => {
    expect(unavailableFontFamilies(FONT_OPTIONS, () => null)).toEqual([]);
  });
});

describe("settings persistence", () => {
  it("defaults the font and survives a restart", () => {
    const file = join(workDir, "restart.json");
    const first = new SettingsStore(file);
    expect(first.get().appearance.fontFamily).toBe(DEFAULT_FONT_ID);

    first.patch({ appearance: { fontFamily: "georgia" } });
    expect(JSON.parse(readFileSync(file, "utf8")).appearance.fontFamily).toBe("georgia");

    // A new store over the same file is what the next launch does.
    expect(new SettingsStore(file).get().appearance.fontFamily).toBe("georgia");
  });

  it("adds the font to settings files written before it existed", () => {
    const file = join(workDir, "legacy.json");
    writeFileSync(file, JSON.stringify({ appearance: { accent: "#123456" } }), "utf8");
    const settings = new SettingsStore(file).get();
    expect(settings.appearance.accent).toBe("#123456");
    expect(settings.appearance.fontFamily).toBe(DEFAULT_FONT_ID);
  });

  it("restores the default font when settings are reset", () => {
    const file = join(workDir, "reset.json");
    const store = new SettingsStore(file);
    store.patch({ appearance: { fontFamily: "monospace" } });
    expect(store.reset().appearance.fontFamily).toBe(DEFAULT_FONT_ID);
  });
});
