/**
 * Runtime-agnostic Cadence settings store core.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import type { AppSettings, DeepPartial } from "../shared/types";
import { DEFAULT_FONT_ID } from "../shared/fonts";
import { DEFAULT_PROVIDER_ORDER, migrateProviderOrder } from "../shared/upstream/better-lyrics/constants";
import { DEFAULT_GRADIENT_SETTINGS } from "../shared/upstream/shaders/gradientSettings";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  playback: {
    volume: 0.85,
    muted: false,
    shuffle: false,
    repeat: "off",
    playbackRate: 1,
    resumeOnLaunch: true,
  },
  appearance: {
    accent: "#ff3d71",
    reduceMotion: false,
    compactSidebar: false,
    blurArtwork: true,
    fontFamily: DEFAULT_FONT_ID,
  },
  lyrics: {
    providerOrder: [...DEFAULT_PROVIDER_ORDER],
    autoFetch: true,
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
  shaders: {
    ...DEFAULT_GRADIENT_SETTINGS,
    performanceMode: "balanced",
  },
  advanced: {
    showLogs: false,
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
  settings.lyrics.providerOrder = migrateProviderOrder(settings.lyrics.providerOrder);
  return settings;
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
    this.settings = mergeSettings(this.settings, patch);
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
