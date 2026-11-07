/**
 * Home: recent activity, quick access and library shortcuts. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { Clock3, FolderPlus, Heart, Mic2, Play, Shuffle } from "lucide-react";
import { trackSourceKey } from "../../../shared/media";
import type { HistoryPayload } from "../../../shared/types";
import { useLibrary } from "../../state/libraryStore";
import { useHistory } from "../../state/historyStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { TrackList } from "../../components/TrackList";
import { AlbumCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { shuffle } from "../../player/queue";
import { onRepeatTracks, rediscoverTracks, topLibraryTracks } from "../stats/listeningStats";
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up?";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatLastPlayed(timestamp: number | null): string {
  if (timestamp === null) return "Played before";
  return `Last played ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp))}`;
}

export function HomeView() {
  const snapshot = useLibrary(state => state.snapshot);
  const addFolder = useLibrary(state => state.addFolder);
  const scanning = useLibrary(state => state.scanning);
  const navigate = useUi(state => state.navigate);
  const showToast = useUi(state => state.showToast);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const playTrack = usePlayer(state => state.playTrack);
  const { entries: historyEntries, load: loadHistory } = useHistory(state => state);
  const [now] = useState(() => Date.now());

  // Recently played is a read-only view of the same persistent listening history the History tab
  // uses. Both views share the useHistory store, so a new play start or a clear-history updates
  // both automatically without a reload.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const recentlyPlayed = useMemo(() => {
    const seen = new Set<string>();
    const result: HistoryPayload[] = [];
    for (const entry of [...historyEntries].sort(
      (a, b) => b.playedAt - a.playedAt || b.id - a.id,
    )) {
      const key = trackSourceKey(entry.source);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry.payload);
      if (result.length >= 6) break;
    }
    return result;
  }, [historyEntries]);

  const recentlyAdded = useMemo(
    () => [...(snapshot?.tracks ?? [])].sort((a, b) => b.addedAt - a.addedAt).slice(0, 10),
    [snapshot?.tracks],
  );

  const albums = useMemo(() => {
    const list = snapshot?.albums ?? [];
    const seen = new Set<string>();
    const unique: typeof list = [];
    for (const album of list) {
      if (seen.has(album.name)) continue;
      seen.add(album.name);
      unique.push(album);
    }
    // Shuffled once per homepage initialization: stable across re-renders, randomized again when
    // the library snapshot changes or the view is (re)mounted.
    return shuffle(unique).slice(0, 10);
  }, [snapshot?.albums]);

  const favorites = useMemo(() => (snapshot?.tracks ?? []).filter(track => track.favorite), [snapshot?.tracks]);

  const topTracks = useMemo(
    () => topLibraryTracks(snapshot?.tracks ?? [], historyEntries, { now, limit: 10 }),
    [historyEntries, now, snapshot?.tracks],
  );

  const onRepeat = useMemo(
    () => onRepeatTracks(snapshot?.tracks ?? [], historyEntries, { now, limit: 6 }),
    [historyEntries, now, snapshot?.tracks],
  );

  const rediscover = useMemo(
    () => rediscoverTracks(snapshot?.tracks ?? [], historyEntries, { now, limit: 6 }),
    [historyEntries, now, snapshot?.tracks],
  );

  if (!snapshot) {
    return <div className="view-loading">Loading your library…</div>;
  }

  if (snapshot.tracks.length === 0) {
    return (
      <div className="home-empty" data-testid="home-empty">
        <div className="home-empty-art">
          <Artwork src={null} alt="Cadence" size="hero" />
          <Mic2 className="home-empty-icon" size={56} />
        </div>
        <h1>Bring your music home</h1>
        <p>
          Cadence plays the files you already own — FLAC, MP3, AAC/M4A, WAV, Ogg Vorbis and Opus — and pairs
          them with the Better Lyrics engine and its shader backgrounds. Nothing is uploaded anywhere.
        </p>
        <div className="empty-actions">
          <button type="button" className="primary" onClick={() => void addFolder()} disabled={scanning}>
            <FolderPlus size={18} /> {scanning ? "Scanning…" : "Add music folder"}
          </button>
        </div>
        {snapshot.scan.errors.length > 0 ? (
          <p className="error-text">{snapshot.scan.errors.length} files could not be read during the last scan.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="home-view view" data-testid="home-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">{greeting()}</p>
          <h1>Listen again</h1>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void playQueue(snapshot.tracks.map(track => track.id), 0)}
          >
            <Play size={16} fill="currentColor" /> Play library
          </button>
          <button
            type="button"
            onClick={() => {
              const start = Math.floor(Math.random() * snapshot.tracks.length);
              void playShuffled(snapshot.tracks.map(track => track.id), start);
            }}
          >
            <Shuffle size={16} /> Shuffle
          </button>
        </div>
      </header>

      <section className="quick-row">
        <button type="button" className="quick-card" onClick={() => navigate({ name: "library", tab: "favorites" })}>
          <span className="quick-icon liked">
            <Heart size={20} fill="currentColor" />
          </span>
          <span>
            <strong>Liked songs</strong>
            <em>{favorites.length} songs</em>
          </span>
        </button>
        <button type="button" className="quick-card" onClick={() => navigate({ name: "lyrics" })}>
          <span className="quick-icon lyrics">
            <Mic2 size={20} />
          </span>
          <span>
            <strong>Now Playing</strong>
            <em>Better Lyrics + Shaders</em>
          </span>
        </button>
        <button type="button" className="quick-card" onClick={() => navigate({ name: "library", tab: "playlists" })}>
          <span className="quick-icon playlists">
            <Clock3 size={20} />
          </span>
          <span>
            <strong>Playlists</strong>
            <em>{snapshot.playlists.length} playlists</em>
          </span>
        </button>
      </section>

      {recentlyPlayed.length > 0 ? (
        <section className="shelf" data-testid="home-recently-played">
          <div className="shelf-heading">
            <h2>Recently played</h2>
            <button type="button" className="link" onClick={() => navigate({ name: "history" })}>Show all</button>
          </div>
          <div className="quick-grid">
            {recentlyPlayed.map(track => (
              <button
                type="button"
                key={trackSourceKey(track.source)}
                className="quick-track"
                data-testid="recently-played-item"
                data-source-kind={track.source.kind}
                onClick={() => {
                  if (track.source.kind === "local") {
                    void playTrack(track.source.trackId);
                    return;
                  }
                  void showToast("Remote playback is not available in this build.");
                }}
              >
                <Artwork src={track.artworkUrl ?? null} alt={track.album || track.title} size="xs" />
                <span>
                  <strong>{track.title}</strong>
                  <em>{track.artist}</em>
                </span>
                <SourceBadge source={track.source} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {topTracks.length > 0 ? (
        <section className="shelf" data-testid="home-top-tracks">
          <div className="shelf-heading">
            <h2>Your top tracks</h2>
            <button type="button" className="link" onClick={() => navigate({ name: "stats" })}>See stats</button>
          </div>
          <TrackList tracks={topTracks.map(item => item.track)} compact testId="top-tracks" />
        </section>
      ) : null}

      {onRepeat.length > 0 ? (
        <section className="shelf" data-testid="home-on-repeat">
          <div className="shelf-heading">
            <h2>On repeat</h2>
            <span className="muted">What you have been looping lately</span>
          </div>
          <div className="quick-grid">
            {onRepeat.map(item => (
              <button
                type="button"
                key={item.track.id}
                className="quick-track"
                data-testid="on-repeat-item"
                onClick={() => void playTrack(item.track.id)}
              >
                <Artwork src={item.track.artworkUrl ?? null} alt={item.track.album || item.track.title} size="xs" />
                <span>
                  <strong>{item.track.title}</strong>
                  <em>{item.track.artist} · {item.recentPlayCount} plays in 14 days</em>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {rediscover.length > 0 ? (
        <section className="shelf" data-testid="home-rediscover">
          <div className="shelf-heading">
            <h2>Rediscover</h2>
            <span className="muted">Old favourites you have not played in a while</span>
          </div>
          <div className="quick-grid">
            {rediscover.map(item => (
              <button
                type="button"
                key={item.track.id}
                className="quick-track"
                data-testid="rediscover-item"
                onClick={() => void playTrack(item.track.id)}
              >
                <Artwork src={item.track.artworkUrl ?? null} alt={item.track.album || item.track.title} size="xs" />
                <span>
                  <strong>{item.track.title}</strong>
                  <em>{item.track.artist} · {formatLastPlayed(item.lastPlayedAt)}</em>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading">
            <h2>Random albums</h2>
            <button type="button" className="link" onClick={() => navigate({ name: "library", tab: "albums" })}>Show all</button>
          </div>
          <div className="card-grid">
            {albums.map(album => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="shelf">
        <div className="shelf-heading">
          <h2>Recently added</h2>
          <span className="muted">{formatTime(snapshot.counts.duration)} of music</span>
        </div>
        <TrackList tracks={recentlyAdded} compact testId="recently-added" />
      </section>
    </div>
  );
}