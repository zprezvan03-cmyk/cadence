/**
 * Built-in Now Playing profiles and the validation used for persisted custom profiles.
 *
 * Built-ins intentionally live here rather than in the settings file: Cadence can refine
 * them between releases, while user-authored copies remain stable. Settings therefore
 * stores only the active id and custom profiles. Written for Cadence.
 */

import type {
  NowPlayingArtworkSlot,
  NowPlayingBackgroundMode,
  NowPlayingKaraokeStyle,
  NowPlayingLyricsAlignment,
  NowPlayingMetadataSlot,
  NowPlayingProfile,
  NowPlayingProfileConfig,
  NowPlayingProfilesSettings,
} from "./types";
import { FONT_OPTIONS } from "./fonts";

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
  artworkSlot: "left",
  metadataSlot: "artwork",
  metadataVisible: true,
  dockVisible: true,
  controlsVisible: true,
  lyricsAlignment: "left",
  fontId: "",
  translationFontId: "",
  romanizationFontId: "",
  lyricsWeight: 0,
  lineSpacingScale: 1,
  letterSpacingEm: 0,
  activeColor: "",
  inactiveColor: "",
  inactiveOpacityScale: 1,
  activeLineScale: 1,
  inactiveBlurPx: 0,
  karaokeStyle: "sweep",
  karaokeIntensity: 0.7,
  activeWordScale: 1.11,
  backgroundMode: "fluid",
  backgroundIntensity: 1,
  backgroundBlurPx: 40,
  effectSpeed: 1,
  effectDensity: 1,
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

// A built-in's identity — karaoke style and background — is the same in both
// halves; windowed/fullscreen differ in proportions only. (An earlier table
// carried Immersive's glow/visualizer only in its fullscreen half, so in a
// window it animated and themed exactly like Balanced.)
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
      karaokeStyle: "glow",
      karaokeIntensity: 0.85,
      backgroundMode: "blurred-artwork",
      backgroundIntensity: 0.85,
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
      karaokeStyle: "glow",
      karaokeIntensity: 0.85,
      backgroundMode: "blurred-artwork",
      backgroundIntensity: 0.85,
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
      karaokeStyle: "gradient",
      backgroundMode: "gradient",
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
      karaokeStyle: "gradient",
      backgroundMode: "gradient",
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
      karaokeStyle: "glow",
      karaokeIntensity: 1,
      activeWordScale: 1.16,
      backgroundMode: "visualizer",
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
      karaokeStyle: "glow",
      karaokeIntensity: 1,
      activeWordScale: 1.16,
      backgroundMode: "visualizer",
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
      karaokeStyle: "minimal",
      karaokeIntensity: 0.3,
      activeWordScale: 1,
      backgroundMode: "solid",
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
      karaokeStyle: "minimal",
      karaokeIntensity: 0.3,
      activeWordScale: 1,
      backgroundMode: "solid",
    }
  ),
]);

const BUILT_IN_PROFILE_IDS = new Set(BUILT_IN_NOW_PLAYING_PROFILES.map(profile => profile.id));

export function createDefaultNowPlayingProfilesSettings(): NowPlayingProfilesSettings {
  return {
    version: NOW_PLAYING_PROFILES_VERSION,
    activeProfileId: DEFAULT_NOW_PLAYING_PROFILE_ID,
    customProfiles: [],
    contextSwitching: {
      enabled: false,
      windowedProfileId: DEFAULT_NOW_PLAYING_PROFILE_ID,
      fullscreenProfileId: DEFAULT_NOW_PLAYING_PROFILE_ID,
    },
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

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const FONT_IDS = new Set(FONT_OPTIONS.map(option => option.id));

/** "" inherits the app font; unknown ids (newer builds, hand edits) degrade to inherit. */
function cleanFontId(value: unknown): string {
  return typeof value === "string" && FONT_IDS.has(value) ? value : "";
}

/** Only plain #rrggbb colors are ever persisted; anything else inherits the theme. */
function cleanColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

const ARTWORK_SLOTS: readonly NowPlayingArtworkSlot[] = ["left", "right"];
const METADATA_SLOTS: readonly NowPlayingMetadataSlot[] = ["artwork", "top"];
const LYRICS_ALIGNMENTS: readonly NowPlayingLyricsAlignment[] = ["left", "center"];
const KARAOKE_STYLES: readonly NowPlayingKaraokeStyle[] = [
  "sweep",
  "solid",
  "gradient",
  "glow",
  "minimal",
];
const BACKGROUND_MODES: readonly NowPlayingBackgroundMode[] = [
  "fluid",
  "blurred-artwork",
  "gradient",
  "solid",
  "particles",
  "visualizer",
];

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
      // 720 is the rendered floor (--np-lyrics-max-width clamps to it in CSS);
      // allowing lower values would store settings that can never render.
      clampNumber(source.lyricsMaxWidth, fallback.lyricsMaxWidth, 720, 1280)
    ),
    spacingScale: clampNumber(source.spacingScale, fallback.spacingScale, 0.8, 1.25),
    artworkSlot: cleanEnum(source.artworkSlot, ARTWORK_SLOTS, fallback.artworkSlot),
    metadataSlot: cleanEnum(source.metadataSlot, METADATA_SLOTS, fallback.metadataSlot),
    metadataVisible: cleanBoolean(source.metadataVisible, fallback.metadataVisible),
    dockVisible: cleanBoolean(source.dockVisible, fallback.dockVisible),
    controlsVisible: cleanBoolean(source.controlsVisible, fallback.controlsVisible),
    lyricsAlignment: cleanEnum(
      source.lyricsAlignment,
      LYRICS_ALIGNMENTS,
      fallback.lyricsAlignment
    ),
    fontId: cleanFontId(source.fontId),
    translationFontId: cleanFontId(source.translationFontId),
    romanizationFontId: cleanFontId(source.romanizationFontId),
    lyricsWeight:
      Number(source.lyricsWeight) === 0 || source.lyricsWeight === undefined
        ? fallback.lyricsWeight
        : Math.round(clampNumber(source.lyricsWeight, fallback.lyricsWeight, 300, 900) / 10) * 10,
    lineSpacingScale: clampNumber(source.lineSpacingScale, fallback.lineSpacingScale, 0.85, 1.4),
    letterSpacingEm: clampNumber(source.letterSpacingEm, fallback.letterSpacingEm, -0.02, 0.08),
    activeColor: cleanColor(source.activeColor),
    inactiveColor: cleanColor(source.inactiveColor),
    inactiveOpacityScale: clampNumber(
      source.inactiveOpacityScale,
      fallback.inactiveOpacityScale,
      0.4,
      1.6
    ),
    activeLineScale: clampNumber(source.activeLineScale, fallback.activeLineScale, 0.9, 1.2),
    inactiveBlurPx: clampNumber(source.inactiveBlurPx, fallback.inactiveBlurPx, 0, 6),
    karaokeStyle: cleanEnum(source.karaokeStyle, KARAOKE_STYLES, fallback.karaokeStyle),
    karaokeIntensity: clampNumber(source.karaokeIntensity, fallback.karaokeIntensity, 0, 1),
    activeWordScale: clampNumber(source.activeWordScale, fallback.activeWordScale, 1, 1.2),
    backgroundMode: cleanEnum(source.backgroundMode, BACKGROUND_MODES, fallback.backgroundMode),
    backgroundIntensity: clampNumber(
      source.backgroundIntensity,
      fallback.backgroundIntensity,
      0.2,
      1
    ),
    backgroundBlurPx: clampNumber(source.backgroundBlurPx, fallback.backgroundBlurPx, 0, 60),
    effectSpeed: clampNumber(source.effectSpeed, fallback.effectSpeed, 0.25, 2),
    effectDensity: clampNumber(source.effectDensity, fallback.effectDensity, 0.25, 1.5),
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

  const rawContext = isRecord(input.contextSwitching) ? input.contextSwitching : {};
  const contextId = (value: unknown) => {
    const id = cleanProfileId(value);
    return id && usedIds.has(id) ? id : activeProfileId;
  };

  return {
    version: NOW_PLAYING_PROFILES_VERSION,
    activeProfileId,
    customProfiles,
    contextSwitching: {
      enabled: cleanBoolean(rawContext.enabled, false),
      windowedProfileId: contextId(rawContext.windowedProfileId),
      fullscreenProfileId: contextId(rawContext.fullscreenProfileId),
    },
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

/**
 * The profile that actually drives a surface: the context-specific one when context
 * switching is enabled, otherwise the single active profile. Always resolves to a
 * valid profile, so the view never renders without one.
 */
export function getEffectiveNowPlayingProfile(
  settings: NowPlayingProfilesSettings | null | undefined,
  fullscreen: boolean
): NowPlayingProfile {
  const context = settings?.contextSwitching;
  if (context?.enabled) {
    return getNowPlayingProfile(
      settings,
      fullscreen ? context.fullscreenProfileId : context.windowedProfileId
    );
  }
  return getActiveNowPlayingProfile(settings);
}

export function resolveNowPlayingProfileConfig(
  settings: NowPlayingProfilesSettings | null | undefined,
  fullscreen: boolean
): NowPlayingProfileConfig {
  const profile = getEffectiveNowPlayingProfile(settings, fullscreen);
  return fullscreen ? profile.fullscreen : profile.windowed;
}

export function cloneNowPlayingProfile(profile: NowPlayingProfile): NowPlayingProfile {
  return structuredClone(profile);
}

/** Collision-resistant-enough id for a user profile; uniqueness is enforced on save. */
export function createCustomNowPlayingProfileId(): string {
  return `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/* ------------------------------------------------------------- import / export */

export const NOW_PLAYING_PROFILE_EXPORT_KIND = "cadence-now-playing-profile";

/** Versioned envelope so a pasted settings blob or foreign JSON is rejected, not guessed at. */
/**
 * Generation key for the profile values the lyrics renderer reads into JS once and
 * caches (karaoke swipe/glow switches, glow radius, letter emphasis, active-line
 * scale). Pure-CSS profile values (fonts, colours, sizes) follow inherited CSS
 * variables live, but the cached ones only
 * re-read when a theme is applied — so Cadence folds this key into the theme string:
 * when it changes, the theme is reapplied and the renderer drops its style caches.
 * Stable for equal inputs; any engine-read change produces a different key.
 */
export function getNowPlayingAnimationCacheKey(config: NowPlayingProfileConfig): string {
  const num = (value: number) => Math.round(value * 1000) / 1000;
  return [
    config.karaokeStyle,
    num(config.karaokeIntensity),
    num(config.activeWordScale),
    num(config.activeLineScale),
  ].join("|");
}

export function serializeNowPlayingProfile(profile: NowPlayingProfile): string {
  const { builtIn: _builtIn, ...rest } = cloneNowPlayingProfile(profile);
  return JSON.stringify(
    { kind: NOW_PLAYING_PROFILE_EXPORT_KIND, version: NOW_PLAYING_PROFILES_VERSION, profile: rest },
    null,
    2
  );
}

export type NowPlayingProfileParseResult =
  | { ok: true; profile: NowPlayingProfile }
  | { ok: false; error: string };

/**
 * Parses an exported profile. The payload is data only: it is normalized field by field
 * (unknown fields dropped, numbers clamped, enums checked) and never evaluated.
 */
export function parseNowPlayingProfileJson(text: string): NowPlayingProfileParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, error: "Expected a Cadence profile file." };
  if (parsed.kind !== NOW_PLAYING_PROFILE_EXPORT_KIND) {
    return { ok: false, error: "That JSON is not a Cadence Now Playing profile." };
  }
  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: "This profile file has no readable version." };
  }
  if (version > NOW_PLAYING_PROFILES_VERSION) {
    return {
      ok: false,
      error: `This profile was made by a newer Cadence (format v${version}). Update Cadence to import it.`,
    };
  }
  const profile = normalizeNowPlayingProfile(parsed.profile, false);
  if (!profile) return { ok: false, error: "The profile inside this file is missing or invalid." };
  return { ok: true, profile };
}
