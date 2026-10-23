/**
 * Home: recent activity, quick access and library shortcuts. Written for Cadence.
 */

import { useMemo } from "react";
import { Clock3, FolderPlus, Heart, Mic2, Play, Shuffle } from "lucide-react";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { TrackList } from "../../components/TrackList";
import { AlbumCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up?";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView() {
  const snapshot = useLibrary(state => state.snapshot);
  const addFolder = useLibrary(state => state.addFolder);
  const scanning = useLibrary(state => state.scanning);
  const navigate = useUi(state => state.navigate);
  const playQueue = usePlayer(state => state.playQueue);

  const recentlyPlayed = useMemo(
    () =>
      [...(snapshot?.tracks ?? [])]
        .filter(track => track.lastPlayedAt)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 6),
    [snapshot?.tracks]
  );

  const recentlyAdded = useMemo(
    () => [...(snapshot?.tracks ?? [])].sort((a, b) => b.addedAt - a.addedAt).slice(0, 10),
    [snapshot?.tracks]
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
    return unique.slice(0, 10);
  }, [snapshot?.albums]);

  const favorites = useMemo(() => (snapshot?.tracks ?? []).filter(track => track.favorite), [snapshot?.tracks]);

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
              const shuffled = [...snapshot.tracks];
              const start = Math.floor(Math.random() * Math.max(1, shuffled.length));
              void playQueue(shuffled.map(track => track.id), start);
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
        <section className="shelf">
          <div className="shelf-heading">
            <h2>Recently played</h2>
            <button type="button" className="link" onClick={() => navigate({ name: "library", tab: "songs" })}>
              Show all
            </button>
          </div>
          <div className="quick-grid">
            {recentlyPlayed.map(track => (
              <button
                type="button"
                key={track.id}
                className="quick-track"
                onClick={() => void playQueue([track.id], 0)}
              >
                <Artwork src={track.artworkUrl} alt={track.album} size="xs" />
                <span>
                  <strong>{track.title}</strong>
                  <em>{track.artist}</em>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading">
            <h2>Your albums</h2>
            <button type="button" className="link" onClick={() => navigate({ name: "library", tab: "albums" })}>
              Show all
            </button>
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
