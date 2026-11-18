/**
 * Album, artist, playlist and search views. Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock3, ListMusic, Mic2, Play, Plus, RefreshCw, Search, Shuffle, Sparkles, Trash2, X } from "lucide-react";
import type { Playlist, SmartPlaylistPreset, SmartPlaylistRule, Track } from "../../../shared/types";
import {
  SMART_PLAYLIST_PRESETS,
  describeSmartPlaylistRule,
  evaluateSmartPlaylist,
  normalizeSmartPlaylistRule,
} from "../../../shared/smartPlaylists";
import { useLibrary } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { TrackList } from "../../components/TrackList";
import { usePresence } from "../../app/usePresence";
import { AlbumCard, ArtistCard } from "../../components/Cards";
import { Artwork } from "../../components/Artwork";
import { ArtistAvatar, ArtistImageCredit } from "../../components/ArtistAvatar";
import { useArtistImages } from "../../state/artistImageStore";

function Hero({
  artworkUrl,
  eyebrow,
  title,
  subtitle,
  meta,
  collection,
  onPlay,
  onShuffle,
  artistName,
  children,
}: {
  artworkUrl: string | null;
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta: string;
  collection: "albums" | "artists" | "playlists";
  onPlay?: () => void;
  onShuffle?: () => void;
  /** When set, the hero shows that artist's circular portrait instead of album artwork. */
  artistName?: string;
  children?: React.ReactNode;
}) {
  const navigate = useUi(state => state.navigate);
  return (
    <>
      <div className="detail-path">
        <button type="button" onClick={() => navigate({ name: "library", tab: collection })}>
          <ChevronLeft size={16} /> {collection[0].toUpperCase() + collection.slice(1)}
        </button>
        <ChevronRight size={13} aria-hidden="true" />
        <span title={title}>{title}</span>
      </div>
      <header className="detail-hero" data-testid="detail-hero">
        {artistName ? (
          <ArtistAvatar name={artistName} size="xl" />
        ) : (
          <Artwork src={artworkUrl} alt={title} size="xl" fallbackIcon={collection === "playlists" ? <ListMusic className="artwork-fallback-icon" aria-hidden="true" /> : undefined} />
        )}
        <div className="detail-meta">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {subtitle ? <p className="detail-artist">{subtitle}</p> : null}
          <p className="muted">{meta}</p>
          {artistName ? <ArtistImageCredit name={artistName} /> : null}
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
    </>
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
        collection="albums"
        title={album.name}
        subtitle={album.albumArtist}
        meta={`${album.year ? `${album.year} · ` : ""}${album.trackCount} ${album.trackCount === 1 ? "song" : "songs"} · ${formatTime(album.duration)}`}
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
  const refreshArtistImage = useArtistImages(state => state.refresh);
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
        collection="artists"
        title={artist.name}
        artistName={artist.name}
        meta={`${artist.trackCount} songs · ${artist.albumCount} albums`}
        onPlay={() => void playQueue(tracks.map(track => track.id), 0)}
        onShuffle={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * tracks.length))}
      >
        <button
          type="button"
          onClick={() => void refreshArtistImage(artist.name)}
          data-testid="refresh-artist-photo"
          title="Look up this artist's picture again"
        >
          <RefreshCw size={16} /> Refresh photo
        </button>
      </Hero>
      <div className="shelf">
        <h2>Albums</h2>
        <div className="card-grid">
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
  const [result, setResult] = useState<{ term: string; tracks: Track[]; failed?: true }>();
  const term = query.trim();
  const needle = term.toLocaleLowerCase();
  const current = result?.term === term ? result : null;
  const tracks = current?.tracks ?? [];
  const searching = Boolean(term && !current);

  useEffect(() => {
    if (!term) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void search(term).then(
        tracks => { if (!cancelled) setResult({ term, tracks }); },
        () => { if (!cancelled) setResult({ term, tracks: [], failed: true }); }
      );
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, term]);

  const albums = (snapshot?.albums ?? []).filter(
    album => needle && (album.name.toLocaleLowerCase().includes(needle) || album.albumArtist.toLocaleLowerCase().includes(needle))
  );
  const artists = (snapshot?.artists ?? []).filter(artist => needle && artist.name.toLocaleLowerCase().includes(needle));
  const counts = [
    `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`,
    `${albums.length} ${albums.length === 1 ? "album" : "albums"}`,
    `${artists.length} ${artists.length === 1 ? "artist" : "artists"}`,
  ].join(" · ");

  return (
    <div className="view search-view" data-testid="search-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Your library</p>
          <h1>Search</h1>
          <p className="muted search-summary" role="status">
            {term ? (
              <>Results for <strong>“{term}”</strong> · {searching ? "Searching…" : current?.failed
                ? "Song search unavailable" : counts}</>
            ) : "Find a song, album or artist."}
          </p>
        </div>
      </header>

      {artists.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading"><h2>Artists</h2><span className="muted">{artists.length}</span></div>
          <div className="card-grid artist-grid">
            {artists.slice(0, 8).map(artist => (
              <ArtistCard key={artist.id} artist={artist} />
            ))}
          </div>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section className="shelf">
          <div className="shelf-heading"><h2>Albums</h2><span className="muted">{albums.length}</span></div>
          <div className="card-grid">
            {albums.slice(0, 8).map(album => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      ) : null}

      {term && current && !current.failed && tracks.length === 0 && albums.length === 0 && artists.length === 0 ? (
        <div className="empty-state search-empty">
          <Search size={28} aria-hidden="true" />
          <h2>No matches</h2>
          <p>Try a different song, artist or album name.</p>
        </div>
      ) : (
        <section className="shelf">
          <div className="shelf-heading">
            <h2>Songs</h2>
            {tracks.length > 0 ? (
              <button type="button" className="link" onClick={() => void playQueue(tracks.map(track => track.id), 0)}>
                Play all
              </button>
            ) : null}
          </div>
          {term ? (
            <TrackList
              tracks={tracks}
              emptyMessage={searching ? "Searching…" : current?.failed ? "Could not search songs. Try again." : "No songs match that search."}
              testId="search-track-list"
            />
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
      )}
    </div>
  );
}

export function PlaylistView({ playlistId }: { playlistId: number }) {
  const snapshot = useLibrary(state => state.snapshot);
  const removeFromPlaylist = useLibrary(state => state.removeFromPlaylist);
  const renamePlaylist = useLibrary(state => state.renamePlaylist);
  const addToPlaylist = useLibrary(state => state.addToPlaylist);
  const updateSmartPlaylist = useLibrary(state => state.updateSmartPlaylist);
  const showToast = useUi(state => state.showToast);
  const playQueue = usePlayer(state => state.playQueue);
  const playShuffled = usePlayer(state => state.playShuffled);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [adding, setAdding] = useState(false);
  const addingPresence = usePresence(adding);
  const [addQuery, setAddQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [editingRule, setEditingRule] = useState(false);
  const [rulePreset, setRulePreset] = useState<SmartPlaylistPreset>("most-played");
  const [ruleValue, setRuleValue] = useState("");
  const [ruleLimit, setRuleLimit] = useState("100");
  const playlist = snapshot?.playlists.find((entry: Playlist) => entry.id === playlistId);

  useEffect(() => {
    let cancelled = false;
    void window.cadence.playlists.tracks(playlistId).then(result => {
      if (!cancelled) setTracks(result);
    });
    return () => {
      cancelled = true;
    };
  }, [playlistId, snapshot?.playlists, snapshot?.tracks]);

  const candidates = useMemo(() => {
    const needle = addQuery.trim().toLocaleLowerCase();
    const existing = new Set(tracks.map(track => track.id));
    return (snapshot?.tracks ?? [])
      .filter(track => !existing.has(track.id))
      .filter(track => !needle || [track.title, track.artist, track.album].some(value => value.toLocaleLowerCase().includes(needle)))
      .slice(0, 40);
  }, [snapshot?.tracks, tracks, addQuery]);

  const smartRule = playlist?.smart ? normalizeSmartPlaylistRule(playlist.smart) : null;
  const isSmart = Boolean(smartRule);
  const rulePresetInfo = SMART_PLAYLIST_PRESETS[rulePreset];
  const normalizedEditedRule = useMemo(() => {
    const rule: SmartPlaylistRule = { preset: rulePreset };
    if (SMART_PLAYLIST_PRESETS[rulePreset].needsValue) rule.value = ruleValue.trim();
    const limit = Number(ruleLimit);
    if (ruleLimit && Number.isFinite(limit)) rule.limit = limit;
    return normalizeSmartPlaylistRule(rule);
  }, [ruleLimit, rulePreset, ruleValue]);
  const editedRulePreviewCount = useMemo(
    () =>
      normalizedEditedRule
        ? evaluateSmartPlaylist(snapshot?.tracks ?? [], normalizedEditedRule).length
        : null,
    [normalizedEditedRule, snapshot?.tracks],
  );
  const openRuleEditor = () => {
    if (!smartRule) return;
    setRulePreset(smartRule.preset);
    setRuleValue(smartRule.value ?? "");
    setRuleLimit(smartRule.limit?.toString() ?? "");
    setEditingRule(true);
  };

  if (!playlist) return <div className="empty-state">Playlist not found.</div>;

  return (
    <div className="view detail-view">
      <Hero
        artworkUrl={playlist.artworkUrl}
        eyebrow={isSmart ? "Smart playlist" : "Playlist"}
        title={playlist.name}
        collection="playlists"
        meta={`${playlist.trackCount} songs · ${formatTime(playlist.duration)}${smartRule ? ` · ${describeSmartPlaylistRule(smartRule)}` : ""}`}
        onPlay={() => void playQueue(tracks.map(track => track.id), 0)}
        onShuffle={() => void playShuffled(tracks.map(track => track.id), Math.floor(Math.random() * Math.max(1, tracks.length)))}
      >
        {isSmart ? (
          <button type="button" data-testid="edit-smart-rule" onClick={openRuleEditor}>
            <Sparkles size={16} /> Edit rule
          </button>
        ) : (
          <button type="button" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add songs
          </button>
        )}
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

      {smartRule && !editingRule ? (
        <div className="smart-rule-banner" data-testid="smart-rule-banner">
          <div>
            <strong>{describeSmartPlaylistRule(smartRule)}</strong>
            <p>This playlist updates itself from your library, so songs can’t be added or removed by hand.</p>
          </div>
          <button type="button" onClick={openRuleEditor}>
            <Sparkles size={15} /> Edit rule
          </button>
        </div>
      ) : null}

      {smartRule && editingRule ? (
        <form
          className="smart-playlist-form"
          data-testid="smart-rule-form"
          onSubmit={async event => {
            event.preventDefault();
            if (!normalizedEditedRule) {
              showToast(`Enter a ${rulePresetInfo.valueLabel.toLowerCase()} for that rule.`);
              return;
            }
            await updateSmartPlaylist(playlist.id, normalizedEditedRule);
            setEditingRule(false);
            showToast("Smart playlist updated");
          }}
        >
          <div className="smart-playlist-fields">
            <label className="field">
              <span>Rule</span>
              <select
                value={rulePreset}
                data-testid="smart-rule-preset"
                onChange={event => setRulePreset(event.target.value as SmartPlaylistPreset)}
              >
                {Object.entries(SMART_PLAYLIST_PRESETS).map(([preset, info]) => (
                  <option key={preset} value={preset}>
                    {info.label}
                  </option>
                ))}
              </select>
            </label>
            {rulePresetInfo.needsValue ? (
              <label className="field">
                <span>{rulePresetInfo.valueLabel}</span>
                <input
                  value={ruleValue}
                  placeholder={rulePresetInfo.valueLabel}
                  data-testid="smart-rule-value"
                  onChange={event => setRuleValue(event.target.value)}
                />
              </label>
            ) : null}
            <label className="field">
              <span>Limit</span>
              <select
                value={ruleLimit}
                data-testid="smart-rule-limit"
                onChange={event => setRuleLimit(event.target.value)}
              >
                <option value="25">25 songs</option>
                <option value="50">50 songs</option>
                <option value="100">100 songs</option>
                <option value="250">250 songs</option>
                <option value="">No limit</option>
              </select>
            </label>
          </div>
          <p className="muted" data-testid="smart-rule-preview">
            {rulePresetInfo.description}{" "}
            {editedRulePreviewCount === null
              ? `Enter a ${rulePresetInfo.valueLabel.toLowerCase()} to preview it.`
              : `${editedRulePreviewCount} song${editedRulePreviewCount === 1 ? "" : "s"} match right now.`}
          </p>
          <div className="heading-actions">
            <button type="submit" className="primary" data-testid="smart-rule-save" disabled={!normalizedEditedRule}>
              Save rule
            </button>
            <button type="button" onClick={() => setEditingRule(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <TrackList
        tracks={tracks}
        onRemove={
          isSmart
            ? undefined
            : track => {
                void removeFromPlaylist(playlist.id, track.id).then(() =>
                  setTracks(previous => previous.filter(candidate => candidate.id !== track.id)),
                );
              }
        }
        emptyMessage={isSmart ? "No songs match this rule yet." : "This playlist is empty. Add some songs."}
        testId="playlist-track-list"
      />

      {!isSmart && addingPresence.mounted ? (
        <div
          className={`modal-backdrop ${addingPresence.phaseClass}`}
          data-presence={addingPresence.phase}
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
