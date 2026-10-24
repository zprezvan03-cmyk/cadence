/**
 * Pure YouTube link and manual-search metadata helpers, shared by the main process (metadata
 * lookup) and the renderer (instant URL validation and effective-query preview). No network access
 * lives here, so the functions are trivially unit-testable and safe to call from either process.
 * Written for Cadence.
 */

/** YouTube video IDs are exactly 11 URL-safe characters. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/**
 * Extract the 11-character video ID from every link shape YouTube itself accepts:
 *   - https://www.youtube.com/watch?v=ID (any extra query params, with or without protocol)
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID, /live/ID, /v/ID (also youtube-nocookie.com)
 * Returns null for anything else: non-YouTube hosts, malformed URLs or IDs of the wrong length.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const idFromPath = (prefix: string): string | null => {
    const match = url.pathname.match(new RegExp(`^/${prefix}/([A-Za-z0-9_-]{11})(?:/|$)`));
    return match ? match[1] : null;
  };

  if (SHORT_HOSTS.has(host)) {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  if (!WATCH_HOSTS.has(host)) return null;

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  return idFromPath("shorts") ?? idFromPath("embed") ?? idFromPath("live") ?? idFromPath("v");
}

/**
 * YouTube Music auto-generates artist channels named "Artist Name - Topic". Strip that suffix so
 * the channel can be used as an artist hint; other channel names pass through unchanged.
 */
export function normalizeYouTubeArtist(channel: string | null | undefined): string | null {
  const trimmed = (channel ?? "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+-\s+Topic$/i, "").trim();
  return normalized || null;
}

/** What the user typed into the manual-search form. Every field except the title may be blank. */
export interface ManualSearchInput {
  title: string;
  artist: string;
  album: string;
  youtubeUrl: string;
}

/** Metadata resolved from a YouTube link, as returned by the main-process lookup. */
export interface ResolvedYouTubeMetadata {
  videoId: string;
  title: string;
  artist: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

export type SearchFieldSource = "user" | "youtube" | "track" | null;

/**
 * The exact metadata that will be sent to the lyrics providers, plus where each value came from so
 * the UI can show provenance. Explicitly entered user values always win; YouTube data only fills
 * gaps and never overwrites what the user typed. Duration prefers the playing local track and
 * falls back to the video's length.
 */
export interface EffectiveSearch {
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  sources: {
    title: SearchFieldSource;
    artist: SearchFieldSource;
    album: SearchFieldSource;
    duration: SearchFieldSource;
  };
}

export function resolveSearchFields(
  input: ManualSearchInput,
  youtube: ResolvedYouTubeMetadata | null,
  trackDuration: number | null
): EffectiveSearch {
  const userTitle = input.title.trim();
  const userArtist = input.artist.trim();
  const userAlbum = input.album.trim();

  const title = userTitle || youtube?.title || "";
  const artist = userArtist || youtube?.artist || "";
  const album = userAlbum;

  let duration: number | null;
  let durationSource: SearchFieldSource;
  if (trackDuration && trackDuration > 0) {
    duration = trackDuration;
    durationSource = "track";
  } else if (youtube?.durationSeconds && youtube.durationSeconds > 0) {
    duration = youtube.durationSeconds;
    durationSource = "youtube";
  } else {
    duration = null;
    durationSource = null;
  }

  return {
    title,
    artist,
    album,
    duration,
    sources: {
      title: userTitle ? "user" : youtube?.title ? "youtube" : null,
      artist: userArtist ? "user" : youtube?.artist ? "youtube" : null,
      album: userAlbum ? "user" : null,
      duration: durationSource,
    },
  };
}

/** Formats seconds as m:ss (or h:mm:ss for long videos), mirroring common music-UI conventions. */
export function formatDurationSeconds(seconds: number | null): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const paddedSeconds = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}
