import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";
import { createDefaultNowPlayingProfilesSettings } from "../../src/shared/nowPlayingProfiles";

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

describe("Now Playing profile settings", () => {
  it("defaults to Balanced with no persisted built-in copies", () => {
    expect(DEFAULT_SETTINGS.nowPlayingProfiles).toEqual(
      createDefaultNowPlayingProfilesSettings()
    );
  });

  it("migrates settings written before profiles existed", () => {
    const file = join(workDir, "legacy-now-playing.json");
    writeFileSync(file, JSON.stringify({ lyrics: { fontSizeRem: 2.4 } }), "utf8");

    const settings = new SettingsStore(file).get();
    expect(settings.lyrics.fontSizeRem).toBe(2.4);
    expect(settings.nowPlayingProfiles).toEqual(createDefaultNowPlayingProfilesSettings());
  });

  it("persists the last active profile and a normalized custom profile", () => {
    const file = join(workDir, "now-playing-profiles.json");
    const first = new SettingsStore(file);
    first.patch({
      nowPlayingProfiles: {
        activeProfileId: "saved-layout",
        customProfiles: [
          {
            id: "saved-layout",
            name: "Saved Layout",
            description: "A profile written before the Studio exists.",
            builtIn: true,
            windowed: {
              artworkVisible: true,
              artworkScale: 3,
              lyricsScale: 1.1,
              translationScale: 1,
              romanizationScale: 1,
              titleScale: 1,
              metadataScale: 1,
              controlsScale: 1,
              lyricsMaxWidth: 1000,
              spacingScale: 1,
            },
            fullscreen: {
              artworkVisible: false,
              artworkScale: 0.8,
              lyricsScale: 1.2,
              translationScale: 1.05,
              romanizationScale: 1.05,
              titleScale: 0.9,
              metadataScale: 0.95,
              controlsScale: 0.9,
              lyricsMaxWidth: 1180,
              spacingScale: 0.95,
            },
          },
        ],
      },
    });

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.nowPlayingProfiles.activeProfileId).toBe("saved-layout");
    expect(onDisk.nowPlayingProfiles.customProfiles[0].builtIn).toBe(false);
    expect(onDisk.nowPlayingProfiles.customProfiles[0].windowed.artworkScale).toBe(1.25);

    const reopened = new SettingsStore(file).get();
    expect(reopened.nowPlayingProfiles.activeProfileId).toBe("saved-layout");
    expect(reopened.nowPlayingProfiles.customProfiles[0].fullscreen.artworkVisible).toBe(false);
  });

  it("repairs an invalid active profile id instead of persisting a broken selection", () => {
    const file = join(workDir, "now-playing-invalid-active.json");
    const store = new SettingsStore(file);
    store.patch({ nowPlayingProfiles: { activeProfileId: "missing-profile" } });

    expect(store.get().nowPlayingProfiles.activeProfileId).toBe("balanced");
    expect(new SettingsStore(file).get().nowPlayingProfiles.activeProfileId).toBe("balanced");
  });
});
