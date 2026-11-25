import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";
import { SettingsCore } from "../../src/main/settingsCore";
import {
  DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER,
  activeArtistImageProviders,
} from "../../src/shared/artistImageProviders";
import { addProviderToOrder, removeProviderFromOrder } from "../../src/shared/providerOrder";
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

  it("migrates the old effective fullscreen layout and saves Off choices independently", () => {
    const file = join(workDir, "legacy-lyrics-off.json");
    writeFileSync(file, JSON.stringify({
      lyrics: { showLyricsInFullscreen: false },
      nowPlayingProfiles: {
        version: 1,
        activeProfileId: "artwork-focus",
        contextSwitching: { enabled: true, windowedProfileId: "minimal", fullscreenProfileId: "custom-stage" },
        customProfiles: [{ id: "custom-stage", fullscreen: { artworkSlot: "right", backgroundMode: "gradient" } }],
      },
    }));
    const store = new SettingsStore(file);
    expect(store.get().lyrics.showLyricsInFullscreen).toBe(false);
    const migrated = store.get().nowPlayingProfiles;
    expect(migrated.lyricsOffProfileId).toBe("custom-stage");
    expect(migrated.customProfiles[0].lyricsOff).toEqual(migrated.customProfiles[0].fullscreen);
    store.patch({ nowPlayingProfiles: { lyricsOffProfileId: "balanced" } });
    const reopened = new SettingsStore(file).get().nowPlayingProfiles;
    expect(reopened.lyricsOffProfileId).toBe("balanced");
    expect(reopened.activeProfileId).toBe("artwork-focus");
    expect(reopened.contextSwitching.fullscreenProfileId).toBe("custom-stage");
  });

  it("repairs an invalid active profile id instead of persisting a broken selection", () => {
    const file = join(workDir, "now-playing-invalid-active.json");
    const store = new SettingsStore(file);
    store.patch({ nowPlayingProfiles: { activeProfileId: "missing-profile" } });

    expect(store.get().nowPlayingProfiles.activeProfileId).toBe("balanced");
    expect(new SettingsStore(file).get().nowPlayingProfiles.activeProfileId).toBe("balanced");
  });
});

describe("legacy YouTube catalog settings", () => {
  it("are absent from defaults", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty("youtubeCatalog");
  });

  it("drops a stored legacy catalog key, including any API key, when loading", () => {
    const file = join(workDir, "legacy-youtube-catalog.json");
    writeFileSync(
      file,
      JSON.stringify({
        lyrics: { fontSizeRem: 2.1 },
        youtubeCatalog: { enabled: true, apiKey: "AIza-testkey", region: "ID" },
      }),
      "utf8",
    );
    const settings = new SettingsStore(file).get();
    expect(settings.lyrics.fontSizeRem).toBe(2.1);
    expect(settings).not.toHaveProperty("youtubeCatalog");
    expect(JSON.stringify(settings)).not.toContain("AIza-testkey");
  });

  it("does not persist a legacy catalog key supplied through patch", () => {
    const file = join(workDir, "youtube-catalog-patch.json");
    const store = new SettingsStore(file);
    store.patch({
      youtubeCatalog: { enabled: true, apiKey: "AIza-testkey", region: "ID" },
    } as never);

    expect(store.get()).not.toHaveProperty("youtubeCatalog");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("youtubeCatalog");
    expect(new SettingsStore(file).get()).not.toHaveProperty("youtubeCatalog");
  });
});

describe("artist picture settings", () => {
  it("ships artist pictures enabled with automatic fetching and the verified provider order", () => {
    expect(DEFAULT_SETTINGS.artistImages.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.artistImages.autoFetch).toBe(true);
    expect(DEFAULT_SETTINGS.artistImages.providerOrder).toEqual([...DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER]);
    expect(DEFAULT_SETTINGS.artistImages.refreshAfterDays).toBe(30);
  });

  it("adds the section to settings files written before it existed", () => {
    const file = join(workDir, "legacy-artist-images.json");
    writeFileSync(file, JSON.stringify({ playback: { volume: 0.5 } }), "utf8");
    const settings = new SettingsStore(file).get();
    expect(settings.playback.volume).toBe(0.5);
    expect(settings.artistImages).toEqual({
      enabled: true,
      autoFetch: true,
      providerOrder: [...DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER],
      refreshAfterDays: 30,
    });
  });

  it("keeps a stored order, drops unknown ids and appends providers added by an update", () => {
    const file = join(workDir, "artist-images-order.json");
    writeFileSync(
      file,
      JSON.stringify({
        artistImages: { providerOrder: ["deezer", "fanart-tv", "deezer"], refreshAfterDays: 900 },
      }),
      "utf8"
    );
    const settings = new SettingsStore(file).get();
    expect(settings.artistImages.providerOrder).toEqual(["deezer", "lastfm", "wikidata"]);
    // Out-of-range windows are clamped rather than trusted.
    expect(settings.artistImages.refreshAfterDays).toBe(365);
  });

  it("persists the switch and the priority order across a restart", () => {
    const file = join(workDir, "artist-images-patch.json");
    const first = new SettingsStore(file);
    first.patch({ artistImages: { enabled: false, providerOrder: ["wikidata", "lastfm", "deezer"] } });

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.artistImages.enabled).toBe(false);
    expect(onDisk.artistImages.providerOrder).toEqual(["wikidata", "lastfm", "deezer"]);

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.artistImages.enabled).toBe(false);
    expect(reloaded.artistImages.providerOrder).toEqual(["wikidata", "lastfm", "deezer"]);
  });

  it("persists automatic fetching separately from the master switch", () => {
    const file = join(workDir, "artist-images-autofetch.json");
    const first = new SettingsStore(file);
    first.patch({ artistImages: { autoFetch: false } });

    // Turning automatic fetching off must not touch the master switch or the cache semantics.
    const afterDisable = new SettingsStore(file).get();
    expect(afterDisable.artistImages.autoFetch).toBe(false);
    expect(afterDisable.artistImages.enabled).toBe(true);

    first.patch({ artistImages: { autoFetch: true } });
    expect(new SettingsStore(file).get().artistImages.autoFetch).toBe(true);
  });

  it("keeps switched-off providers off across a restart instead of re-enabling them", () => {
    const file = join(workDir, "artist-images-disabled.json");
    const first = new SettingsStore(file);
    // `d_` is the stored representation of "known, but switched off" (the lyrics convention).
    first.patch({ artistImages: { providerOrder: ["lastfm", "d_wikidata", "deezer"] } });

    expect(new SettingsStore(file).get().artistImages.providerOrder).toEqual([
      "lastfm",
      "d_wikidata",
      "deezer",
    ]);
    expect(activeArtistImageProviders(new SettingsStore(file).get().artistImages.providerOrder)).toEqual([
      "lastfm",
      "deezer",
    ]);
  });

  it("accepts a disable toggle authored through the shared provider-order helpers", () => {
    const file = join(workDir, "artist-images-order-helpers.json");
    const first = new SettingsStore(file);
    const order = removeProviderFromOrder(first.get().artistImages.providerOrder, "deezer");
    first.patch({ artistImages: { providerOrder: order } });

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.artistImages.providerOrder).toEqual(["lastfm", "wikidata", "d_deezer"]);

    // Re-enabling restores the same priority slot rather than appending to the end.
    const readded = addProviderToOrder(reloaded.artistImages.providerOrder, "deezer");
    first.patch({ artistImages: { providerOrder: readded } });
    expect(new SettingsStore(file).get().artistImages.providerOrder).toEqual([
      "lastfm",
      "wikidata",
      "deezer",
    ]);
  });
});


describe("desktop settings writes", () => {
  it("keeps the saved profiles unchanged when persistence rejects and allows retry", async () => {
    let fail = true;
    let disk: string | undefined;
    const settings = new SettingsCore({ persist: async json => {
      if (fail) throw new Error("fixture write failed");
      disk = json;
    } });
    const patch = { nowPlayingProfiles: { lyricsOffProfileId: "minimal" } };
    await expect(settings.patchAndPersist(patch)).rejects.toThrow("fixture write failed");
    expect(settings.get().nowPlayingProfiles.lyricsOffProfileId).toBe("balanced");
    expect(disk).toBeUndefined();
    fail = false;
    await expect(settings.patchAndPersist(patch)).resolves.toMatchObject(patch);
    expect(new SettingsCore({ initialJson: disk }).get().nowPlayingProfiles.lyricsOffProfileId).toBe("minimal");
  });

  it("serializes a profile save and a subsequent playback patch without losing either", async () => {
    const writes: string[] = [];
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const settings = new SettingsCore({ persist: async json => {
      writes.push(json);
      if (writes.length === 1) await gate;
    } });
    const profiles = settings.patchAndPersist({ nowPlayingProfiles: { lyricsOffProfileId: "artwork-focus" } });
    const transport = settings.patchAndPersist({ playback: { volume: 0.25 } });
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(settings.get().nowPlayingProfiles.lyricsOffProfileId).toBe("balanced");
    release();
    await Promise.all([profiles, transport]);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1])).toMatchObject({
      nowPlayingProfiles: { lyricsOffProfileId: "artwork-focus", activeProfileId: "balanced" },
      playback: { volume: 0.25 },
    });
  });
});

describe("Home featured album rotation settings", () => {
  it("migrates files written before the seed existed", () => {
    const file = join(workDir, "legacy-home.json");
    writeFileSync(file, JSON.stringify({ appearance: { accent: "#123456" } }), "utf8");
    expect(new SettingsStore(file).get().home).toEqual({ featuredSeed: null, featuredSeedDay: null });
  });

  it("persists a manual refresh across a restart", () => {
    const file = join(workDir, "home-refresh.json");
    const first = new SettingsStore(file);
    first.patch({ home: { featuredSeed: 123456, featuredSeedDay: "2026-11-20" } });
    expect(new SettingsStore(file).get().home).toEqual({
      featuredSeed: 123456,
      featuredSeedDay: "2026-11-20",
    });
  });

  it("discards malformed seeds and day keys from hand-edited settings", () => {
    const file = join(workDir, "home-malformed.json");
    writeFileSync(
      file,
      JSON.stringify({ home: { featuredSeed: "oops", featuredSeedDay: "20-11-2026" } }),
      "utf8",
    );
    expect(new SettingsStore(file).get().home).toEqual({ featuredSeed: null, featuredSeedDay: null });
  });
});

describe("music-video background settings", () => {
  it("ships disabled defaults with an adjustable scrim", () => {
    expect(DEFAULT_SETTINGS.mvBackground).toEqual({
      enabled: false,
      scrimOpacity: 0.45,
      bindings: {},
    });
  });

  it("migrates settings files written before MV backgrounds existed", () => {
    const file = join(workDir, "legacy-mv.json");
    writeFileSync(file, JSON.stringify({ lyrics: { fontSizeRem: 2.4 } }), "utf8");
    expect(new SettingsStore(file).get().mvBackground).toEqual(DEFAULT_SETTINGS.mvBackground);
  });

  it("drops invalid bindings and clamps the scrim on load", () => {
    const file = join(workDir, "mv-invalid.json");
    writeFileSync(
      file,
      JSON.stringify({
        mvBackground: {
          enabled: true,
          scrimOpacity: 7,
          bindings: { "local:12": "cadence-media://file/abc", "local:13": 42, "": "bad-key" },
        },
      }),
      "utf8",
    );
    expect(new SettingsStore(file).get().mvBackground).toEqual({
      enabled: true,
      scrimOpacity: 1,
      bindings: { "local:12": "cadence-media://file/abc" },
    });
  });

  it("persists enabled state, scrim and manual bindings across a restart", () => {
    const file = join(workDir, "mv-persist.json");
    const first = new SettingsStore(file);
    first.patch({ mvBackground: { enabled: true, scrimOpacity: 0.2 } });
    first.patch({ mvBackground: { bindings: { "local:9": "cadence-media://file/xyz" } } });
    expect(new SettingsStore(file).get().mvBackground).toEqual({
      enabled: true,
      scrimOpacity: 0.2,
      bindings: { "local:9": "cadence-media://file/xyz" },
    });
  });
});

describe("global shader background setting", () => {
  it("ships off, so a new install never initialises a shader", () => {
    expect(DEFAULT_SETTINGS.shaders.globalBackground).toBe(false);
    expect(DEFAULT_SETTINGS.shaders.enabled).toBe(true);
  });

  it("migrates a settings file written before the switch existed to off", () => {
    const file = join(workDir, "legacy-shaders.json");
    writeFileSync(
      file,
      JSON.stringify({ shaders: { enabled: true, kawarpOpacity: 0.4, performanceMode: "low" } }),
      "utf8"
    );
    const settings = new SettingsStore(file).get();
    // The user's shader tuning survives; only the new opt-in starts off.
    expect(settings.shaders.kawarpOpacity).toBe(0.4);
    expect(settings.shaders.performanceMode).toBe("low");
    expect(settings.shaders.globalBackground).toBe(false);
  });

  it("never turns the switch on from a malformed or missing value", () => {
    for (const value of [undefined, null, "yes", 1, {}, []]) {
      const file = join(workDir, `bad-shaders-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify({ shaders: { globalBackground: value } }), "utf8");
      expect(new SettingsStore(file).get().shaders.globalBackground).toBe(false);
    }
  });

  it("persists the switch across a restart and back off again", () => {
    const file = join(workDir, "shaders-persist.json");
    const first = new SettingsStore(file);
    first.patch({ shaders: { globalBackground: true } });
    expect(JSON.parse(readFileSync(file, "utf8")).shaders.globalBackground).toBe(true);
    expect(new SettingsStore(file).get().shaders.globalBackground).toBe(true);

    const reopened = new SettingsStore(file);
    reopened.patch({ shaders: { globalBackground: false } });
    expect(new SettingsStore(file).get().shaders.globalBackground).toBe(false);
  });

  it("keeps the other shader settings untouched when the switch is patched", () => {
    const file = join(workDir, "shaders-untouched.json");
    const store = new SettingsStore(file);
    const before = store.get().shaders;
    store.patch({ shaders: { globalBackground: true } });
    const after = store.get().shaders;
    expect(after.kawarpOpacity).toBe(before.kawarpOpacity);
    expect(after.performanceMode).toBe(before.performanceMode);
    expect(after.enabled).toBe(before.enabled);
  });
});
