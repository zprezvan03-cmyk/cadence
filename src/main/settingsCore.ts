/**
 * Runtime-agnostic Cadence settings store core.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import type { AppSettings, DeepPartial } from "../shared/types";
import { DEFAULT_FONT_ID, normalizeFontId } from "../shared/fonts";
import { DEFAULT_PROVIDER_ORDER, migrateProviderOrder } from "../shared/upstream/better-lyrics/constants";
import { DEFAULT_GRADIENT_SETTINGS } from "../shared/upstream/shaders/gradientSettings";
import {
  createDefaultNowPlayingProfilesSettings,
  normalizeNowPlayingProfilesSettings,
} from "../shared/nowPlayingProfiles";
import {
  DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER,
  normalizeArtistImageProviderOrder,
} from "../shared/artistImageProviders";

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
    shuffleMode: "smart",
    autoPlay: true,
    smartShufflePopularity: true,
    showRemainingTime: false,
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
    aiTranslation: {
      enabled: false, protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", chatPath: "/chat/completions",
      modelsPath: "/models", apiKey: "", model: "", temperature: 0.25, maxOutputTokens: 4096, timeoutMs: 60000,
      targetLanguage: "en", customHeaders: "{}",
    },
    aiRomanization: {
      enabled: false, protocol: "ollama-native", baseUrl: "http://localhost:11434", chatPath: "/api/chat", modelsPath: "/api/tags",
      apiKey: "", model: "", temperature: 0.1, maxOutputTokens: 4096, timeoutMs: 120000,
      romanizationStandard: "auto", customHeaders: "{}",
    },
    providerOrder: [...DEFAULT_PROVIDER_ORDER],
    autoFetch: true,
    notFoundCooldownDays: 7,
    fetchConcurrency: "balanced",
    offsetMs: 0,
    translationLanguage: "",
    romanization: false,
    romanizationMode: "line",
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
  mvBackground: { enabled: false, scrimOpacity: 0.45, bindings: {} },
  nowPlayingProfiles: createDefaultNowPlayingProfilesSettings(),
  shaders: {
    ...DEFAULT_GRADIENT_SETTINGS,
    performanceMode: "balanced",
  },
  artistImages: {
    enabled: true,
    autoFetch: true,
    providerOrder: [...DEFAULT_ARTIST_IMAGE_PROVIDER_ORDER],
    refreshAfterDays: 30,
  },
  home: {
    featuredSeed: null,
    featuredSeedDay: null,
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
function normalizeSettings(settings: AppSettings, rawProfiles: unknown = settings.nowPlayingProfiles): AppSettings {
  const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  // Patches may share unchanged subtrees with the last committed snapshot.
  const playback = isPlainObject(settings.playback)
    ? { ...settings.playback }
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
  playback.shuffleMode =
    playback.shuffleMode === "classic" || playback.shuffleMode === "smart"
      ? playback.shuffleMode
      : (DEFAULT_SETTINGS.playback.shuffleMode ?? "smart");
  playback.autoPlay =
    typeof playback.autoPlay === "boolean"
      ? playback.autoPlay
      : (DEFAULT_SETTINGS.playback.autoPlay ?? true);
  playback.smartShufflePopularity =
    typeof playback.smartShufflePopularity === "boolean"
      ? playback.smartShufflePopularity
      : (DEFAULT_SETTINGS.playback.smartShufflePopularity ?? true);
  playback.showRemainingTime =
    typeof playback.showRemainingTime === "boolean" ? playback.showRemainingTime : false;
  settings.playback = playback as AppSettings["playback"];

  // Font ids are family names read from the platform font store, plus the two built-in presets.
  // Normalize on every load/patch so a legacy id, a corrupt value or a font that was uninstalled
  // resolves to a usable stack instead of leaving the document unstyled.
  const appearance = isPlainObject(settings.appearance)
    ? { ...settings.appearance }
    : { ...DEFAULT_SETTINGS.appearance };
  appearance.fontFamily = normalizeFontId(appearance.fontFamily);
  settings.appearance = appearance as AppSettings["appearance"];

  const normalizeAi = (candidate: unknown, fallback: AppSettings["lyrics"]["aiTranslation"]): AppSettings["lyrics"]["aiTranslation"] => {
    const source = isPlainObject(candidate) ? candidate : {};
    const text = (value: unknown, defaultValue: string, limit = 2048) => typeof value === "string" ? value.trim().slice(0, limit) : defaultValue;
    return {
      ...fallback,
      enabled: Boolean(source.enabled),
      protocol: source.protocol === "ollama-native" ? "ollama-native" : "openai-compatible",
      baseUrl: text(source.baseUrl, fallback.baseUrl), chatPath: text(source.chatPath, fallback.chatPath, 256),
      modelsPath: text(source.modelsPath, fallback.modelsPath, 256), apiKey: text(source.apiKey, "", 4096),
      model: text(source.model, "", 256), customHeaders: text(source.customHeaders, "{}", 8192),
      temperature: clampNumber(source.temperature, fallback.temperature, 0, 2),
      maxOutputTokens: Math.round(clampNumber(source.maxOutputTokens, fallback.maxOutputTokens, 1, 32768)),
      timeoutMs: Math.round(clampNumber(source.timeoutMs, fallback.timeoutMs, 1000, 300000)),
      ...(fallback.targetLanguage !== undefined ? { targetLanguage: text(source.targetLanguage, fallback.targetLanguage, 32) } : {}),
      ...(fallback.romanizationStandard !== undefined ? { romanizationStandard: text(source.romanizationStandard, fallback.romanizationStandard, 80) } : {}),
    };
  };
  settings.lyrics = { ...settings.lyrics };
  settings.lyrics.aiTranslation = normalizeAi(settings.lyrics.aiTranslation, DEFAULT_SETTINGS.lyrics.aiTranslation);
  settings.lyrics.aiRomanization = normalizeAi(settings.lyrics.aiRomanization, DEFAULT_SETTINGS.lyrics.aiRomanization);
  settings.lyrics.providerOrder = migrateProviderOrder(settings.lyrics.providerOrder);
  if (settings.lyrics.romanizationMode !== "line" && settings.lyrics.romanizationMode !== "word") settings.lyrics.romanizationMode = "line";
  const cooldown = Number(settings.lyrics.notFoundCooldownDays);
  settings.lyrics.notFoundCooldownDays = Number.isFinite(cooldown)
    ? Math.min(30, Math.max(1, Math.round(cooldown)))
    : DEFAULT_SETTINGS.lyrics.notFoundCooldownDays;
  if (!["low", "balanced", "high"].includes(settings.lyrics.fetchConcurrency)) {
    settings.lyrics.fetchConcurrency = DEFAULT_SETTINGS.lyrics.fetchConcurrency;
  }
  const mvSource: AnyRecord = isPlainObject(settings.mvBackground) ? settings.mvBackground : {};
  const mvBindings: Record<string, string> = {};
  const rawBindings: AnyRecord = isPlainObject(mvSource.bindings) ? mvSource.bindings : {};
  for (const [key, value] of Object.entries(rawBindings)) {
    if (key && key.length <= 128 && typeof value === "string" && value.trim()) {
      mvBindings[key] = value.slice(0, 4096);
    }
  }
  settings.mvBackground = {
    enabled:
      typeof mvSource.enabled === "boolean" ? mvSource.enabled : DEFAULT_SETTINGS.mvBackground.enabled,
    scrimOpacity: clampNumber(mvSource.scrimOpacity, DEFAULT_SETTINGS.mvBackground.scrimOpacity, 0, 1),
    bindings: mvBindings,
  };
  const step = Number(settings.general?.onboardingStep);
  settings.general = {
    onboardingCompleted: Boolean(settings.general?.onboardingCompleted),
    onboardingStep: Number.isFinite(step) ? Math.min(3, Math.max(0, Math.round(step))) : 0,
  };
  settings.nowPlayingProfiles = normalizeNowPlayingProfilesSettings(rawProfiles);
  const artistImageSource: AnyRecord = isPlainObject(settings.artistImages) ? settings.artistImages : {};
  settings.artistImages = {
    enabled:
      typeof artistImageSource.enabled === "boolean"
        ? artistImageSource.enabled
        : DEFAULT_SETTINGS.artistImages.enabled,
    autoFetch:
      typeof artistImageSource.autoFetch === "boolean"
        ? artistImageSource.autoFetch
        : DEFAULT_SETTINGS.artistImages.autoFetch,
    providerOrder: normalizeArtistImageProviderOrder(
      Array.isArray(artistImageSource.providerOrder)
        ? artistImageSource.providerOrder.filter((entry): entry is string => typeof entry === "string")
        : undefined
    ),
    refreshAfterDays: Math.round(
      clampNumber(artistImageSource.refreshAfterDays, DEFAULT_SETTINGS.artistImages.refreshAfterDays, 0, 365)
    ),
  };
  const homeSource: AnyRecord = isPlainObject(settings.home) ? settings.home : {};
  const featuredSeed = Number(homeSource.featuredSeed);
  settings.home = {
    featuredSeed:
      homeSource.featuredSeed === null ||
      homeSource.featuredSeed === undefined ||
      !Number.isFinite(featuredSeed)
        ? null
        : Math.abs(Math.trunc(featuredSeed)) % 0x100000000,
    featuredSeedDay:
      typeof homeSource.featuredSeedDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(homeSource.featuredSeedDay)
        ? homeSource.featuredSeedDay
        : null,
  };
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
  return settings;
}

export function parseSettingsJson(rawJson: string | null | undefined): AppSettings {
  let settings: AppSettings;
  let rawProfiles: unknown;
  if (!rawJson) {
    settings = structuredClone(DEFAULT_SETTINGS);
  } else {
    try {
      const parsed = JSON.parse(rawJson);
      settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed);
      // Normalize the raw profile subtree so a default id cannot mask a missing legacy field.
      rawProfiles = parsed?.nowPlayingProfiles;
    } catch (error) {
      console.warn("[Cadence] Settings file is unreadable, using defaults:", error);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }
  return normalizeSettings(settings, rawProfiles);
}

export interface SettingsPersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export class SettingsCore {
  private settings: AppSettings;
  private pendingWrite = Promise.resolve();

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

  /** The desktop bridge confirms a change only after its atomic write succeeds. Queue writes
   * so a concurrent transport update cannot overwrite a Studio save with an older snapshot. */
  patchAndPersist(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    return this.commit(() => normalizeSettings(mergeSettings(this.settings, patch)));
  }

  resetAndPersist(): Promise<AppSettings> {
    return this.commit(() => structuredClone(DEFAULT_SETTINGS));
  }

  private commit(update: () => AppSettings): Promise<AppSettings> {
    const write = this.pendingWrite.then(async () => {
      const next = update();
      await this.persistence.persist?.(JSON.stringify(next, null, 2));
      this.settings = next;
      return next;
    });
    this.pendingWrite = write.then(() => undefined, () => undefined);
    return write;
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
