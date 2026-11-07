/**
 * Smart playlist rules: normalization, descriptions, and live evaluation against a track list.
 * Pure and dependency-free so the library core, the renderer, and unit tests all share one
 * definition of what each rule means. Written for Cadence.
 */

import type { SmartPlaylistPreset, SmartPlaylistRule } from "./types";

/** The smallest track shape a smart rule can be evaluated against. */
export interface SmartPlaylistTrack {
  id: number;
  title: string;
  artist: string;
  albumArtist: string;
  genre: string;
  favorite: boolean;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
}

export interface SmartPlaylistPresetInfo {
  label: string;
  description: string;
  needsValue: boolean;
  valueLabel: string;
}

export const SMART_PLAYLIST_PRESETS: Record<SmartPlaylistPreset, SmartPlaylistPresetInfo> = {
  favorites: {
    label: "Liked songs",
    description: "Every song you have hearted.",
    needsValue: false,
    valueLabel: "",
  },
  "recently-added": {
    label: "Recently added",
    description: "Newest additions to your library first.",
    needsValue: false,
    valueLabel: "",
  },
  "recently-played": {
    label: "Recently played",
    description: "Songs you played most recently first.",
    needsValue: false,
    valueLabel: "",
  },
  "most-played": {
    label: "Most played",
    description: "Your highest play counts first.",
    needsValue: false,
    valueLabel: "",
  },
  "never-played": {
    label: "Never played",
    description: "Songs in your library you have not played yet.",
    needsValue: false,
    valueLabel: "",
  },
  genre: {
    label: "Genre",
    description: "Songs whose genre tag matches your text.",
    needsValue: true,
    valueLabel: "Genre",
  },
  artist: {
    label: "Artist",
    description: "Songs by an artist whose name matches your text.",
    needsValue: true,
    valueLabel: "Artist",
  },
};

const PRESET_KEYS = new Set<string>(Object.keys(SMART_PLAYLIST_PRESETS));

export function isSmartPlaylistPreset(value: unknown): value is SmartPlaylistPreset {
  return typeof value === "string" && PRESET_KEYS.has(value);
}

/** Returns a safe copy of a rule, or `null` when the rule cannot mean anything. */
export function normalizeSmartPlaylistRule(rule: unknown): SmartPlaylistRule | null {
  if (!rule || typeof rule !== "object") return null;
  const candidate = rule as Partial<SmartPlaylistRule>;
  if (!isSmartPlaylistPreset(candidate.preset)) return null;
  const info = SMART_PLAYLIST_PRESETS[candidate.preset];
  const normalized: SmartPlaylistRule = { preset: candidate.preset };
  if (info.needsValue) {
    const value = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (!value) return null;
    normalized.value = value;
  }
  if (typeof candidate.limit === "number" && Number.isFinite(candidate.limit)) {
    normalized.limit = Math.min(1000, Math.max(1, Math.floor(candidate.limit)));
  }
  return normalized;
}

export function describeSmartPlaylistRule(rule: SmartPlaylistRule): string {
  const info = SMART_PLAYLIST_PRESETS[rule.preset];
  const base = info.needsValue && rule.value ? `${info.label}: ${rule.value}` : info.label;
  return rule.limit ? `${base} · up to ${rule.limit} songs` : base;
}

function byTitle(a: SmartPlaylistTrack, b: SmartPlaylistTrack): number {
  return a.title.localeCompare(b.title) || a.id - b.id;
}

function genreMatches(genre: string, needle: string): boolean {
  const target = needle.toLocaleLowerCase();
  if (!target) return false;
  if (genre.toLocaleLowerCase().includes(target)) return true;
  return genre
    .split(/[,;/]/)
    .map(token => token.trim().toLocaleLowerCase())
    .some(token => token === target);
}

/**
 * Evaluates a rule against the current library and returns matching track ids in the
 * preset's order. Invalid rules (for example a genre rule with no genre) match nothing.
 */
export function evaluateSmartPlaylist(
  tracks: readonly SmartPlaylistTrack[],
  rule: SmartPlaylistRule,
): number[] {
  const normalized = normalizeSmartPlaylistRule(rule);
  if (!normalized) return [];
  const value = normalized.value?.toLocaleLowerCase() ?? "";
  let matched: SmartPlaylistTrack[];
  switch (normalized.preset) {
    case "favorites":
      matched = tracks.filter(track => track.favorite).sort(byTitle);
      break;
    case "recently-added":
      matched = [...tracks].sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
      break;
    case "recently-played":
      matched = tracks
        .filter(track => track.lastPlayedAt !== null && track.lastPlayedAt > 0)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || byTitle(a, b));
      break;
    case "most-played":
      matched = tracks
        .filter(track => track.playCount > 0)
        .sort(
          (a, b) =>
            b.playCount - a.playCount ||
            (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) ||
            byTitle(a, b),
        );
      break;
    case "never-played":
      matched = tracks
        .filter(track => track.playCount <= 0 && (track.lastPlayedAt === null || track.lastPlayedAt <= 0))
        .sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
      break;
    case "genre":
      matched = tracks.filter(track => genreMatches(track.genre, value)).sort(byTitle);
      break;
    case "artist":
      matched = tracks
        .filter(
          track =>
            track.artist.toLocaleLowerCase().includes(value) ||
            track.albumArtist.toLocaleLowerCase().includes(value),
        )
        .sort(byTitle);
      break;
  }
  const limited = normalized.limit ? matched.slice(0, normalized.limit) : matched;
  return limited.map(track => track.id);
}
