/**
 * Cadence settings persistence. Written for Cadence; the shader defaults come from the ported
 * upstream `DEFAULT_GRADIENT_SETTINGS` so a fresh install matches the extension's look.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, DeepPartial } from "../shared/types";
import { DEFAULT_FONT_ID } from "../shared/fonts";
import { DEFAULT_PROVIDER_ORDER } from "../shared/upstream/better-lyrics/constants";
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
    activeOpacity: 1,
    inactiveOpacity: 0.3,
    targetScrollRatio: 0.5,
    showCredits: true,
    hideInstrumentalOnly: false,
    passiveScroll: true,
    fullscreenOnOpen: false,
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

function merge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const result: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as AnyRecord)[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? merge(current, value) : value;
  }
  return result as T;
}

export class SettingsStore {
  private settings: AppSettings;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.settings = this.load();
  }

  private load(): AppSettings {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return merge(structuredClone(DEFAULT_SETTINGS), parsed);
    } catch (error) {
      console.warn("[Cadence] Settings file is unreadable, using defaults:", error);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): AppSettings {
    return this.settings;
  }

  patch(patch: DeepPartial<AppSettings>): AppSettings {
    this.settings = merge(this.settings, patch);
    this.save();
    return this.settings;
  }

  reset(): AppSettings {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.save();
    return this.settings;
  }

  save(): void {
    try {
      const temporary = `${this.filePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.settings, null, 2));
      renameSync(temporary, this.filePath);
    } catch (error) {
      console.error("[Cadence] Failed to persist settings:", error);
    }
  }
}
