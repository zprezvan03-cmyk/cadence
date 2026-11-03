/**
 * Runtime-agnostic Cadence settings store core.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import type { AppSettings, DeepPartial } from "../shared/types";
import { DEFAULT_FONT_ID } from "../shared/fonts";
import { DEFAULT_PROVIDER_ORDER, migrateProviderOrder } from "../shared/upstream/better-lyrics/constants";
import { DEFAULT_GRADIENT_SETTINGS } from "../shared/upstream/shaders/gradientSettings";
import {
  createDefaultNowPlayingProfilesSettings,
  normalizeNowPlayingProfilesSettings,
} from "../shared/nowPlayingProfiles";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  playback: {
    volume: 0.85,
    muted: false,
    shuffle: false,
    repeat: "off",
    playbackRate: 1,
    resumeOnLaunch: true,
    crossfadeSeconds: 0,
    gaplessPlayback: false,
    replayGainMode: "off",
    replayGainPreampDb: 0,
    replayGainPreventClipping: true,
    equalizer: {
      enabled: false,
      preampDb: 0,
      bandsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      presetId: "flat",
    },
  },
  appearance: {
    accent: "#ff3d71",
    reduceMotion: false,
    compactSidebar: false,
    compactSidebarHoverExpand: true,
    blurArtwork: true,
    fontFamily: DEFAULT_FONT_ID,
  },
  lyrics: {
    providerOrder: [...DEFAULT_PROVIDER_ORDER],
    autoFetch: true,
    notFoundCooldownDays: 7,
    fetchConcurrency: "balanced",
    offsetMs: 0,
    translationLanguage: "",
    romanization: false,
    themeId: "default",
    customThemeCss: "",
    fontSizeRem: 3,
    fontWeight: 700,
    lineHeight: 1.333,
    translationFontSizePx: 32,
    romanizationFontSizePx: 26,
    activeOpacity: 1,
    inactiveOpacity: 0.3,
    targetScrollRatio: 0.5,
    showCredits: true,
    hideInstrumentalOnly: false,
    passiveScroll: true,
    fullscreenOnOpen: false,
    showLyricsInFullscreen: true,
  },
  nowPlayingProfiles: createDefaultNowPlayingProfilesSettings(),
  shaders: {
    ...DEFAULT_GRADIENT_SETTINGS,
    performanceMode: "balanced",
  },
  advanced: {
    showLogs: false,
  },
  general: {
    onboardingCompleted: false,
    onboardingStep: 0,
  },
  scrobbling: {
    enabled: false,
    apiKey: "",
    apiSecret: "",
    sessionKey: "",
    username: "",
  },
  youtubeMusic: {
    visitorData: null,
    gl: "US",
    hl: "en",
    accountName: null,
  },
};

type AnyRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const result: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as AnyRecord)[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? mergeSettings(current, value) : value;
  }
  return result as T;
}

/** Clamps bounded settings fields; applied on load and on every patch. */
function normalizeSettings(settings: AppSettings): AppSettings {
  const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  const playback = isPlainObject(settings.playback)
    ? settings.playback
    : structuredClone(DEFAULT_SETTINGS.playback);
  const equalizer = isPlainObject(playback.equalizer)
    ? playback.equalizer
    : structuredClone(DEFAULT_SETTINGS.playback.equalizer);
  playback.crossfadeSeconds = clampNumber(playback.crossfadeSeconds, 0, 0, 12);
  playback.gaplessPlayback = Boolean(playback.gaplessPlayback);
  if (!["off", "track", "album"].includes(playback.replayGainMode)) {
    playback.replayGainMode = DEFAULT_SETTINGS.playback.replayGainMode;
  }
  playback.replayGainPreampDb = clampNumber(playback.replayGainPreampDb, 0, -12, 12);
  playback.replayGainPreventClipping =
    typeof playback.replayGainPreventClipping === "boolean"
      ? playback.replayGainPreventClipping
      : DEFAULT_SETTINGS.playback.replayGainPreventClipping;
  playback.equalizer = {
    enabled: Boolean(equalizer.enabled),
    preampDb: clampNumber(equalizer.preampDb, 0, -12, 12),
    bandsDb: Array.from({ length: 10 }, (_, index) =>
      clampNumber(Array.isArray(equalizer.bandsDb) ? equalizer.bandsDb[index] : 0, 0, -12, 12)
    ),
    presetId:
      typeof equalizer.presetId === "string" && equalizer.presetId.trim()
        ? equalizer.presetId.trim().slice(0, 64)
        : DEFAULT_SETTINGS.playback.equalizer.presetId,
  };
  settings.playback = playback as AppSettings["playback"];

  settings.lyrics.providerOrder = migrateProviderOrder(settings.lyrics.providerOrder);
  const cooldown = Number(settings.lyrics.notFoundCooldownDays);
  settings.lyrics.notFoundCooldownDays = Number.isFinite(cooldown)
    ? Math.min(30, Math.max(1, Math.round(cooldown)))
    : DEFAULT_SETTINGS.lyrics.notFoundCooldownDays;
  if (!["low", "balanced", "high"].includes(settings.lyrics.fetchConcurrency)) {
    settings.lyrics.fetchConcurrency = DEFAULT_SETTINGS.lyrics.fetchConcurrency;
  }
  const step = Number(settings.general?.onboardingStep);
  settings.general = {
    onboardingCompleted: Boolean(settings.general?.onboardingCompleted),
    onboardingStep: Number.isFinite(step) ? Math.min(4, Math.max(0, Math.round(step))) : 0,
  };
  settings.nowPlayingProfiles = normalizeNowPlayingProfilesSettings(settings.nowPlayingProfiles);
  const scrobblingSource: AnyRecord = isPlainObject(settings.scrobbling) ? settings.scrobbling : {};
  const credential = (value: unknown): string =>
    typeof value === "string" ? value.trim().slice(0, 256) : "";
  settings.scrobbling = {
    enabled: Boolean(scrobblingSource.enabled),
    apiKey: credential(scrobblingSource.apiKey),
    apiSecret: credential(scrobblingSource.apiSecret),
    sessionKey: credential(scrobblingSource.sessionKey),
    username: credential(scrobblingSource.username),
  };
  // The Data API catalog was removed from the product. Drop the legacy section (including any
  // stored API key) instead of carrying an unused credential in the active settings schema.
  delete (settings as unknown as AnyRecord).youtubeCatalog;
  // YouTube Music session settings are rebuilt field-by-field: anything else a hand-edited or
  // smuggled settings file carries under `youtubeMusic` (e.g. an account cookie) is dropped.
  // The cookie of a connected account lives ONLY in the OS secret store, never in this JSON.
  const ytmSource: AnyRecord = isPlainObject(settings.youtubeMusic) ? settings.youtubeMusic : {};
  const ytmDefaults = DEFAULT_SETTINGS.youtubeMusic;
  const locale = (value: unknown, fallback: string): string =>
    typeof value === "string" && /^[A-Za-z_-]{2,8}$/.test(value) ? value : fallback;
  settings.youtubeMusic = {
    visitorData:
      typeof ytmSource.visitorData === "string" && /^Cg[t|s]/.test(ytmSource.visitorData)
        ? ytmSource.visitorData
        : null,
    gl: locale(ytmSource.gl, ytmDefaults.gl),
    hl: locale(ytmSource.hl, ytmDefaults.hl),
    accountName:
      typeof ytmSource.accountName === "string" && ytmSource.accountName.trim()
        ? ytmSource.accountName.trim().slice(0, 64)
        : null,
  };
  return settings;
}

export function parseSettingsJson(rawJson: string | null | undefined): AppSettings {
  let settings: AppSettings;
  if (!rawJson) {
    settings = structuredClone(DEFAULT_SETTINGS);
  } else {
    try {
      const parsed = JSON.parse(rawJson);
      settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed);
    } catch (error) {
      console.warn("[Cadence] Settings file is unreadable, using defaults:", error);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }
  return normalizeSettings(settings);
}

export interface SettingsPersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export class SettingsCore {
  private settings: AppSettings;

  constructor(private readonly persistence: SettingsPersistence = {}) {
    this.settings = parseSettingsJson(persistence.initialJson);
  }

  get(): AppSettings {
    return this.settings;
  }

  patch(patch: DeepPartial<AppSettings>): AppSettings {
    this.settings = normalizeSettings(mergeSettings(this.settings, patch));
    this.save();
    return this.settings;
  }

  reset(): AppSettings {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.save();
    return this.settings;
  }

  save(): void {
    if (!this.persistence.persist) return;
    try {
      const result = this.persistence.persist(JSON.stringify(this.settings, null, 2));
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(error => {
          console.error("[Cadence] Failed to persist settings:", error);
        });
      }
    } catch (error) {
      console.error("[Cadence] Failed to persist settings:", error);
    }
  }
}
