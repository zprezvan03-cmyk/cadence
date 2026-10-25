/**
 * Album, artist, playlist and search views. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock3, Mic2, Play, Plus, Search, Shuffle, Trash2, X } from "lucide-react";
import type { Playlist, Track } from "../../../shared/types";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { TrackList } from "../../components/TrackList";
import { AlbumCard, ArtistCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";

function Hero({
  artworkUrl,
  eyebrow,
  title,
  meta,
  onPlay,
  onShuffle,
  children,
}: {
  artworkUrl: string | null;
  eyebrow: string;
  title: string;
  meta: string;
  onPlay?: () => void;
  onShuffle?: () => void;
  children?: React.ReactNode;
}) {
  const goBack = useUi(state => state.goBack);
  const navigate = useUi(state => state.navigate);
  return (
    <header className="detail-hero" data-testid="detail-hero">
      <button type="button" className="icon-button back-button" onClick={goBack} aria-label="Back">
        <ArrowLeft size={18} />
      </button>
      <Artwork src={artworkUrl} alt={title} size="xl" />
      <div className="detail-meta">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{meta}</p>
        <div className="heading-actions">
          {onPlay ? (
            <button type="button" className="primary" onClick={onPlay}>
              <Play size={16} fill="currentColor" /> Play
            </button>
          ) : null}
          {onShuffle ? (
            <button type="button" onClick={onShuffle}>
              <Shuffle size={16} /> Shuffle
            </button>
          ) : null}
          <button type="button" onClick={() => navigate({ name: "lyrics" })}>
            <Mic2 size={16} /> Now Playing
          </button>
          {children}
        </div>
      </div>
    </header>
  );
}

export function AlbumView({ albumId }: { albumId: string }) {
  const snapshot = useLibrary(state => state.snapshot);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const album = snapshot?.albums.find(candidate => candidate.id === albumId);
  const tracks = useMemo(
    () =>
      (snapshot?.tracks ?? [])
        .filter(track => `${track.albumArtist || track.artist}\u0000${track.album}` === albumId)
        .sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0)),
    [snapshot?.tracks, albumId]
  );

  if (!album) return <div className="empty-state">Album not found. It may have been removed from the library.</div>;

  return (
    <div className="view detail-view">
      <Hero
        artworkUrl={album.artworkUrl}
        eyebrow="Album"
        title={album.name}
        meta={`${album.albumArtist}${album.year ? ` · ${album.year}` : ""} · ${album.trackCount} songs · ${formatTime(album.duration)}`}
        onPlay={() => void playQueue(tracks.map(track => track.id), 0)}
        onShuffle={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * tracks.length))}
      />
      <TrackList tracks={tracks} showAlbum={false} showArtwork={false} testId="album-track-list" />
    </div>
  );
}

export function ArtistView({ artistId }: { artistId: string }) {
  const snapshot = useLibrary(state => state.snapshot);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const artist = snapshot?.artists.find(candidate => candidate.id === artistId);
  const tracks = useMemo(
    () =>
      (snapshot?.tracks ?? [])
        .filter(track => track.artist === artistId)
        .sort((a, b) => b.duration - a.duration || a.title.localeCompare(b.title)),
    [snapshot?.tracks, artistId]
  );
  const albums = useMemo(
    () => (snapshot?.albums ?? []).filter(album => album.albumArtist === artistId || tracks.some(track => track.album === album.name)),
    [snapshot?.albums, artistId, tracks]
  );

  if (!artist) return <div className="empty-state">Artist not found.</div>;

  return (
    <div className="view detail-view">
      <Hero
        artworkUrl={artist.artworkUrl}
        eyebrow="Artist"
        title={artist.name}
        meta={`${artist.trackCount} songs · ${artist.albumCount} albums`}
        onPlay={() => void playQueue(tracks.map(track => track.id), 0)}
        onShuffle={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * tracks.length))}
      />
      <div className="shelf">
        <h2>Albums</h2>
        <div className="card-grid artist-grid">
          {albums.map(album => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      </div>
      <div className="shelf">
        <h2>All songs</h2>
        <TrackList tracks={tracks} testId="artist-track-list" />
      </div>
    </div>
  );
}

export function SearchView({ query }: { query: string }) {
  const snapshot = useLibrary(state => state.snapshot);
  const search = useLibrary(state => state.search);
  const playQueue = usePlayer(state => state.playQueue);
  const navigate = useUi(state => state.navigate);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setTracks([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void search(query)
        .then(results => {
          if (!cancelled) setTracks(results);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, search]);

  const needle = query.trim().toLocaleLowerCase();
  const albums = (snapshot?.albums ?? []).filter(
    album => needle && (album.name.toLocaleLowerCase().includes(needle) || album.albumArtist.toLocaleLowerCase().includes(needle))
  );
  const artists = (snapshot?.artists ?? []).filter(artist => needle && artist.name.toLocaleLowerCase().includes(needle));

  return (
    <div className="view search-view" data-testid="search-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Search</p>
          <h1>{query ? `“${query}”` : "Search your library"}</h1>
          <p className="muted">{searching ? "Searching…" : `${tracks.length} songs · ${albums.length} albums · ${artists.length} artists`}</p>
        </div>
      </header>

      {artists.length > 0 ? (
        <section className="shelf">
          <h2>Artists</h2>
          <div className="card-grid artist-grid">
            {artists.slice(0, 8).map(artist => (
              <ArtistCard key={artist.id} artist={artist} />
            ))}
          </div>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section className="shelf">
          <h2>Albums</h2>
          <div className="card-grid">
            {albums.slice(0, 8).map(album => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="shelf">
        <div className="shelf-heading">
          <h2>Songs</h2>
          {tracks.length > 0 ? (
            <button type="button" className="link" onClick={() => void playQueue(tracks.map(track => track.id), 0)}>
              Play all
            </button>
          ) : null}
        </div>
        {query ? (
          <TrackList tracks={tracks} emptyMessage={searching ? "Searching…" : "No songs match that search."} testId="search-track-list" />
        ) : (
          <div className="empty-state">
            <Search size={28} />
            Search by track, artist or album — or press <kbd>Ctrl</kbd> + <kbd>K</kbd>.
            <div className="heading-actions" style={{ marginTop: 16 }}>
              <button type="button" onClick={() => navigate({ name: "library", tab: "songs" })}>
                Browse all songs
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function PlaylistView({ playlistId }: { playlistId: number }) {
  const snapshot = useLibrary(state => state.snapshot);
  const removeFromPlaylist = useLibrary(state => state.removeFromPlaylist);
  const renamePlaylist = useLibrary(state => state.renamePlaylist);
  const addToPlaylist = useLibrary(state => state.addToPlaylist);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const playlist = snapshot?.playlists.find((entry: Playlist) => entry.id === playlistId);

  useEffect(() => {
    let cancelled = false;
    void window.cadence.playlists.tracks(playlistId).then(result => {
      if (!cancelled) setTracks(result);
    });
    return () => {
      cancelled = true;
    };
  }, [playlistId, snapshot?.playlists]);

  const candidates = useMemo(() => {
    const needle = addQuery.trim().toLocaleLowerCase();
    const existing = new Set(tracks.map(track => track.id));
    return (snapshot?.tracks ?? [])
      .filter(track => !existing.has(track.id))
      .filter(track => !needle || [track.title, track.artist, track.album].some(value => value.toLocaleLowerCase().includes(needle)))
      .slice(0, 40);
  }, [snapshot?.tracks, tracks, addQuery]);

  if (!playlist) return <div className="empty-state">Playlist not found.</div>;

  return (
    <div className="view detail-view">
      <Hero
        artworkUrl={playlist.artworkUrl}
        eyebrow="Playlist"
        title={playlist.name}
        meta={`${playlist.trackCount} songs · ${formatTime(playlist.duration)}`}
        onPlay={() => void playQueue(tracks.map(track => track.id), 0)}
        onShuffle={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * Math.max(1, tracks.length)))}
      >
        <button type="button" onClick={() => setAdding(true)}>
          <Plus size={16} /> Add songs
        </button>
        <button type="button" onClick={() => setEditing(true)}>
          Rename
        </button>
      </Hero>

      {editing ? (
        <form
          className="inline-create"
          onSubmit={async event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const name = String(data.get("name") ?? "").trim();
            if (name) await renamePlaylist(playlist.id, name);
            setEditing(false);
          }}
        >
          <input name="name" defaultValue={playlist.name} autoFocus />
          <button type="submit" className="primary">
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      <TrackList
        tracks={tracks}
        onRemove={track => {
          void removeFromPlaylist(playlist.id, track.id).then(() =>
            setTracks(previous => previous.filter(candidate => candidate.id !== track.id))
          );
        }}
        emptyMessage="This playlist is empty. Add some songs."
        testId="playlist-track-list"
      />

      {adding ? (
        <div
          className="modal-backdrop"
          onClick={() => setAdding(false)}
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setAdding(false);
            }
          }}
        >
          <div className="modal" onClick={event => event.stopPropagation()}>
            <header className="modal-header">
              <h2>Add songs</h2>
              <button type="button" className="icon-button" onClick={() => setAdding(false)} aria-label="Close">
                <X size={16} />
              </button>
            </header>
            <label className="inline-search full">
              <Search size={15} />
              <input
                autoFocus
                placeholder="Search your library"
                value={addQuery}
                onChange={event => setAddQuery(event.target.value)}
              />
            </label>
            <div className="modal-list">
              {candidates.map(track => (
                <button
                  type="button"
                  key={track.id}
                  className="modal-row"
                  onClick={async () => {
                    await addToPlaylist(playlist.id, [track.id]);
                    setTracks(previous => [...previous, track]);
                  }}
                >
                  <Artwork src={track.artworkUrl} alt={track.album} size="xs" />
                  <span>
                    <strong>{track.title}</strong>
                    <em>
                      {track.artist} · {track.album}
                    </em>
                  </span>
                  <Clock3 size={14} />
                  <span className="muted">{formatTime(track.duration)}</span>
                </button>
              ))}
              {candidates.length === 0 ? <div className="empty-state">Nothing left to add.</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
