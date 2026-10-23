/**
 * "Add to playlist" modal. Written for Cadence.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { EMPTY_PLAYLISTS, useLibrary } from "../state/libraryStore";
import { useUi } from "../state/uiStore";

export function PlaylistPicker() {
  const picker = useUi(state => state.playlistPicker);
  const close = useUi(state => state.closePlaylistPicker);
  const playlists = useLibrary(state => state.snapshot?.playlists ?? EMPTY_PLAYLISTS);
  const createPlaylist = useLibrary(state => state.createPlaylist);
  const addToPlaylist = useLibrary(state => state.addToPlaylist);
  const showToast = useUi(state => state.showToast);
  const [name, setName] = useState("");

  if (!picker) return null;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal compact" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <h2>Add to playlist</h2>
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
                await addToPlaylist(playlist.id, picker.trackIds);
                showToast(`Added to ${playlist.name}`);
                close();
              }}
            >
              <span>
                <strong>{playlist.name}</strong>
                <em>{playlist.trackCount} songs</em>
              </span>
            </button>
          ))}
        </div>
        <form
          className="inline-create"
          onSubmit={async event => {
            event.preventDefault();
            if (!name.trim()) return;
            const playlist = await createPlaylist(name.trim(), picker.trackIds);
            setName("");
            if (playlist) showToast(`Added to ${playlist.name}`);
            close();
          }}
        >
          <input value={name} onChange={event => setName(event.target.value)} placeholder="New playlist name" />
          <button type="submit" className="primary">
            <Plus size={15} /> Create
          </button>
        </form>
      </div>
    </div>
  );
}
