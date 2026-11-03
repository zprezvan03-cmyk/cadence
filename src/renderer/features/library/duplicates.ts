/**
 * Likely-duplicate detection for the library tools panel. This is a review helper, not a
 * proof of identical audio: tracks are grouped when their normalized title and artist match
 * and their durations are within a small tolerance. Nothing here deletes or moves files —
 * the UI only helps the user review copies and choose what to do outside Cadence.
 * Written for Cadence.
 */

import type { Track } from "../../../shared/types";

export interface DuplicateGroup {
  id: string;
  title: string;
  artist: string;
  tracks: Track[];
  keeperId: number;
  totalBytes: number;
  reclaimableBytes: number;
}

export interface DuplicateOptions {
  durationToleranceSeconds?: number;
}

const FEATURING_BRACKET = /\s*[\[(][^\])]*\b(?:feat\.?|featuring|ft\.)\b[^\])]*[\])]/gi;
const FEATURING_SUFFIX = /\s+\b(?:feat\.?|featuring|ft\.)\b.*$/i;

/** Normalizes a title/artist for duplicate comparison without erasing version words like “live”. */
export function normalizeDuplicateText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(FEATURING_BRACKET, " ")
    .replace(FEATURING_SUFFIX, " ")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function codecScore(track: Track): number {
  const codec = `${track.codec} ${track.container}`.toLocaleLowerCase();
  if (/(flac|alac|wav|aiff|pcm)/.test(codec)) return 400;
  if (/opus/.test(codec)) return 220;
  if (/(aac|mp4|m4a)/.test(codec)) return 180;
  if (/mp3|mpeg/.test(codec)) return 140;
  if (/ogg|vorbis/.test(codec)) return 160;
  return 80;
}

function bitrateScore(track: Track): number {
  let kbps = 0;
  if (track.bitrate && track.bitrate > 0) {
    kbps = track.bitrate > 10000 ? track.bitrate / 1000 : track.bitrate;
  } else if (track.duration > 0 && track.fileSize > 0) {
    kbps = (track.fileSize * 8) / track.duration / 1000;
  }
  return Math.min(kbps, 1600) / 4;
}

/**
 * Higher is a better copy to keep: audio quality first, then the user's own signals
 * (favourite, plays, saved edits, lyrics) so the recommendation never throws away the
 * copy that carries the user's data just because another file is slightly larger.
 */
export function duplicateKeeperScore(track: Track): number {
  let score = codecScore(track) + bitrateScore(track);
  if (track.sampleRate) score += Math.min(track.sampleRate / 1000, 192);
  if ((track.channels ?? 0) >= 2) score += 10;
  if (track.favorite) score += 250;
  if (track.metadataEdited) score += 120;
  score += Math.min(Math.max(track.playCount, 0) * 2, 100);
  if (track.hasEmbeddedLyrics || track.hasSidecarLyrics) score += 20;
  if (track.artworkUrl) score += 10;
  score += Math.min(Math.max(track.duration, 0), 600) / 60;
  return score;
}

export function findDuplicateGroups(
  tracks: readonly Track[],
  options: DuplicateOptions = {},
): DuplicateGroup[] {
  const tolerance = Math.max(0, options.durationToleranceSeconds ?? 2);
  const byKey = new Map<string, Track[]>();
  for (const track of tracks) {
    const title = normalizeDuplicateText(track.title);
    const artist = normalizeDuplicateText(track.artist || track.albumArtist);
    if (!title || !artist) continue;
    const key = `${title}\u0000${artist}`;
    const existing = byKey.get(key);
    if (existing) existing.push(track);
    else byKey.set(key, [track]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, candidates] of byKey) {
    if (candidates.length < 2) continue;
    const sortedByDuration = [...candidates].sort((a, b) => a.duration - b.duration || a.id - b.id);
    let cluster: Track[] = [];
    let anchorDuration = 0;
    const flush = () => {
      if (cluster.length < 2) return;
      const ranked = [...cluster].sort(
        (a, b) =>
          duplicateKeeperScore(b) - duplicateKeeperScore(a) ||
          b.fileSize - a.fileSize ||
          a.path.localeCompare(b.path),
      );
      const keeper = ranked[0];
      const totalBytes = ranked.reduce((sum, track) => sum + Math.max(0, track.fileSize), 0);
      groups.push({
        id: `${key}\u0000${Math.round(anchorDuration)}`,
        title: keeper.title,
        artist: keeper.artist,
        tracks: ranked,
        keeperId: keeper.id,
        totalBytes,
        reclaimableBytes: Math.max(0, totalBytes - Math.max(0, keeper.fileSize)),
      });
    };
    for (const track of sortedByDuration) {
      if (cluster.length === 0) {
        cluster = [track];
        anchorDuration = track.duration;
      } else if (Math.abs(track.duration - anchorDuration) <= tolerance) {
        cluster.push(track);
      } else {
        flush();
        cluster = [track];
        anchorDuration = track.duration;
      }
    }
    flush();
  }

  return groups.sort(
    (a, b) => b.reclaimableBytes - a.reclaimableBytes || a.title.localeCompare(b.title),
  );
}

export function formatFileSize(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}
