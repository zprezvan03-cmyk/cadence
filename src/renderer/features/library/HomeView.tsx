/**
 * Home: featured albums, listening history and discovery shelves. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronRight, FolderPlus, Play, Shuffle } from "lucide-react";
import { trackSourceKey } from "../../../shared/media";
import type { HistoryPayload } from "../../../shared/types";
import { useLibrary } from "../../state/libraryStore";
import { useHistory } from "../../state/historyStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { AlbumCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { shuffle } from "../../player/queue";
import { onRepeatTracks, rediscoverTracks, topLibraryTracks } from "../stats/listeningStats";
import { HomeShelf, HomeTrackShelf } from "./HomeShelves";

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
    return <div className="view-loading" role="status">Loading your library…</div>;
  }

  if (snapshot.tracks.length === 0) {
    return (
      <div className="home-empty" data-testid="home-empty">
        <Artwork src={null} alt="" size="lg" className="home-empty-art" />
        <p className="eyebrow">Your library</p>
        <h1>Bring your music home</h1>
        <p className="home-empty-copy">
          Add a folder to listen to the music you already own. Your files stay on this device.
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

  const spotlight = albums.find(album => album.artworkUrl) ?? albums[0];
  const playSpotlight = () => {
    if (!spotlight) return;
    const tracks = snapshot.tracks
      .filter(track => `${track.albumArtist || track.artist}\u0000${track.album}` === spotlight.id)
      .sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0));
    void playQueue(tracks.map(track => track.id), 0);
  };

  return (
    <div className="home-view view" data-testid="home-view">
      <header className="view-heading has-rule">
        <div>
          <p className="eyebrow">{greeting()}</p>
          <h1>Listen Now</h1>
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

      <div className="home-lead">
        {spotlight ? (
          <section className="home-spotlight" aria-labelledby="featured-album-heading">
            <div className="shelf-heading"><h2 id="featured-album-heading">Featured album</h2></div>
            <div className="spotlight-feature">
              <Artwork src={spotlight.artworkUrl} alt={spotlight.name} />
              <div className="spotlight-copy">
                <h3 title={spotlight.name}>{spotlight.name}</h3>
                <p className="spotlight-artist" title={spotlight.albumArtist}>{spotlight.albumArtist}</p>
                <p className="muted">{spotlight.year ? `${spotlight.year} · ` : ""}{spotlight.trackCount} {spotlight.trackCount === 1 ? "song" : "songs"}</p>
                <div className="heading-actions">
                  <button type="button" className="primary" onClick={playSpotlight}>
                    <Play size={15} fill="currentColor" /> Play album
                  </button>
                  <button type="button" onClick={() => navigate({ name: "album", albumId: spotlight.id })}>
                    View album <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}
        {recentlyPlayed.length > 0 ? (
          <section className="home-recents" data-testid="home-recently-played">
            <div className="shelf-heading">
              <h2>Recently played</h2>
              <button type="button" className="link" onClick={() => navigate({ name: "history" })}>History <ChevronRight size={14} /></button>
            </div>
            <div className="home-recent-list">
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
                  <SourceBadge source={track.source} compact />
                  <Play size={15} className="recent-play" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {albums.length > 0 ? (
        <HomeShelf
          className="home-albums"
          testId="home-albums"
          title="Explore your albums"
          aside={<button type="button" className="link" onClick={() => navigate({ name: "library", tab: "albums" })}>All albums <ChevronRight size={15} /></button>}
        >
          {albums.map(album => <AlbumCard key={album.id} album={album} />)}
        </HomeShelf>
      ) : null}

      {topTracks.length > 0 ? (
        <HomeTrackShelf
          title="Your top tracks"
          testId="home-top-tracks"
          items={topTracks}
          rankedQueue
          aside={<button type="button" className="link" onClick={() => navigate({ name: "stats" })}>See stats</button>}
        />
      ) : null}

      {onRepeat.length > 0 ? (
        <HomeTrackShelf
          title="On repeat"
          testId="home-on-repeat"
          items={onRepeat}
          aside={<span className="muted">Past 14 days</span>}
        />
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
    </div>
  );
}