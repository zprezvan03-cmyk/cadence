/**
 * "Add to playlist" modal. Written for Cadence.
 */

import { useState } from "react";
import { ListMusic, Plus, X } from "lucide-react";
import { Artwork } from "../components/Artwork";
import { MarqueeText } from "../components/MarqueeText";
import { EMPTY_PLAYLISTS, useLibrary } from "../state/libraryStore";
import { useUi } from "../state/uiStore";
import { useLastNonNull, usePresence } from "./usePresence";

export function PlaylistPicker() {
  const picker = useUi(state => state.playlistPicker);
  const close = useUi(state => state.closePlaylistPicker);
  const playlists = useLibrary(state => state.snapshot?.playlists ?? EMPTY_PLAYLISTS);
  const createPlaylist = useLibrary(state => state.createPlaylist);
  const addToPlaylist = useLibrary(state => state.addToPlaylist);
  const showToast = useUi(state => state.showToast);
  const [name, setName] = useState("");
  // The store flag flips instantly on close; presence only keeps the surface mounted for
  // its fast exit, rendering the last picker selection so the final frame is not blank.
  const presence = usePresence(Boolean(picker));
  const renderedPicker = useLastNonNull(picker);

  if (!presence.mounted || !renderedPicker) return null;

  return (
    <div className={`modal-backdrop ${presence.phaseClass}`} data-presence={presence.phase} onClick={close} inert={!picker}>
      <div className="modal compact playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2 id="playlist-picker-title">Add to playlist</h2>
            <p className="muted">Choose a playlist for {renderedPicker.trackIds.length === 1 ? "this song" : `these ${renderedPicker.trackIds.length} songs`}.</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-list">
          {playlists.map(playlist => (
            <button
              type="button"
              key={playlist.id}
              className="modal-row simple"
              onClick={async () => {
                await addToPlaylist(playlist.id, renderedPicker.trackIds);
                showToast(`Added to ${playlist.name}`);
                close();
              }}
            >
              <Artwork src={playlist.artworkUrl} alt="" size="xs" fallbackIcon={<ListMusic className="artwork-fallback-icon" aria-hidden="true" />} />
              <span>
                <MarqueeText as="strong">{playlist.name}</MarqueeText>
                <MarqueeText as="em">{playlist.trackCount} {playlist.trackCount === 1 ? "song" : "songs"}</MarqueeText>
              </span>
            </button>
          ))}
          {playlists.length === 0 ? <p className="picker-empty muted">No playlists yet. Create one below.</p> : null}
        </div>
        <form
          className="inline-create"
          onSubmit={async event => {
            event.preventDefault();
            if (!name.trim()) return;
            const playlist = await createPlaylist(name.trim(), renderedPicker.trackIds);
            setName("");
            if (playlist) showToast(`Added to ${playlist.name}`);
            close();
          }}
        >
          <input value={name} onChange={event => setName(event.target.value)} placeholder="New playlist name" aria-label="New playlist name" />
          <button type="submit" className="primary">
            <Plus size={15} /> Create
          </button>
        </form>
      </div>
    </div>
  );
}
