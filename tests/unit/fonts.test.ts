import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FONT_ID,
  FALLBACK_FONT_FAMILIES,
  LEGACY_FONT_PRESETS,
  fontOption,
  fontOptions,
  fontStack,
  normalizeFontId,
  normalizeSystemFontFamilies,
  type SystemFontFamily,
} from "../../src/shared/fonts";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";

const workDir = mkdtempSync(join(tmpdir(), "cadence-fonts-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("font ids", () => {
  it("defaults to the system preset, which the settings default names", () => {
    expect(DEFAULT_FONT_ID).toBe("system");
    expect(DEFAULT_SETTINGS.appearance.fontFamily).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId(null)).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId(undefined)).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId("   ")).toBe(DEFAULT_FONT_ID);
  });

  it("keeps a real installed family name verbatim", () => {
    expect(normalizeFontId("Georgia")).toBe("Georgia");
    expect(normalizeFontId("  Noto Sans CJK JP  ")).toBe("Noto Sans CJK JP");
    expect(normalizeFontId("Comic Sans MS")).toBe("Comic Sans MS");
  });

  it("migrates every id the old fixed list shipped to a family or preset", () => {
    for (const [legacy, expected] of Object.entries(LEGACY_FONT_PRESETS)) {
      expect(normalizeFontId(legacy)).toBe(expected);
    }
    // Case-insensitive, as settings files have never been case-normalized.
    expect(normalizeFontId("GEORGIA")).toBe("Georgia");
  });

  it("refuses corrupt or unusable ids", () => {
    expect(normalizeFontId("x".repeat(500))).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId("bad\nname")).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId("\u0000")).toBe(DEFAULT_FONT_ID);
    expect(normalizeFontId(42)).toBe(DEFAULT_FONT_ID);
  });
});

describe("font stacks", () => {
  it("ends every stack in a generic family so a missing font still renders", () => {
    for (const option of [
      fontOption("system"),
      fontOption("monospace"),
      ...fontOptions(FALLBACK_FONT_FAMILIES),
    ]) {
      expect(option.stack).toMatch(/,?\s*(sans-serif|serif|monospace)$/);
    }
  });

  it("uses the system stack for the default preset", () => {
    const stack = fontStack("system");
    expect(stack).toContain("Segoe UI");
    expect(stack).toContain("sans-serif");
  });

  it("quotes the family and keeps the system fallback behind it", () => {
    expect(fontStack("Georgia")).toMatch(/^"Georgia", /);
    expect(fontStack("Georgia")).toContain("sans-serif");
    expect(fontStack("monospace")).toContain("monospace");
  });

  it("escapes quotes and backslashes in a family name", () => {
    expect(fontStack('Weird"Family')).toContain('"Weird\\"Family"');
    expect(fontStack("Back\\slash")).toContain('"Back\\\\slash"');
  });

  it("builds the picker list from discovered families, not a fixed list", () => {
    const families: SystemFontFamily[] = [
      { family: "Zeta Sans", styles: ["Regular"] },
      { family: "Alpha Serif", styles: ["Bold"] },
    ];
    const options = fontOptions(families);
    expect(options.map(option => option.id)).toEqual([
      "system",
      "monospace",
      "Zeta Sans",
      "Alpha Serif",
    ]);
    expect(options[0].preset).toBe(true);
    expect(options[2].stack).toContain('"Zeta Sans"');
  });
});

describe("system font payloads", () => {
  it("merges duplicate families, sorts styles and drops the presets", () => {
    const families = normalizeSystemFontFamilies([
      { family: "Arial", styles: ["Bold", "Regular"] },
      { family: "arial", styles: ["Italic", "Regular"] },
      { family: "Georgia", styles: ["Regular"] },
      { family: "system", styles: ["Regular"] },
      { family: "", styles: [] },
    ]);
    expect(families.map(family => family.family)).toEqual(["Arial", "Georgia"]);
    expect(families[0].styles).toEqual(["Bold", "Italic", "Regular"]);
  });

  it("sorts case-insensitively and tolerates null", () => {
    expect(normalizeSystemFontFamilies(null)).toEqual([]);
    const families = normalizeSystemFontFamilies([
      { family: "beta", styles: [] },
      { family: "Alpha", styles: [] },
    ]);
    expect(families.map(family => family.family)).toEqual(["Alpha", "beta"]);
  });
});

describe("settings persistence", () => {
  it("defaults the font and survives a restart", () => {
    const file = join(workDir, "restart.json");
    const first = new SettingsStore(file);
    expect(first.get().appearance.fontFamily).toBe(DEFAULT_FONT_ID);

    first.patch({ appearance: { fontFamily: "Georgia" } });
    expect(JSON.parse(readFileSync(file, "utf8")).appearance.fontFamily).toBe("Georgia");

    // A new store over the same file is what the next launch does.
    expect(new SettingsStore(file).get().appearance.fontFamily).toBe("Georgia");
  });

  it("migrates the old fixed-list ids on load", () => {
    const file = join(workDir, "legacy.json");
    writeFileSync(file, JSON.stringify({ appearance: { fontFamily: "georgia" } }), "utf8");
    expect(new SettingsStore(file).get().appearance.fontFamily).toBe("Georgia");
  });

  it("falls back to the system default for an unreadable font value", () => {
    const file = join(workDir, "corrupt.json");
    writeFileSync(file, JSON.stringify({ appearance: { fontFamily: "bad\nname" } }), "utf8");
    expect(new SettingsStore(file).get().appearance.fontFamily).toBe(DEFAULT_FONT_ID);
  });

  it("adds the font to settings files written before it existed", () => {
    const file = join(workDir, "pre-font.json");
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
