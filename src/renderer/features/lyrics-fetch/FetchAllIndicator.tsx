/**
 * Compact Fetch All progress in the global top bar: visible on every tab while the background
 * job runs, turns into a brief checkmark when it completes, then disappears. Clicking opens the
 * job management panel (progress, counts, current track, pause/resume/cancel/retry).
 */

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { useFetchAll } from "../../state/fetchAllStore";
import { usePresence } from "../../app/usePresence";

const COMPLETED_LINGER_MS = 4000;

export function FetchAllIndicator() {
  const snapshot = useFetchAll(state => state.snapshot);
  const init = useFetchAll(state => state.init);
  const pause = useFetchAll(state => state.pause);
  const resume = useFetchAll(state => state.resume);
  const cancel = useFetchAll(state => state.cancel);
  const retryFailed = useFetchAll(state => state.retryFailed);
  const [open, setOpen] = useState(false);
  const [lingerDone, setLingerDone] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelPresence = usePresence(open);

  useEffect(() => {
    init();
  }, [init]);

  // Completion animation: checkmark briefly, then the indicator hides itself.
  useEffect(() => {
    setLingerDone(false);
    if (snapshot.state !== "completed") return;
    const timer = window.setTimeout(() => {
      setLingerDone(true);
      setOpen(false);
    }, COMPLETED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot.state, snapshot.jobId, snapshot.finishedAt]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const { state, total, processed } = snapshot;
  if (state === "idle" || state === "canceled") return null;
  if (state === "completed" && lingerDone) return null;

  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  const running = state === "running";
  const paused = state === "paused";

  return (
    <div className="fetch-indicator-wrap" ref={rootRef}>
      <button
        type="button"
        className={`fetch-indicator ${state === "completed" ? "is-complete" : ""}`}
        data-testid="fetch-all-indicator"
        data-state={state}
        aria-expanded={open}
        title="Fetch All Lyrics"
        onClick={() => setOpen(value => !value)}
      >
        {state === "completed" ? (
          <Check size={15} aria-label="Fetch All Lyrics complete" />
        ) : paused ? (
          <Pause size={14} />
        ) : (
          <Loader2 size={15} className="spin" />
        )}
        <span className="fetch-indicator-count">
          {state === "completed" ? "Done" : `${processed}/${total}`}
        </span>
        {state !== "completed" ? (
          <span className="fetch-indicator-bar" aria-hidden="true">
            <span style={{ transform: `scaleX(${percent / 100})` }} />
          </span>
        ) : null}
      </button>

      {panelPresence.mounted ? (
        <div
          className={`fetch-panel ${panelPresence.phaseClass}`}
          data-presence={panelPresence.phase}
          data-testid="fetch-all-panel"
          role="dialog"
          aria-label="Fetch All Lyrics"
        >
          <div className="fetch-panel-head">
            <strong>✨ Fetch All Lyrics</strong>
            <button type="button" className="icon-button" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="fetch-panel-progress">
            <span>
              {processed} of {total} tracks · {percent}%
            </span>
            <span className="fetch-panel-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${percent / 100})` }} />
            </span>
          </div>
          <dl className="fetch-panel-counts">
            <div>
              <dt>Found</dt>
              <dd data-testid="fetch-count-found">{snapshot.found}</dd>
            </div>
            <div>
              <dt>Not Found</dt>
              <dd data-testid="fetch-count-not-found">{snapshot.notFound}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd data-testid="fetch-count-failed">{snapshot.failed}</dd>
            </div>
            <div>
              <dt>Skipped</dt>
              <dd data-testid="fetch-count-skipped">{snapshot.skipped}</dd>
            </div>
          </dl>
          {snapshot.currentTrack ? (
            <p className="fetch-panel-current" data-testid="fetch-current-track">
              Now fetching: {snapshot.currentTrack.title}
              {snapshot.currentTrack.artist ? ` — ${snapshot.currentTrack.artist}` : ""}
            </p>
          ) : state === "completed" ? (
            <p className="fetch-panel-current">All eligible tracks have been processed.</p>
          ) : null}
          <div className="fetch-panel-actions">
            {running ? (
              <button type="button" onClick={() => void pause()}>
                <Pause size={14} /> Pause
              </button>
            ) : null}
            {paused ? (
              <button type="button" onClick={() => void resume()}>
                <Play size={14} /> Resume
              </button>
            ) : null}
            {snapshot.failed > 0 && !running ? (
              <button
                type="button"
                data-testid="fetch-retry-failed"
                onClick={() => void retryFailed()}
              >
                <RotateCcw size={14} /> Retry Failed
              </button>
            ) : null}
            {running || paused ? (
              <button
                type="button"
                className="danger"
                data-testid="fetch-cancel"
                onClick={() => {
                  void cancel();
                  setOpen(false);
                }}
              >
                <X size={14} /> Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
