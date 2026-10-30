import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";

const workDir = mkdtempSync(join(tmpdir(), "cadence-settings-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("secondary font size settings", () => {
  it("ships defaults matching the renderer's secondary typography", () => {
    expect(DEFAULT_SETTINGS.lyrics.translationFontSizePx).toBe(32);
    expect(DEFAULT_SETTINGS.lyrics.romanizationFontSizePx).toBe(26);
  });

  it("adds the sizes to settings files written before they existed, keeping the rest", () => {
    const file = join(workDir, "legacy.json");
    writeFileSync(
      file,
      JSON.stringify({ lyrics: { fontSizeRem: 2.2, translationLanguage: "en" } }),
      "utf8"
    );
    const settings = new SettingsStore(file).get();
    expect(settings.lyrics.fontSizeRem).toBe(2.2);
    expect(settings.lyrics.translationLanguage).toBe("en");
    expect(settings.lyrics.translationFontSizePx).toBe(32);
    expect(settings.lyrics.romanizationFontSizePx).toBe(26);
  });

  it("persists the two sizes independently across a restart", () => {
    const file = join(workDir, "sizes.json");
    const first = new SettingsStore(file);
    first.patch({ lyrics: { translationFontSizePx: 18 } });
    first.patch({ lyrics: { romanizationFontSizePx: 14 } });

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.lyrics.translationFontSizePx).toBe(18);
    expect(onDisk.lyrics.romanizationFontSizePx).toBe(14);

    const reopened = new SettingsStore(file).get();
    expect(reopened.lyrics.translationFontSizePx).toBe(18);
    expect(reopened.lyrics.romanizationFontSizePx).toBe(14);
  });
});

describe("compact sidebar hover expansion setting", () => {
  it("defaults on, independently from compact mode itself", () => {
    expect(DEFAULT_SETTINGS.appearance.compactSidebar).toBe(false);
    expect(DEFAULT_SETTINGS.appearance.compactSidebarHoverExpand).toBe(true);
  });

  it("migrates settings written before the toggle existed", () => {
    const file = join(workDir, "legacy-appearance.json");
    writeFileSync(file, JSON.stringify({ appearance: { compactSidebar: true } }), "utf8");
    const settings = new SettingsStore(file).get();
    expect(settings.appearance.compactSidebar).toBe(true);
    expect(settings.appearance.compactSidebarHoverExpand).toBe(true);
  });

  it("persists an explicit off across a restart", () => {
    const file = join(workDir, "hover-expand.json");
    const first = new SettingsStore(file);
    first.patch({ appearance: { compactSidebarHoverExpand: false } });
    expect(JSON.parse(readFileSync(file, "utf8")).appearance.compactSidebarHoverExpand).toBe(false);
    expect(new SettingsStore(file).get().appearance.compactSidebarHoverExpand).toBe(false);
  });
});
