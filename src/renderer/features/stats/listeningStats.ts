import { mediaItemFromHistoryPayload, trackSourceKey } from "../../../shared/media";
import type { HistoryEntry, MediaItem, Track, TrackSource } from "../../../shared/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankedHistoryTrack {
  source: TrackSource;
  sourceKey: string;
  /** Present only for local history; remote rankings never receive a fake library ID. */
  trackId: number | null;
  /** Replayable remote snapshot reconstructed from the history payload, when applicable. */
  mediaItem: MediaItem | null;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  artworkUrl: string | null;
  duration: number;
  playCount: number;
  lastPlayedAt: number;
  track: Track | null;
}

export interface RankedArtist {
  artist: string;
  playCount: number;
  uniqueTrackCount: number;
  lastPlayedAt: number;
  artworkUrl: string | null;
}

export interface RankedAlbum {
  key: string;
  album: string;
  albumArtist: string;
  playCount: number;
  uniqueTrackCount: number;
  lastPlayedAt: number;
  artworkUrl: string | null;
}

export interface RankedGenre {
  genre: string;
  playCount: number;
}

export interface DayPlayCount {
  dateKey: string;
  date: Date;
  count: number;
}

export interface ListeningStats {
  generatedAt: number;
  /** Play starts present in the capped persistent history. */
  historyPlayCount: number;
  /** Sum of the library's all-time per-track counters; can exceed the capped history. */
  libraryPlayCount: number;
  /** Sum of the durations of tracks that were started; history does not record partial listens. */
  startedTrackSeconds: number;
  uniqueTrackCount: number;
  uniqueArtistCount: number;
  playsLast7Days: number;
  playsLast30Days: number;
  currentStreakDays: number;
  topTracks: RankedHistoryTrack[];
  topArtists: RankedArtist[];
  topAlbums: RankedAlbum[];
  genres: RankedGenre[];
  playsByDay: DayPlayCount[];
  playsByHour: number[];
}

export interface DiscoveryTrack {
  track: Track;
  playCount: number;
  recentPlayCount: number;
  lastPlayedAt: number | null;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addLocalDays(dayStart: number, days: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function cleanText(value: string | null | undefined, fallback: string): string {
  const text = value?.trim();
  return text ? text : fallback;
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sortedEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries]
    .filter(entry => Number.isFinite(entry.playedAt))
    .sort((a, b) => b.playedAt - a.playedAt || b.id - a.id);
}

function byRankThenRecency<T extends { playCount: number; lastPlayedAt: number }>(
  a: T,
  b: T,
  label: (item: T) => string
): number {
  return b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt || label(a).localeCompare(label(b));
}

export function computeListeningStats(
  entries: readonly HistoryEntry[],
  tracks: readonly Track[],
  options: { now?: number; topLimit?: number; days?: number } = {}
): ListeningStats {
  const now = options.now ?? Date.now();
  const topLimit = Math.max(1, options.topLimit ?? 10);
  const days = Math.max(1, Math.floor(options.days ?? 30));
  const sorted = sortedEntries(entries);
  const tracksById = new Map(tracks.map(track => [track.id, track] as const));

  const trackRank = new Map<string, RankedHistoryTrack>();
  const artistRank = new Map<string, RankedArtist & { sourceKeys: Set<string> }>();
  const albumRank = new Map<string, RankedAlbum & { sourceKeys: Set<string> }>();
  const genreRank = new Map<string, RankedGenre>();
  const dayCounts = new Map<string, number>();
  const playsByHour = Array.from({ length: 24 }, () => 0);

  let startedTrackSeconds = 0;
  let playsLast7Days = 0;
  let playsLast30Days = 0;

  for (const entry of sorted) {
    const payload = entry.payload;
    const sourceKey = trackSourceKey(entry.source);
    const joinedTrack =
      entry.source.kind === "local" ? tracksById.get(entry.source.trackId) ?? null : null;
    const title = cleanText(joinedTrack?.title ?? payload.title, "Unknown title");
    const artist = cleanText(joinedTrack?.artist ?? payload.artist, "Unknown artist");
    const albumArtist = cleanText(joinedTrack?.albumArtist ?? payload.albumArtist ?? artist, artist);
    const album = cleanText(joinedTrack?.album ?? payload.album, "Unknown album");
    const hasAlbumMetadata = Boolean((joinedTrack?.album ?? payload.album)?.trim());
    const artworkUrl = joinedTrack?.artworkUrl ?? payload.artworkUrl ?? null;
    const duration = finiteNonNegative(joinedTrack?.duration ?? payload.duration);

    startedTrackSeconds += duration;
    if (entry.playedAt > now - 7 * DAY_MS && entry.playedAt <= now) playsLast7Days += 1;
    if (entry.playedAt > now - 30 * DAY_MS && entry.playedAt <= now) playsLast30Days += 1;

    const existingTrack = trackRank.get(sourceKey);
    if (existingTrack) {
      existingTrack.playCount += 1;
    } else {
      trackRank.set(sourceKey, {
        source: entry.source,
        sourceKey,
        trackId: entry.source.kind === "local" ? entry.source.trackId : null,
        mediaItem: mediaItemFromHistoryPayload(payload),
        title,
        artist,
        albumArtist,
        album,
        artworkUrl,
        duration,
        playCount: 1,
        lastPlayedAt: entry.playedAt,
        track: joinedTrack,
      });
    }

    const artistKey = artist.toLocaleLowerCase();
    const existingArtist = artistRank.get(artistKey);
    if (existingArtist) {
      existingArtist.playCount += 1;
      existingArtist.sourceKeys.add(sourceKey);
    } else {
      artistRank.set(artistKey, {
        artist,
        playCount: 1,
        uniqueTrackCount: 1,
        lastPlayedAt: entry.playedAt,
        artworkUrl,
        sourceKeys: new Set([sourceKey]),
      });
    }

    if (hasAlbumMetadata) {
      const albumKey = `${albumArtist}\u0000${album}`.toLocaleLowerCase();
      const existingAlbum = albumRank.get(albumKey);
      if (existingAlbum) {
        existingAlbum.playCount += 1;
        existingAlbum.sourceKeys.add(sourceKey);
      } else {
        albumRank.set(albumKey, {
          key: `${albumArtist}\u0000${album}`,
          album,
          albumArtist,
          playCount: 1,
          uniqueTrackCount: 1,
          lastPlayedAt: entry.playedAt,
          artworkUrl,
          sourceKeys: new Set([sourceKey]),
        });
      }
    }

    const genres = joinedTrack
      ? cleanText(joinedTrack.genre, "Unknown genre")
          .split(/[,;/]/)
          .map(genre => genre.trim())
          .filter(Boolean)
      : [];
    for (const genre of genres.length
      ? genres
      : entry.source.kind === "local"
        ? ["Unknown genre"]
        : []) {
      const key = genre.toLocaleLowerCase();
      const existingGenre = genreRank.get(key);
      if (existingGenre) existingGenre.playCount += 1;
      else genreRank.set(key, { genre, playCount: 1 });
    }

    dayCounts.set(dayKey(entry.playedAt), (dayCounts.get(dayKey(entry.playedAt)) ?? 0) + 1);
    const hour = new Date(entry.playedAt).getHours();
    if (hour >= 0 && hour < playsByHour.length) playsByHour[hour] += 1;
  }

  const firstDay = addLocalDays(startOfLocalDay(now), -(days - 1));
  const playsByDay = Array.from({ length: days }, (_, index) => {
    const dayStart = addLocalDays(firstDay, index);
    const key = dayKey(dayStart);
    return { dateKey: key, date: new Date(dayStart), count: dayCounts.get(key) ?? 0 };
  });

  let streakCursor = startOfLocalDay(now);
  if (!dayCounts.has(dayKey(streakCursor))) streakCursor = addLocalDays(streakCursor, -1);
  let currentStreakDays = 0;
  while (dayCounts.has(dayKey(streakCursor))) {
    currentStreakDays += 1;
    streakCursor = addLocalDays(streakCursor, -1);
  }

  return {
    generatedAt: now,
    historyPlayCount: sorted.length,
    libraryPlayCount: tracks.reduce((sum, track) => sum + finiteNonNegative(track.playCount), 0),
    startedTrackSeconds,
    uniqueTrackCount: trackRank.size,
    uniqueArtistCount: artistRank.size,
    playsLast7Days,
    playsLast30Days,
    currentStreakDays,
    topTracks: [...trackRank.values()]
      .sort((a, b) => byRankThenRecency(a, b, item => item.title))
      .slice(0, topLimit),
    topArtists: [...artistRank.values()]
      .map(({ sourceKeys, ...artist }) => ({ ...artist, uniqueTrackCount: sourceKeys.size }))
      .sort((a, b) => byRankThenRecency(a, b, item => item.artist))
      .slice(0, topLimit),
    topAlbums: [...albumRank.values()]
      .map(({ sourceKeys, ...album }) => ({ ...album, uniqueTrackCount: sourceKeys.size }))
      .sort((a, b) => byRankThenRecency(a, b, item => item.album))
      .slice(0, topLimit),
    genres: [...genreRank.values()]
      .sort((a, b) => b.playCount - a.playCount || a.genre.localeCompare(b.genre))
      .slice(0, 8),
    playsByDay,
    playsByHour,
  };
}

interface HistoryTrackAggregate {
  count: number;
  recentCount: number;
  lastPlayedAt: number;
}

function aggregateHistoryByTrack(
  entries: readonly HistoryEntry[],
  recentCutoff: number
): Map<number, HistoryTrackAggregate> {
  const aggregates = new Map<number, HistoryTrackAggregate>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.playedAt) || entry.source.kind !== "local") continue;
    const trackId = entry.source.trackId;
    const existing = aggregates.get(trackId);
    if (existing) {
      existing.count += 1;
      if (entry.playedAt >= recentCutoff) existing.recentCount += 1;
      existing.lastPlayedAt = Math.max(existing.lastPlayedAt, entry.playedAt);
    } else {
      aggregates.set(trackId, {
        count: 1,
        recentCount: entry.playedAt >= recentCutoff ? 1 : 0,
        lastPlayedAt: entry.playedAt,
      });
    }
  }
  return aggregates;
}

function toDiscoveryTracks(
  tracks: readonly Track[],
  entries: readonly HistoryEntry[],
  recentCutoff: number
): DiscoveryTrack[] {
  const aggregates = aggregateHistoryByTrack(entries, recentCutoff);
  return tracks.map(track => {
    const aggregate = aggregates.get(track.id);
    const lastPlayedAt = Math.max(finiteNonNegative(track.lastPlayedAt), aggregate?.lastPlayedAt ?? 0);
    return {
      track,
      // The library counter is all-time; history is capped. Taking the larger keeps shelves useful
      // both before and after that cap starts pruning very old sessions.
      playCount: Math.max(finiteNonNegative(track.playCount), aggregate?.count ?? 0),
      recentPlayCount: aggregate?.recentCount ?? 0,
      lastPlayedAt: lastPlayedAt > 0 ? lastPlayedAt : null,
    };
  });
}

export function topLibraryTracks(
  tracks: readonly Track[],
  entries: readonly HistoryEntry[],
  options: { now?: number; limit?: number } = {}
): DiscoveryTrack[] {
  const now = options.now ?? Date.now();
  return toDiscoveryTracks(tracks, entries, now - 14 * DAY_MS)
    .filter(item => item.playCount > 0)
    .sort(
      (a, b) =>
        b.playCount - a.playCount ||
        (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) ||
        a.track.title.localeCompare(b.track.title)
    )
    .slice(0, Math.max(0, options.limit ?? 10));
}

export function onRepeatTracks(
  tracks: readonly Track[],
  entries: readonly HistoryEntry[],
  options: { now?: number; windowDays?: number; minimumPlays?: number; limit?: number } = {}
): DiscoveryTrack[] {
  const now = options.now ?? Date.now();
  const cutoff = now - Math.max(1, options.windowDays ?? 14) * DAY_MS;
  return toDiscoveryTracks(tracks, entries, cutoff)
    .filter(item => item.recentPlayCount >= Math.max(1, options.minimumPlays ?? 2))
    .sort(
      (a, b) =>
        b.recentPlayCount - a.recentPlayCount ||
        (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) ||
        b.playCount - a.playCount ||
        a.track.title.localeCompare(b.track.title)
    )
    .slice(0, Math.max(0, options.limit ?? 10));
}

export function rediscoverTracks(
  tracks: readonly Track[],
  entries: readonly HistoryEntry[],
  options: { now?: number; inactiveDays?: number; limit?: number } = {}
): DiscoveryTrack[] {
  const now = options.now ?? Date.now();
  const cutoff = now - Math.max(1, options.inactiveDays ?? 30) * DAY_MS;
  return toDiscoveryTracks(tracks, entries, cutoff)
    .filter(item => item.playCount > 0 && item.lastPlayedAt !== null && item.lastPlayedAt < cutoff)
    .sort(
      (a, b) =>
        (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0) ||
        b.playCount - a.playCount ||
        a.track.title.localeCompare(b.track.title)
    )
    .slice(0, Math.max(0, options.limit ?? 10));
}
