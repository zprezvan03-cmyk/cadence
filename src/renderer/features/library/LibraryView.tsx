/**
 * Library browsing: songs, albums, artists, playlists and favourites. Written for Cadence.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Copy,
  FolderOpen,
  FolderPlus,
  Layers,
  ListPlus,
  Play,
  Plus,
  Search,
  Shuffle,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { SmartPlaylistPreset, SmartPlaylistRule, Track } from "../../../shared/types";
import {
  SMART_PLAYLIST_PRESETS,
  describeSmartPlaylistRule,
  evaluateSmartPlaylist,
  normalizeSmartPlaylistRule,
} from "../../../shared/smartPlaylists";
import type { LibraryTab } from "../../state/uiStore";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { TrackList } from "../../components/TrackList";
import { AlbumCard, ArtistCard, PlaylistCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";
import { useSessionState } from "../../app/useSessionState";
import { formatTime } from "../../player/queue";
import { findDuplicateGroups, formatFileSize } from "./duplicates";

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
  const createSmartPlaylist = useLibrary(state => state.createSmartPlaylist);
  const deletePlaylist = useLibrary(state => state.deletePlaylist);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const playTrack = usePlayer(state => state.playTrack);
  const navigate = useUi(state => state.navigate);
  const showToast = useUi(state => state.showToast);
  // Sort and filter belong to the list, not to the mount: coming back to Songs should show the
  // list the user left, not the default order.
  const [sort, setSort] = useSessionState<SortKey>("library.sort", "title");
  const [filter, setFilter] = useSessionState("library.filter", "");
  const deferredFilter = useDeferredValue(filter);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingSmart, setCreatingSmart] = useState(false);
  const [smartName, setSmartName] = useState("");
  const [smartPreset, setSmartPreset] = useState<SmartPlaylistPreset>("most-played");
  const [smartValue, setSmartValue] = useState("");
  const [smartLimit, setSmartLimit] = useState("100");
  const [showDuplicates, setShowDuplicates] = useState(false);
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

  const smartPresetInfo = SMART_PLAYLIST_PRESETS[smartPreset];
  const normalizedSmartRule = useMemo(() => {
    const rule: SmartPlaylistRule = { preset: smartPreset };
    if (SMART_PLAYLIST_PRESETS[smartPreset].needsValue) rule.value = smartValue.trim();
    const limit = Number(smartLimit);
    if (smartLimit && Number.isFinite(limit)) rule.limit = limit;
    return normalizeSmartPlaylistRule(rule);
  }, [smartLimit, smartPreset, smartValue]);
  const smartPreviewCount = useMemo(
    () =>
      normalizedSmartRule
        ? evaluateSmartPlaylist(snapshot?.tracks ?? [], normalizedSmartRule).length
        : null,
    [normalizedSmartRule, snapshot?.tracks],
  );
  const duplicateGroups = useMemo(
    () => (showDuplicates ? findDuplicateGroups(snapshot?.tracks ?? []) : []),
    [showDuplicates, snapshot?.tracks],
  );
  const duplicateExtraCopies = duplicateGroups.reduce(
    (sum, group) => sum + Math.max(0, group.tracks.length - 1),
    0,
  );
  const duplicateReclaimableBytes = duplicateGroups.reduce(
    (sum, group) => sum + group.reclaimableBytes,
    0,
  );

  if (!snapshot) return <div className="view-loading">Loading…</div>;

  const playAll = () => void playQueue(tracks.map(track => track.id), 0);

  const createDuplicateReviewPlaylist = async (name: string, groupTracks: Track[]) => {
    const trackIds = [...new Set(groupTracks.map(track => track.id))];
    if (trackIds.length === 0) return;
    const playlist = await createPlaylist(name, trackIds);
    if (playlist) {
      showToast(`Created ${playlist.name}`);
      navigate({ name: "playlist", playlistId: playlist.id });
    }
  };

  const copyDuplicatePaths = async (groupTracks: Track[]) => {
    try {
      await navigator.clipboard.writeText(groupTracks.map(track => track.path).join("\n"));
      showToast("File paths copied");
    } catch {
      showToast("Could not copy file paths");
    }
  };

  const showTrackInFolder = async (track: Track) => {
    try {
      await window.cadence?.app.openPath(track.path);
    } catch {
      showToast("Could not open that folder");
    }
  };

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
            <button
              type="button"
              data-testid="find-duplicates"
              onClick={() => setShowDuplicates(previous => !previous)}
            >
              <Layers size={15} /> {showDuplicates ? "Hide duplicates" : "Find duplicates"}
            </button>
            <span className="muted">{tracks.length} songs</span>
          </div>
          {showDuplicates ? (
            <section className="duplicates-panel" data-testid="duplicates-panel">
              <div className="duplicates-summary">
                <div>
                  <h2>Likely duplicates</h2>
                  <p>
                    {duplicateGroups.length === 0
                      ? "No likely duplicates found. Cadence compared titles, artists, and track lengths across your whole library."
                      : `${duplicateGroups.length} group${duplicateGroups.length === 1 ? "" : "s"} · ${duplicateExtraCopies} extra cop${duplicateExtraCopies === 1 ? "y" : "ies"} · ${formatFileSize(duplicateReclaimableBytes)} in spare copies. Cadence never deletes files here — review a group, keep the copy you want, and remove spare files yourself if you choose.`}
                  </p>
                </div>
                {duplicateGroups.length > 0 ? (
                  <button
                    type="button"
                    className="primary"
                    data-testid="duplicate-review-all"
                    onClick={() =>
                      void createDuplicateReviewPlaylist(
                        "Duplicate review",
                        duplicateGroups.flatMap(group => group.tracks),
                      )
                    }
                  >
                    <ListPlus size={15} /> Review all in a playlist
                  </button>
                ) : null}
              </div>

              {duplicateGroups.map(group => (
                <article className="duplicate-group" key={group.id} data-testid="duplicate-group">
                  <header className="duplicate-group-header">
                    <div>
                      <h3>{group.title}</h3>
                      <p>
                        {group.artist} · {group.tracks.length} copies · {formatFileSize(group.reclaimableBytes)} in
                        spare copies
                      </p>
                    </div>
                    <div className="heading-actions">
                      <button
                        type="button"
                        data-testid="duplicate-review-group"
                        onClick={() =>
                          void createDuplicateReviewPlaylist(`Duplicate review: ${group.title}`, group.tracks)
                        }
                      >
                        <ListPlus size={15} /> Review playlist
                      </button>
                      <button type="button" onClick={() => void copyDuplicatePaths(group.tracks)}>
                        <Copy size={15} /> Copy paths
                      </button>
                    </div>
                  </header>
                  <div className="duplicate-track-list">
                    {group.tracks.map(track => (
                      <div className="duplicate-track-row" key={track.id} data-testid="duplicate-track">
                        <Artwork src={track.artworkUrl} alt={track.album || track.title} size="xs" />
                        <div className="duplicate-track-copy">
                          <strong>
                            {track.title}
                            {track.id === group.keeperId ? (
                              <span className="keeper-badge">Recommended keeper</span>
                            ) : null}
                          </strong>
                          <span>
                            {track.album} · {formatTime(track.duration)} · {track.codec || track.container} ·{" "}
                            {formatFileSize(track.fileSize)} · {track.playCount} plays
                            {track.favorite ? " · liked" : ""}
                            {track.metadataEdited ? " · edited in Cadence" : ""}
                          </span>
                          <em title={track.path}>{track.path}</em>
                        </div>
                        <div className="duplicate-track-actions">
                          <button type="button" onClick={() => void playTrack(track.id)}>
                            <Play size={14} /> Play
                          </button>
                          <button type="button" onClick={() => void showTrackInFolder(track)}>
                            <FolderOpen size={14} /> Show in folder
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </section>
          ) : null}
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
                setCreatingSmart(false);
                setNewName("");
              }}
            >
              <Plus size={16} /> New playlist
            </button>
            <button
              type="button"
              data-testid="new-smart-playlist"
              onClick={() => {
                setCreatingSmart(true);
                setCreating(false);
              }}
            >
              <Sparkles size={16} /> New smart playlist
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
          {creatingSmart ? (
            <form
              className="smart-playlist-form"
              data-testid="smart-playlist-form"
              onSubmit={async event => {
                event.preventDefault();
                if (!normalizedSmartRule) {
                  showToast(`Enter a ${smartPresetInfo.valueLabel.toLowerCase()} for that smart playlist.`);
                  return;
                }
                const fallbackName = describeSmartPlaylistRule(normalizedSmartRule).replace(/ · up to .*$/, "");
                const playlist = await createSmartPlaylist(smartName.trim() || fallbackName, normalizedSmartRule);
                setCreatingSmart(false);
                if (playlist) navigate({ name: "playlist", playlistId: playlist.id });
              }}
            >
              <div className="smart-playlist-fields">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={smartName}
                    placeholder={smartPresetInfo.label}
                    data-testid="smart-playlist-name"
                    onChange={event => setSmartName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Rule</span>
                  <select
                    value={smartPreset}
                    data-testid="smart-playlist-preset"
                    onChange={event => setSmartPreset(event.target.value as SmartPlaylistPreset)}
                  >
                    {Object.entries(SMART_PLAYLIST_PRESETS).map(([preset, info]) => (
                      <option key={preset} value={preset}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </label>
                {smartPresetInfo.needsValue ? (
                  <label className="field">
                    <span>{smartPresetInfo.valueLabel}</span>
                    <input
                      value={smartValue}
                      placeholder={smartPresetInfo.valueLabel}
                      data-testid="smart-playlist-value"
                      onChange={event => setSmartValue(event.target.value)}
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>Limit</span>
                  <select
                    value={smartLimit}
                    data-testid="smart-playlist-limit"
                    onChange={event => setSmartLimit(event.target.value)}
                  >
                    <option value="25">25 songs</option>
                    <option value="50">50 songs</option>
                    <option value="100">100 songs</option>
                    <option value="250">250 songs</option>
                    <option value="">No limit</option>
                  </select>
                </label>
              </div>
              <p className="muted" data-testid="smart-playlist-preview">
                {smartPresetInfo.description}{" "}
                {smartPreviewCount === null
                  ? `Enter a ${smartPresetInfo.valueLabel.toLowerCase()} to preview it.`
                  : `${smartPreviewCount} song${smartPreviewCount === 1 ? "" : "s"} match right now.`}
              </p>
              <div className="heading-actions">
                <button type="submit" className="primary" disabled={!normalizedSmartRule}>
                  Create smart playlist
                </button>
                <button type="button" onClick={() => setCreatingSmart(false)}>
                  Cancel
                </button>
              </div>
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
