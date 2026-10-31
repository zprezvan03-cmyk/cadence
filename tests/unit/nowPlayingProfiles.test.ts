import { describe, expect, it } from "vitest";
import {
  BASE_NOW_PLAYING_PROFILE_CONFIG,
  BUILT_IN_NOW_PLAYING_PROFILES,
  MAX_CUSTOM_NOW_PLAYING_PROFILES,
  cloneNowPlayingProfile,
  createCustomNowPlayingProfileId,
  createDefaultNowPlayingProfilesSettings,
  getActiveNowPlayingProfile,
  getEffectiveNowPlayingProfile,
  getNowPlayingAnimationCacheKey,
  isBuiltInNowPlayingProfileId,
  listNowPlayingProfiles,
  normalizeNowPlayingProfileConfig,
  normalizeNowPlayingProfilesSettings,
  parseNowPlayingProfileJson,
  resolveNowPlayingProfileConfig,
  serializeNowPlayingProfile,
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

  it("gives every built-in one identity across windowed and fullscreen", () => {
    // Karaoke style and background define what a profile IS; the two halves
    // may differ in proportions only. A table that carried Immersive's
    // glow/visualizer solely in its fullscreen half made it animate and
    // theme exactly like Balanced in a window.
    for (const profile of BUILT_IN_NOW_PLAYING_PROFILES) {
      expect(profile.windowed.karaokeStyle, profile.id).toBe(profile.fullscreen.karaokeStyle);
      expect(profile.windowed.backgroundMode, profile.id).toBe(profile.fullscreen.backgroundMode);
    }
    // The five identities are actually distinct from one another.
    const identities = new Set(
      BUILT_IN_NOW_PLAYING_PROFILES.map(
        p => `${p.windowed.karaokeStyle}|${p.windowed.backgroundMode}`
      )
    );
    expect(identities.size).toBe(BUILT_IN_NOW_PLAYING_PROFILES.length);
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
    ).toMatchObject({
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

  it("normalizes Studio-era fields: enums, colours, fonts and effect ranges", () => {
    const config = normalizeNowPlayingProfileConfig({
      artworkSlot: "right",
      metadataSlot: "diagonal",
      lyricsAlignment: "center",
      fontId: "georgia",
      translationFontId: "Comic Sans MS",
      romanizationFontId: "noto-sans",
      lyricsWeight: 950,
      activeColor: "#FF8800",
      inactiveColor: "red",
      inactiveBlurPx: 99,
      karaokeStyle: "glow",
      karaokeIntensity: 7,
      backgroundMode: "particles",
      backgroundBlurPx: -4,
      // Fields from the removed Motion section linger in saved profiles;
      // normalization must ignore them rather than resurrect the option.
      lyricTransition: "spin",
      motionDurationScale: 9,
    });
    expect("lyricTransition" in config).toBe(false);
    expect("motionDurationScale" in config).toBe(false);
    expect(config).toMatchObject({
      artworkSlot: "right",
      metadataSlot: "artwork",
      lyricsAlignment: "center",
      fontId: "georgia",
      translationFontId: "",
      romanizationFontId: "noto-sans",
      lyricsWeight: 900,
      activeColor: "#ff8800",
      inactiveColor: "",
      inactiveBlurPx: 6,
      karaokeStyle: "glow",
      karaokeIntensity: 1,
      backgroundMode: "particles",
      backgroundBlurPx: 0,
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

describe("context switching", () => {
  it("defaults off and resolves the single active profile for both surfaces", () => {
    const settings = createDefaultNowPlayingProfilesSettings();
    expect(settings.contextSwitching.enabled).toBe(false);
    expect(getEffectiveNowPlayingProfile(settings, false).id).toBe("balanced");
    expect(getEffectiveNowPlayingProfile(settings, true).id).toBe("balanced");
  });

  it("uses per-context profiles only when enabled, and repairs unknown ids", () => {
    const settings = normalizeNowPlayingProfilesSettings({
      version: 1,
      activeProfileId: "balanced",
      customProfiles: [],
      contextSwitching: {
        enabled: true,
        windowedProfileId: "lyrics-focus",
        fullscreenProfileId: "gone",
      },
    });
    expect(getEffectiveNowPlayingProfile(settings, false).id).toBe("lyrics-focus");
    // Unknown fullscreen id was repaired to the active profile at normalize time.
    expect(settings.contextSwitching.fullscreenProfileId).toBe("balanced");
    expect(getEffectiveNowPlayingProfile(settings, true).id).toBe("balanced");

    const disabled = { ...settings, contextSwitching: { ...settings.contextSwitching, enabled: false } };
    expect(getEffectiveNowPlayingProfile(disabled, false).id).toBe("balanced");
  });
});

describe("animation cache key", () => {
  // The renderer caches CSS values it reads into JS and only re-reads them when a
  // theme is applied; this key is folded into the theme string so a change to any
  // engine-read profile value reapplies the theme and drops that cache.
  it("is stable for equal configs and changes with every engine-read field", () => {
    const base = { ...BASE_NOW_PLAYING_PROFILE_CONFIG };
    expect(getNowPlayingAnimationCacheKey(base)).toBe(
      getNowPlayingAnimationCacheKey({ ...base })
    );
    const mutations: Partial<typeof base>[] = [
      { karaokeStyle: "solid" },
      { karaokeStyle: "minimal" },
      { karaokeIntensity: 0.25 },
      { activeWordScale: 1.2 },
      { activeLineScale: 1.1 },
    ];
    for (const mutation of mutations) {
      expect(getNowPlayingAnimationCacheKey({ ...base, ...mutation })).not.toBe(
        getNowPlayingAnimationCacheKey(base)
      );
    }
  });

  it("ignores values plain CSS follows live (no theme reapply needed)", () => {
    const base = { ...BASE_NOW_PLAYING_PROFILE_CONFIG };
    const cssOnly: Partial<typeof base>[] = [
      { fontId: "georgia" },
      { activeColor: "#ff8800" },
      { lyricsScale: 1.3 },
      { backgroundMode: "particles" },
      { inactiveBlurPx: 3 },
      { lyricsAlignment: "center" },
    ];
    for (const mutation of cssOnly) {
      expect(getNowPlayingAnimationCacheKey({ ...base, ...mutation })).toBe(
        getNowPlayingAnimationCacheKey(base)
      );
    }
  });
});

describe("profile import / export", () => {
  it("round-trips a custom profile through the versioned envelope", () => {
    const custom = cloneNowPlayingProfile(BUILT_IN_NOW_PLAYING_PROFILES[1]);
    custom.id = createCustomNowPlayingProfileId();
    custom.name = "Stage Layout";
    custom.builtIn = false;
    custom.fullscreen.backgroundMode = "particles";

    const parsed = parseNowPlayingProfileJson(serializeNowPlayingProfile(custom));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.profile).toEqual(custom);
      expect(parsed.profile.builtIn).toBe(false);
    }
  });

  it("rejects foreign JSON, broken JSON and newer formats without guessing", () => {
    expect(parseNowPlayingProfileJson("not json")).toMatchObject({ ok: false });
    expect(parseNowPlayingProfileJson('{"hello":"world"}')).toMatchObject({ ok: false });
    expect(
      parseNowPlayingProfileJson(
        JSON.stringify({ kind: "cadence-now-playing-profile", version: 99, profile: {} })
      )
    ).toMatchObject({ ok: false });
  });

  it("normalizes hostile values instead of trusting the file", () => {
    const parsed = parseNowPlayingProfileJson(
      JSON.stringify({
        kind: "cadence-now-playing-profile",
        version: 1,
        profile: {
          id: "imported-1",
          name: "Imported",
          builtIn: true,
          windowed: { lyricsScale: 500, backgroundMode: "execute-me", activeColor: "url(evil)" },
          fullscreen: { karaokeStyle: "glow" },
          evil: "ignored",
        },
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.profile.builtIn).toBe(false);
      expect(parsed.profile.windowed.lyricsScale).toBe(1.35);
      expect(parsed.profile.windowed.backgroundMode).toBe("fluid");
      expect(parsed.profile.windowed.activeColor).toBe("");
      expect(parsed.profile.fullscreen.karaokeStyle).toBe("glow");
      expect("evil" in parsed.profile).toBe(false);
    }
  });
});
