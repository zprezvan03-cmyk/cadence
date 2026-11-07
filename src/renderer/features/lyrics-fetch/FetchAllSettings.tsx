/**
 * Settings → Lyrics → Fetch All block: start another bulk scan, watch/manage the current job,
 * and see the last job's summary (the persisted fetch history).
 */

import { useEffect } from "react";
import { Pause, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { useFetchAll } from "../../state/fetchAllStore";

export function FetchAllSettings() {
  const snapshot = useFetchAll(state => state.snapshot);
  const stats = useFetchAll(state => state.stats);
  const init = useFetchAll(state => state.init);
  const refreshStats = useFetchAll(state => state.refreshStats);
  const start = useFetchAll(state => state.start);
  const pause = useFetchAll(state => state.pause);
  const resume = useFetchAll(state => state.resume);
  const cancel = useFetchAll(state => state.cancel);
  const retryFailed = useFetchAll(state => state.retryFailed);

  useEffect(() => {
    init();
    void refreshStats();
  }, [init, refreshStats]);

  const running = snapshot.state === "running";
  const paused = snapshot.state === "paused";
  const percent = snapshot.total > 0 ? Math.round((snapshot.processed / snapshot.total) * 100) : 0;

  return (
    <div className="fetch-settings" data-testid="fetch-all-settings">
      <div className="setting-row">
        <span>
          <strong>Fetch All Lyrics</strong>
          <em>
            Search every enabled provider for the whole library in the background. Playback is
            prioritised, results are cached per provider, and the job survives restarts.
            {stats
              ? ` ${stats.totalTracks} tracks · ${stats.withLyrics} with lyrics · ${stats.needsSearch} still to search · ${stats.fullyProcessed} fully processed.`
              : ""}
          </em>
        </span>
        <button
          type="button"
          className="primary"
          data-testid="fetch-all-start"
          disabled={running}
          onClick={() => void start()}
        >
          <Sparkles size={15} /> {paused ? "Resume fetch" : "✨ FETCH ALL LYRICS ✨"}
        </button>
      </div>

      {snapshot.jobId ? (
        <div className="fetch-settings-job" data-testid="fetch-all-job-summary">
          <p className="muted">
            {snapshot.state === "completed"
              ? "Last fetch finished"
              : snapshot.state === "canceled"
                ? "Last fetch was canceled (fetched lyrics were kept)"
                : paused
                  ? "Fetch paused"
                  : "Fetching in the background"}
            {snapshot.finishedAt ? ` · ${new Date(snapshot.finishedAt).toLocaleString()}` : ""} ·{" "}
            {snapshot.processed}/{snapshot.total} tracks ({percent}%) · Found {snapshot.found} · Not
            Found {snapshot.notFound} · Failed {snapshot.failed} · Skipped {snapshot.skipped}
            {snapshot.currentTrack ? ` · Now: ${snapshot.currentTrack.title}` : ""}
          </p>
          <div className="heading-actions">
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
              <button type="button" data-testid="fetch-all-retry-failed" onClick={() => void retryFailed()}>
                <RotateCcw size={14} /> Retry Failed ({snapshot.failed})
              </button>
            ) : null}
            {running || paused ? (
              <button type="button" className="danger" onClick={() => void cancel()}>
                <X size={14} /> Cancel
              </button>
            ) : null}
            <button type="button" onClick={() => void refreshStats()}>
              Refresh stats
            </button>
          </div>
          <p className="muted">
            Not Found tracks become eligible again after the cooldown below; starting another fetch
            then (or using Retry in Now Playing) searches them again. Temporary failures never
            retry on their own.
          </p>
        </div>
      ) : null}
    </div>
  );
}
