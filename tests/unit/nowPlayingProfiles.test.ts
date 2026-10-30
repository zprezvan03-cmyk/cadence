import { describe, expect, it } from "vitest";
import {
  BASE_NOW_PLAYING_PROFILE_CONFIG,
  BUILT_IN_NOW_PLAYING_PROFILES,
  MAX_CUSTOM_NOW_PLAYING_PROFILES,
  cloneNowPlayingProfile,
  createDefaultNowPlayingProfilesSettings,
  getActiveNowPlayingProfile,
  isBuiltInNowPlayingProfileId,
  listNowPlayingProfiles,
  normalizeNowPlayingProfileConfig,
  normalizeNowPlayingProfilesSettings,
  resolveNowPlayingProfileConfig,
} from "../../src/shared/nowPlayingProfiles";

describe("built-in Now Playing profiles", () => {
  it("ships the five protected profiles in quick-switcher order", () => {
    expect(BUILT_IN_NOW_PLAYING_PROFILES.map(profile => profile.id)).toEqual([
      "balanced",
      "lyrics-focus",
      "artwork-focus",
      "immersive",
      "minimal",
    ]);
    expect(BUILT_IN_NOW_PLAYING_PROFILES.every(profile => profile.builtIn)).toBe(true);
    expect(isBuiltInNowPlayingProfileId("immersive")).toBe(true);
    expect(isBuiltInNowPlayingProfileId("my-profile")).toBe(false);
  });

  it("keeps Balanced at the pre-profile 1x reference proportions", () => {
    const balanced = BUILT_IN_NOW_PLAYING_PROFILES[0];
    expect(balanced.windowed).toEqual(BASE_NOW_PLAYING_PROFILE_CONFIG);
    expect(balanced.fullscreen).toEqual(BASE_NOW_PLAYING_PROFILE_CONFIG);
  });

  it("freezes built-ins while allowing an editable clone", () => {
    const balanced = BUILT_IN_NOW_PLAYING_PROFILES[0];
    expect(Object.isFrozen(BUILT_IN_NOW_PLAYING_PROFILES)).toBe(true);
    expect(Object.isFrozen(balanced)).toBe(true);
    expect(Object.isFrozen(balanced.windowed)).toBe(true);

    const copy = cloneNowPlayingProfile(balanced);
    copy.windowed.lyricsScale = 1.2;
    expect(copy.windowed.lyricsScale).toBe(1.2);
    expect(balanced.windowed.lyricsScale).toBe(1);
  });

  it("resolves different proportions for windowed and fullscreen surfaces", () => {
    const settings = {
      ...createDefaultNowPlayingProfilesSettings(),
      activeProfileId: "lyrics-focus",
    };

    expect(resolveNowPlayingProfileConfig(settings, false)).toMatchObject({
      artworkScale: 1,
      lyricsScale: 1.12,
      lyricsMaxWidth: 1200,
    });
    expect(resolveNowPlayingProfileConfig(settings, true)).toMatchObject({
      artworkScale: 0.74,
      lyricsScale: 1.16,
      lyricsMaxWidth: 1200,
    });
  });
});

describe("Now Playing profile normalization", () => {
  it("clamps every numeric proportion and ignores invalid values safely", () => {
    expect(
      normalizeNowPlayingProfileConfig({
        artworkVisible: "yes",
        artworkScale: 99,
        lyricsScale: 0,
        translationScale: "1.2",
        romanizationScale: Number.NaN,
        titleScale: -1,
        metadataScale: 2,
        controlsScale: 0.1,
        lyricsMaxWidth: 9999.6,
        spacingScale: 42,
      })
    ).toEqual({
      artworkVisible: true,
      artworkScale: 1.25,
      lyricsScale: 0.7,
      translationScale: 1.2,
      romanizationScale: 1,
      titleScale: 0.75,
      metadataScale: 1.25,
      controlsScale: 0.8,
      lyricsMaxWidth: 1280,
      spacingScale: 1.25,
    });
  });

  it("keeps valid customs, forces them non-built-in, and drops duplicate or invalid ids", () => {
    const settings = normalizeNowPlayingProfilesSettings({
      version: 1,
      activeProfileId: "stage-custom",
      customProfiles: [
        {
          id: "stage-custom",
          name: "  Stage   Custom  ",
          description: "  A saved   layout ",
          builtIn: true,
          windowed: { lyricsScale: 1.05 },
          fullscreen: { artworkScale: 0.8, lyricsScale: 1.22 },
        },
        { id: "balanced", name: "Impostor" },
        { id: "stage-custom", name: "Duplicate" },
        { id: "not a valid id", name: "Invalid" },
        null,
      ],
    });

    expect(settings.activeProfileId).toBe("stage-custom");
    expect(settings.customProfiles).toHaveLength(1);
    expect(settings.customProfiles[0]).toMatchObject({
      id: "stage-custom",
      name: "Stage Custom",
      description: "A saved layout",
      builtIn: false,
    });
    expect(settings.customProfiles[0].windowed).toMatchObject({
      artworkScale: 1,
      lyricsScale: 1.05,
      lyricsMaxWidth: 1120,
    });
    expect(getActiveNowPlayingProfile(settings).name).toBe("Stage Custom");
    expect(listNowPlayingProfiles(settings)).toHaveLength(
      BUILT_IN_NOW_PLAYING_PROFILES.length + 1
    );
  });

  it("always retains Balanced when the active profile is missing", () => {
    const settings = normalizeNowPlayingProfilesSettings({
      version: 1,
      activeProfileId: "deleted-profile",
      customProfiles: [],
    });

    expect(settings.activeProfileId).toBe("balanced");
    expect(getActiveNowPlayingProfile(settings).id).toBe("balanced");
    expect(getActiveNowPlayingProfile(null).id).toBe("balanced");
  });

  it("falls back cleanly for unsupported persisted versions", () => {
    const settings = normalizeNowPlayingProfilesSettings({
      version: 99,
      activeProfileId: "future-profile",
      customProfiles: [{ id: "future-profile", name: "Future" }],
    });

    expect(settings).toEqual(createDefaultNowPlayingProfilesSettings());
    expect(settings).not.toBe(createDefaultNowPlayingProfilesSettings());
  });

  it("caps persisted custom profiles at a bounded count", () => {
    const settings = normalizeNowPlayingProfilesSettings({
      version: 1,
      activeProfileId: "balanced",
      customProfiles: Array.from({ length: MAX_CUSTOM_NOW_PLAYING_PROFILES + 5 }, (_, index) => ({
        id: `custom-${index}`,
        name: `Custom ${index}`,
      })),
    });

    expect(settings.customProfiles).toHaveLength(MAX_CUSTOM_NOW_PLAYING_PROFILES);
  });
});
