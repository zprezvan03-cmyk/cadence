/**
 * Library browsing: songs, albums, artists, playlists and favourites. Written for Cadence.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FolderPlus, Play, Plus, Search, Shuffle, Trash2 } from "lucide-react";
import type { LibraryTab } from "../../state/uiStore";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { TrackList } from "../../components/TrackList";
import { AlbumCard, ArtistCard, PlaylistCard } from "../../components/Cards";

type SortKey = "title" | "artist" | "album" | "added" | "duration";

const TITLES: Record<LibraryTab, string> = {
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  playlists: "Playlists",
  favorites: "Liked songs",
};

export function LibraryView({ tab }: { tab: LibraryTab }) {
  const snapshot = useLibrary(state => state.snapshot);
  const addFolder = useLibrary(state => state.addFolder);
  const rescan = useLibrary(state => state.rescan);
  const scanning = useLibrary(state => state.scanning);
  const createPlaylist = useLibrary(state => state.createPlaylist);
  const deletePlaylist = useLibrary(state => state.deletePlaylist);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const navigate = useUi(state => state.navigate);
  const [sort, setSort] = useState<SortKey>("title");
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const playlistCreateRequested = useUi(state => state.playlistCreateRequested);
  const acknowledgePlaylistCreate = useUi(state => state.acknowledgePlaylistCreate);

  useEffect(() => {
    if (tab !== "playlists" || !playlistCreateRequested) return;
    setCreating(true);
    setNewName("");
    acknowledgePlaylistCreate();
  }, [tab, playlistCreateRequested, acknowledgePlaylistCreate]);

  const tracks = useMemo(() => {
    let list = [...(snapshot?.tracks ?? [])];
    if (tab === "favorites") list = list.filter(track => track.favorite);
    const needle = deferredFilter.trim().toLocaleLowerCase();
    if (needle) {
      list = list.filter(track =>
        [track.title, track.artist, track.album].some(value => value.toLocaleLowerCase().includes(needle))
      );
    }
    switch (sort) {
      case "artist":
        list.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
        break;
      case "album":
        list.sort((a, b) => a.album.localeCompare(b.album) || (a.trackNo ?? 0) - (b.trackNo ?? 0));
        break;
      case "added":
        list.sort((a, b) => b.addedAt - a.addedAt);
        break;
      case "duration":
        list.sort((a, b) => b.duration - a.duration);
        break;
      default:
        list.sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [snapshot?.tracks, tab, sort, deferredFilter]);

  if (!snapshot) return <div className="view-loading">Loading…</div>;

  const playAll = () => void playQueue(tracks.map(track => track.id), 0);

  return (
    <div className="view library-view" data-testid={`library-view-${tab}`}>
      <header className="view-heading">
        <div>
          <p className="eyebrow">Your library</p>
          <h1>{TITLES[tab]}</h1>
          <p className="muted">
            {snapshot.counts.tracks} songs · {snapshot.counts.albums} albums · {snapshot.counts.artists} artists
          </p>
        </div>
        <div className="heading-actions">
          {tracks.length > 0 ? (
            <>
              <button type="button" className="primary" onClick={playAll}>
                <Play size={16} fill="currentColor" /> Play
              </button>
              <button type="button" onClick={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * tracks.length))}>
                <Shuffle size={16} /> Shuffle
              </button>
            </>
          ) : null}
          <button type="button" onClick={() => void addFolder()} disabled={scanning}>
            <FolderPlus size={16} /> Add folder
          </button>
        </div>
      </header>

      {tab === "songs" || tab === "favorites" ? (
        <>
          <div className="list-toolbar">
            <label className="inline-search">
              <Search size={15} />
              <input
                type="text"
                placeholder="Filter songs"
                value={filter}
                onChange={event => setFilter(event.target.value)}
              />
            </label>
            <label className="sort-select">
              Sort
              <select value={sort} onChange={event => setSort(event.target.value as SortKey)}>
                <option value="title">Title</option>
                <option value="artist">Artist</option>
                <option value="album">Album</option>
                <option value="added">Recently added</option>
                <option value="duration">Duration</option>
              </select>
            </label>
            <span className="muted">{tracks.length} songs</span>
          </div>
          <TrackList
            tracks={tracks}
            testId="library-track-list"
            emptyMessage={tab === "favorites" ? "Heart a song and it will show up here." : "No songs match this filter."}
          />
        </>
      ) : null}

      {tab === "albums" ? (
        <div className="card-grid">
          {snapshot.albums.map(album => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      ) : null}

      {tab === "artists" ? (
        <div className="card-grid artist-grid">
          {snapshot.artists.map(artist => (
            <ArtistCard key={artist.id} artist={artist} />
          ))}
        </div>
      ) : null}

      {tab === "playlists" ? (
        <>
          <div className="list-toolbar">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setCreating(true);
                setNewName("");
              }}
            >
              <Plus size={16} /> New playlist
            </button>
            <button type="button" onClick={() => void rescan()} disabled={scanning}>
              Rescan library
            </button>
          </div>
          {creating ? (
            <form
              className="inline-create"
              onSubmit={async event => {
                event.preventDefault();
                if (!newName.trim()) return;
                const playlist = await createPlaylist(newName.trim());
                setCreating(false);
                if (playlist) navigate({ name: "playlist", playlistId: playlist.id });
              }}
            >
              <input
                autoFocus
                value={newName}
                placeholder="Playlist name"
                onChange={event => setNewName(event.target.value)}
              />
              <button type="submit" className="primary">
                Create
              </button>
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </form>
          ) : null}
          {snapshot.playlists.length === 0 ? (
            <div className="empty-state">Create a playlist to collect songs across albums.</div>
          ) : (
            <div className="playlist-rows">
              {snapshot.playlists.map(playlist => (
                <div className="playlist-row" key={playlist.id}>
                  <button
                    type="button"
                    className="playlist-open"
                    onClick={() => navigate({ name: "playlist", playlistId: playlist.id })}
                  >
                    <PlaylistCard playlist={playlist} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`Delete ${playlist.name}`}
                    onClick={() => void deletePlaylist(playlist.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
