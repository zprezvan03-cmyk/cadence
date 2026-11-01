/**
 * Track detail editor. Edits are saved in Cadence's library as durable overrides that are
 * re-applied after rescans; the audio file itself is never modified. Written for Cadence.
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { Track, TrackMetadataEdit } from "../../../shared/types";
import { Artwork } from "../../components/Artwork";
import { useLibrary } from "../../state/libraryStore";
import { useUi } from "../../state/uiStore";
import { useLastNonNull, usePresence } from "../../app/usePresence";

interface DraftFields {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: string;
  trackNo: string;
  discNo: string;
}

function parseOptionalNumber(label: string, value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 9999) {
    throw new Error(`${label} must be a whole number between 1 and 9999, or left blank.`);
  }
  return parsed;
}

function TrackEditorForm({ track, onClose }: { track: Track; onClose: () => void }) {
  const updateTrackMetadata = useLibrary(state => state.updateTrackMetadata);
  const resetTrackMetadata = useLibrary(state => state.resetTrackMetadata);
  const setTrackArtwork = useLibrary(state => state.setTrackArtwork);
  const removeTrackArtwork = useLibrary(state => state.removeTrackArtwork);
  const resetTrackArtwork = useLibrary(state => state.resetTrackArtwork);
  const showToast = useUi(state => state.showToast);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fields, setFields] = useState<DraftFields>({
    title: track.title,
    artist: track.artist,
    albumArtist: track.albumArtist,
    album: track.album,
    genre: track.genre,
    year: track.year?.toString() ?? "",
    trackNo: track.trackNo?.toString() ?? "",
    discNo: track.discNo?.toString() ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const override = track.metadataOverride ?? null;
  const hasArtworkPatch = Boolean(
    override && Object.prototype.hasOwnProperty.call(override.patch, "artworkFile"),
  );

  const setField = (key: keyof DraftFields, value: string) =>
    setFields(previous => ({ ...previous, [key]: value }));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (!fields.title.trim()) throw new Error("Give the track a title.");
      const edit: TrackMetadataEdit = {
        title: fields.title.trim(),
        artist: fields.artist.trim(),
        albumArtist: fields.albumArtist.trim(),
        album: fields.album.trim(),
        genre: fields.genre.trim(),
        year: parseOptionalNumber("Year", fields.year),
        trackNo: parseOptionalNumber("Track number", fields.trackNo),
        discNo: parseOptionalNumber("Disc number", fields.discNo),
      };
      await updateTrackMetadata(track.id, edit);
      showToast("Track details saved");
      onClose();
    });
  };

  const handleArtworkFile = (file: File | null) => {
    if (!file) return;
    void run(async () => {
      const data = await file.arrayBuffer();
      await setTrackArtwork(track.id, data, file.type || "image/jpeg");
      showToast("Cover updated");
    });
  };

  const handleResetAll = () => {
    if (!window.confirm("Reset this track to the details scanned from its file? Your Cadence edits for it will be discarded.")) {
      return;
    }
    void run(async () => {
      await resetTrackMetadata(track.id);
      showToast("Reset to file tags");
      onClose();
    });
  };

  return (
    <form className="track-editor" onSubmit={handleSave} data-testid="track-editor">
      <header className="modal-header">
        <h2>Edit track details</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      <div className="track-editor-layout">
        <div className="track-editor-artwork">
          <Artwork src={track.artworkUrl} alt={track.album || track.title} size="xl" />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            data-testid="track-editor-artwork-input"
            hidden
            onChange={event => {
              handleArtworkFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            data-testid="track-editor-choose-artwork"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={15} /> Choose cover…
          </button>
          {track.artworkUrl ? (
            <button
              type="button"
              data-testid="track-editor-remove-artwork"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await removeTrackArtwork(track.id);
                  showToast("Cover removed");
                })
              }
            >
              <Trash2 size={15} /> Remove cover
            </button>
          ) : null}
          {hasArtworkPatch ? (
            <button
              type="button"
              data-testid="track-editor-reset-artwork"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await resetTrackArtwork(track.id);
                  showToast("Using the cover from the file");
                })
              }
            >
              <RotateCcw size={15} /> Use cover from file
            </button>
          ) : null}
        </div>

        <div className="track-editor-fields">
          <label className="field">
            <span>Title</span>
            <input
              value={fields.title}
              data-testid="track-editor-title"
              onChange={event => setField("title", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Artist</span>
            <input
              value={fields.artist}
              data-testid="track-editor-artist"
              onChange={event => setField("artist", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Album artist</span>
            <input
              value={fields.albumArtist}
              data-testid="track-editor-album-artist"
              onChange={event => setField("albumArtist", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Album</span>
            <input
              value={fields.album}
              data-testid="track-editor-album"
              onChange={event => setField("album", event.target.value)}
            />
          </label>
          <label className="field">
            <span>Genre</span>
            <input
              value={fields.genre}
              data-testid="track-editor-genre"
              onChange={event => setField("genre", event.target.value)}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Year</span>
              <input
                value={fields.year}
                inputMode="numeric"
                data-testid="track-editor-year"
                onChange={event => setField("year", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Track №</span>
              <input
                value={fields.trackNo}
                inputMode="numeric"
                data-testid="track-editor-track-no"
                onChange={event => setField("trackNo", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Disc №</span>
              <input
                value={fields.discNo}
                inputMode="numeric"
                data-testid="track-editor-disc-no"
                onChange={event => setField("discNo", event.target.value)}
              />
            </label>
          </div>
          <p className="muted track-editor-note">
            Saved in Cadence and kept when your library is rescanned. The audio file itself is
            not changed.
            {override ? (
              <>
                {" "}
                File tags: {override.original.title} · {override.original.artist}
                {override.original.album ? ` · ${override.original.album}` : ""}.
              </>
            ) : null}
          </p>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="track-editor-actions">
        {track.metadataEdited ? (
          <button type="button" className="danger" data-testid="track-editor-reset" disabled={busy} onClick={handleResetAll}>
            <RotateCcw size={15} /> Reset to file tags
          </button>
        ) : (
          <span />
        )}
        <div className="heading-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" data-testid="track-editor-save" disabled={busy}>
            <Save size={15} /> Save details
          </button>
        </div>
      </footer>
    </form>
  );
}

export function TrackEditor() {
  const trackEditorId = useUi(state => state.trackEditorId);
  const close = useUi(state => state.closeTrackEditor);
  const presence = usePresence(trackEditorId !== null);
  const renderedId = useLastNonNull(trackEditorId);
  const track = useLibrary(state =>
    renderedId !== null ? state.tracksById.get(renderedId) ?? null : null,
  );

  useEffect(() => {
    if (trackEditorId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trackEditorId, close]);

  if (!presence.mounted || !track) return null;

  return (
    <div className={`modal-backdrop ${presence.phaseClass}`} data-presence={presence.phase} onClick={close}>
      <div className="modal track-editor-modal" onClick={event => event.stopPropagation()}>
        <TrackEditorForm key={track.id} track={track} onClose={close} />
      </div>
    </div>
  );
}
