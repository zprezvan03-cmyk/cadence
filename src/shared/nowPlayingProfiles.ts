/**
 * Built-in Now Playing profiles and the validation used for persisted custom profiles.
 *
 * Built-ins intentionally live here rather than in the settings file: Cadence can refine
 * them between releases, while user-authored copies remain stable. Settings therefore
 * stores only the active id and custom profiles. Written for Cadence.
 */

import type {
  NowPlayingProfile,
  NowPlayingProfileConfig,
  NowPlayingProfilesSettings,
} from "./types";

export const NOW_PLAYING_PROFILES_VERSION = 1;
export const DEFAULT_NOW_PLAYING_PROFILE_ID = "balanced";
export const MAX_CUSTOM_NOW_PLAYING_PROFILES = 50;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const BASE_NOW_PLAYING_PROFILE_CONFIG: NowPlayingProfileConfig = deepFreeze({
  artworkVisible: true,
  artworkScale: 1,
  lyricsScale: 1,
  translationScale: 1,
  romanizationScale: 1,
  titleScale: 1,
  metadataScale: 1,
  controlsScale: 1,
  lyricsMaxWidth: 1120,
  spacingScale: 1,
});

function profileConfig(patch: Partial<NowPlayingProfileConfig> = {}): NowPlayingProfileConfig {
  return { ...BASE_NOW_PLAYING_PROFILE_CONFIG, ...patch };
}

function builtInProfile(
  id: string,
  name: string,
  description: string,
  windowed: Partial<NowPlayingProfileConfig>,
  fullscreen: Partial<NowPlayingProfileConfig>
): NowPlayingProfile {
  return {
    id,
    name,
    description,
    builtIn: true,
    windowed: profileConfig(windowed),
    fullscreen: profileConfig(fullscreen),
  };
}

export const BUILT_IN_NOW_PLAYING_PROFILES: readonly NowPlayingProfile[] = deepFreeze([
  builtInProfile(
    "balanced",
    "Balanced",
    "Even emphasis on artwork, lyrics and controls.",
    {},
    {}
  ),
  builtInProfile(
    "lyrics-focus",
    "Lyrics Focus",
    "Larger, wider lyrics with quieter artwork and metadata.",
    {
      lyricsScale: 1.12,
      translationScale: 1.08,
      romanizationScale: 1.08,
      titleScale: 0.92,
      metadataScale: 0.95,
      controlsScale: 0.95,
      lyricsMaxWidth: 1200,
      spacingScale: 0.95,
    },
    {
      artworkScale: 0.74,
      lyricsScale: 1.16,
      translationScale: 1.1,
      romanizationScale: 1.1,
      titleScale: 0.9,
      metadataScale: 0.94,
      controlsScale: 0.95,
      lyricsMaxWidth: 1200,
      spacingScale: 0.95,
    }
  ),
  builtInProfile(
    "artwork-focus",
    "Artwork Focus",
    "A larger cover and title with a narrower lyric column.",
    {
      artworkScale: 1.1,
      lyricsScale: 0.94,
      translationScale: 0.96,
      romanizationScale: 0.96,
      titleScale: 1.08,
      metadataScale: 1.05,
      lyricsMaxWidth: 980,
      spacingScale: 1.05,
    },
    {
      artworkScale: 1.16,
      lyricsScale: 0.9,
      translationScale: 0.94,
      romanizationScale: 0.94,
      titleScale: 1.1,
      metadataScale: 1.06,
      lyricsMaxWidth: 940,
      spacingScale: 1.05,
    }
  ),
  builtInProfile(
    "immersive",
    "Immersive",
    "Generous artwork, typography and controls for large displays.",
    {
      artworkScale: 1.08,
      lyricsScale: 1.08,
      translationScale: 1.04,
      romanizationScale: 1.04,
      titleScale: 1.1,
      metadataScale: 1.06,
      controlsScale: 1.08,
      lyricsMaxWidth: 1160,
      spacingScale: 1.1,
    },
    {
      artworkScale: 1.08,
      lyricsScale: 1.1,
      translationScale: 1.06,
      romanizationScale: 1.06,
      titleScale: 1.12,
      metadataScale: 1.08,
      controlsScale: 1.1,
      lyricsMaxWidth: 1160,
      spacingScale: 1.1,
    }
  ),
  builtInProfile(
    "minimal",
    "Minimal",
    "Compact typography and controls with a restrained lyric measure.",
    {
      artworkScale: 0.82,
      lyricsScale: 0.92,
      translationScale: 0.94,
      romanizationScale: 0.94,
      titleScale: 0.88,
      metadataScale: 0.9,
      controlsScale: 0.9,
      lyricsMaxWidth: 920,
      spacingScale: 0.9,
    },
    {
      artworkScale: 0.78,
      lyricsScale: 0.94,
      translationScale: 0.96,
      romanizationScale: 0.96,
      titleScale: 0.88,
      metadataScale: 0.9,
      controlsScale: 0.88,
      lyricsMaxWidth: 900,
      spacingScale: 0.9,
    }
  ),
]);

const BUILT_IN_PROFILE_IDS = new Set(BUILT_IN_NOW_PLAYING_PROFILES.map(profile => profile.id));

export function createDefaultNowPlayingProfilesSettings(): NowPlayingProfilesSettings {
  return {
    version: NOW_PLAYING_PROFILES_VERSION,
    activeProfileId: DEFAULT_NOW_PLAYING_PROFILE_ID,
    customProfiles: [],
  };
}

export const DEFAULT_NOW_PLAYING_PROFILES_SETTINGS: NowPlayingProfilesSettings = deepFreeze(
  createDefaultNowPlayingProfilesSettings()
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function cleanProfileId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return null;
  return id;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
  return text || fallback;
}

export function normalizeNowPlayingProfileConfig(
  input: unknown,
  fallback: NowPlayingProfileConfig = BASE_NOW_PLAYING_PROFILE_CONFIG
): NowPlayingProfileConfig {
  const source = isRecord(input) ? input : {};
  return {
    artworkVisible:
      typeof source.artworkVisible === "boolean" ? source.artworkVisible : fallback.artworkVisible,
    artworkScale: clampNumber(source.artworkScale, fallback.artworkScale, 0.6, 1.25),
    lyricsScale: clampNumber(source.lyricsScale, fallback.lyricsScale, 0.7, 1.35),
    translationScale: clampNumber(
      source.translationScale,
      fallback.translationScale,
      0.7,
      1.35
    ),
    romanizationScale: clampNumber(
      source.romanizationScale,
      fallback.romanizationScale,
      0.7,
      1.35
    ),
    titleScale: clampNumber(source.titleScale, fallback.titleScale, 0.75, 1.25),
    metadataScale: clampNumber(source.metadataScale, fallback.metadataScale, 0.75, 1.25),
    controlsScale: clampNumber(source.controlsScale, fallback.controlsScale, 0.8, 1.2),
    lyricsMaxWidth: Math.round(
      clampNumber(source.lyricsMaxWidth, fallback.lyricsMaxWidth, 640, 1280)
    ),
    spacingScale: clampNumber(source.spacingScale, fallback.spacingScale, 0.8, 1.25),
  };
}

export function normalizeNowPlayingProfile(
  input: unknown,
  builtIn = false
): NowPlayingProfile | null {
  if (!isRecord(input)) return null;
  const id = cleanProfileId(input.id);
  if (!id) return null;
  return {
    id,
    name: cleanText(input.name, "Custom profile", 60),
    description: cleanText(input.description, "", 140),
    builtIn,
    windowed: normalizeNowPlayingProfileConfig(input.windowed),
    fullscreen: normalizeNowPlayingProfileConfig(input.fullscreen),
  };
}

export function normalizeNowPlayingProfilesSettings(
  input: unknown
): NowPlayingProfilesSettings {
  if (!isRecord(input)) return createDefaultNowPlayingProfilesSettings();
  const version = input.version === undefined ? NOW_PLAYING_PROFILES_VERSION : Number(input.version);
  if (version !== NOW_PLAYING_PROFILES_VERSION) return createDefaultNowPlayingProfilesSettings();

  const usedIds = new Set(BUILT_IN_PROFILE_IDS);
  const customProfiles: NowPlayingProfile[] = [];
  if (Array.isArray(input.customProfiles)) {
    for (const rawProfile of input.customProfiles.slice(0, 100)) {
      const profile = normalizeNowPlayingProfile(rawProfile, false);
      if (!profile || usedIds.has(profile.id)) continue;
      usedIds.add(profile.id);
      customProfiles.push(profile);
      if (customProfiles.length >= MAX_CUSTOM_NOW_PLAYING_PROFILES) break;
    }
  }

  const requestedActiveId = cleanProfileId(input.activeProfileId);
  const activeProfileId =
    requestedActiveId && usedIds.has(requestedActiveId)
      ? requestedActiveId
      : DEFAULT_NOW_PLAYING_PROFILE_ID;

  return {
    version: NOW_PLAYING_PROFILES_VERSION,
    activeProfileId,
    customProfiles,
  };
}

export function isBuiltInNowPlayingProfileId(id: string): boolean {
  return BUILT_IN_PROFILE_IDS.has(id);
}

export function listNowPlayingProfiles(
  settings?: NowPlayingProfilesSettings | null
): NowPlayingProfile[] {
  const customProfiles = Array.isArray(settings?.customProfiles) ? settings.customProfiles : [];
  return [...BUILT_IN_NOW_PLAYING_PROFILES, ...customProfiles];
}

export function getNowPlayingProfile(
  settings: NowPlayingProfilesSettings | null | undefined,
  profileId: string | null | undefined
): NowPlayingProfile {
  const fallback = BUILT_IN_NOW_PLAYING_PROFILES[0];
  if (!profileId) return fallback;
  return listNowPlayingProfiles(settings).find(profile => profile.id === profileId) ?? fallback;
}

export function getActiveNowPlayingProfile(
  settings?: NowPlayingProfilesSettings | null
): NowPlayingProfile {
  return getNowPlayingProfile(settings, settings?.activeProfileId);
}

export function resolveNowPlayingProfileConfig(
  settings: NowPlayingProfilesSettings | null | undefined,
  fullscreen: boolean
): NowPlayingProfileConfig {
  const profile = getActiveNowPlayingProfile(settings);
  return fullscreen ? profile.fullscreen : profile.windowed;
}

export function cloneNowPlayingProfile(profile: NowPlayingProfile): NowPlayingProfile {
  return structuredClone(profile);
}
