/**
 * History: the user's genuine listening history, persistent across restarts.
 * Written for Cadence.
 */

import { useCallback, useEffect } from "react";
import { Trash2 } from "lucide-react";
import type { HistoryEntry } from "../../../shared/types";
import { useHistory } from "../../state/historyStore";
import { selectTrack } from "../../state/libraryStore";
import { usePlayer } from "../../state/playerStore";
import { useUi } from "../../state/uiStore";
import { formatTime } from "../../player/queue";
import { Artwork } from "../../components/Artwork";
import { SourceBadge } from "../../components/SourceBadge";
import { mediaItemFromHistoryPayload } from "../../../shared/media";

export function HistoryView() {
  const { entries, loading, error, load, clear } = useHistory(state => state);
  const playTrack = usePlayer(state => state.playTrack);
  const showToast = useUi(state => state.showToast);

  useEffect(() => {
    void load();
  }, [load]);

  const playMediaItem = usePlayer(state => state.playMediaItem);

  const handlePlay = useCallback(
    (entry: HistoryEntry) => {
      if (entry.source.kind === "local") {
        const track = selectTrack(entry.source.trackId);
        if (!track) {
          void showToast("This track is no longer in your library.");
          return;
        }
        void playTrack(entry.source.trackId);
        return;
      }
      // Remote (YouTube Music) history entries keep their string source identity; replaying one
      // re-enters the unified queue as a youtube-music item, never as a fake local id.
      const item = mediaItemFromHistoryPayload(entry.payload);
      if (!item) {
        void showToast("This entry cannot be replayed.");
        return;
      }
      void playMediaItem(item);
    },
    [playTrack, playMediaItem, showToast],
  );

  const handleClear = useCallback(() => {
    if (
      !window.confirm(
        "Clear your entire listening history? This cannot be undone and entries will not be recoverable.",
      )
    ) {
      return;
    }
    void clear();
  }, [clear]);

  if (loading) {
    return <div className="view-loading">Loading history…</div>;
  }

  // A storage error (e.g. a failed clear) must never hide entries that are safely
  // in the store: that would make history look deleted when it is not, and with the
  // clear button gone there would be no way to recover in-session. The full-page
  // error is only for having nothing to show; otherwise the list renders with the
  // error surfaced as a banner above it.
  if (error && entries.length === 0) {
    return (
      <div className="empty-state" data-testid="history-error">
        <p>Unable to load listening history.</p>
        <p className="muted">{error}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="empty-state" data-testid="history-empty">
        <p>No listening history yet.</p>
        <p className="muted">
          Tracks you play appear here, newest first, and stay available after you restart Cadence.
        </p>
      </div>
    );
  }

  return (
    <div className="view" data-testid="history-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">History</p>
          <h1>Listening history</h1>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className="danger"
            onClick={handleClear}
            data-testid="clear-history"
          >
            <Trash2 size={16} />
            <span>Clear history</span>
          </button>
        </div>
      </header>

      {error ? (
        <div className="empty-state" data-testid="history-error">
          <p>Something went wrong with listening history storage.</p>
          <p className="muted">{error}</p>
        </div>
      ) : null}

      <div className="history-list">
        {entries.map(entry => {
          const track = entry.source.kind === "local" ? selectTrack(entry.source.trackId) : null;
          const available = entry.source.kind === "local" ? track !== null : true;
          const payload = entry.payload;
          const title = payload.title || "Unknown title";
          return (
            <button
              type="button"
              key={entry.id}
              className={`history-row${available ? "" : " history-row-unavailable"}`}
              onClick={() => void handlePlay(entry)}
              data-testid="history-entry"
              data-source-kind={entry.source.kind}
            >
              <div className="history-artwork">
                <Artwork src={payload.artworkUrl ?? null} alt={payload.album || title} size="xs" />
              </div>
              <div className="history-info">
                <strong title={title}>{title}</strong>
                <span>
                  {payload.artist}{payload.album ? ` · ${payload.album}` : ""}
                </span>
              </div>
              <SourceBadge source={entry.source} />
              <span className="history-time">{formatTime(payload.duration)}</span>
              {!available ? (
                <span
                  className="history-muted"
                  title={
                    entry.source.kind === "local"
                      ? "This file was removed from the library."
                      : "Remote playback is not available in this build."
                  }
                >
                  unavailable
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
