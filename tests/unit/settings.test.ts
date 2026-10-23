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
