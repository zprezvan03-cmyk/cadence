/**
 * Settings → Cache: the lyrics cache manager.
 *
 * Lists every entry the persistent cache holds (one per track plus one per manual search), with the
 * title/artist/album, the sources and formats stored, and when it was written. Selecting an entry
 * opens the inspector, which replays the *stored* payload through the same parser the lyrics view
 * uses, so translations, romanization and word timing can be checked exactly as they were cached.
 *
 * Deleting an entry only edits `lyrics-cache.json`; the sidecar/audio files and the library are
 * never touched.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Database, RefreshCw, Search, Trash2, X } from "lucide-react";
import type { Lyric } from "@braccato/types";
import type {
  LyricsCacheEntryDetail,
  LyricsCacheEntrySummary,
  LyricsCacheListResult,
} from "../../../shared/types";
import { bridge } from "../../state/bridge";
import { useUi } from "../../state/uiStore";
import { parseLyricsText, type ParsedLyrics } from "../lyrics/parseLyrics";

/** Exact, human-sized rendering of a measured byte count. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return text && text !== "{}" ? text : "unknown error";
}

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = (total - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

function entryTitle(entry: Pick<LyricsCacheEntrySummary, "title" | "kind">): string {
  if (entry.title.trim()) return entry.title;
  return entry.kind === "search" ? "Untitled search" : "Untitled track";
}

const FORMAT_LABEL: Record<string, string> = {
  ttml: "TTML",
  qrc: "QRC",
  lrc: "LRC",
  srt: "SRT",
  plain: "Plain text",
};

function formatLabel(format: string): string {
  return FORMAT_LABEL[format] ?? format.toUpperCase();
}

export function LyricsCachePanel() {
  const showToast = useUi(state => state.showToast);
  const [list, setList] = useState<LyricsCacheListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [inspecting, setInspecting] = useState<LyricsCacheEntryDetail | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await bridge.lyrics.listCache();
      setList(result);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entries = list?.entries ?? [];
  const filtered = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter(entry =>
      [entry.title, entry.artist, entry.album, ...entry.sources, ...entry.formats]
        .join("\u0000")
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [entries, filter]);

  const inspect = async (key: string) => {
    setInspectLoading(true);
    setInspectError(null);
    try {
      const detail = await bridge.lyrics.getCacheEntry(key);
      if (!detail) {
        setInspectError("This entry is no longer in the cache. Refresh the list.");
        setInspecting(null);
        return;
      }
      setInspecting(detail);
    } catch (cause) {
      setInspectError(describeError(cause));
    } finally {
      setInspectLoading(false);
    }
  };

  const remove = async (entry: LyricsCacheEntrySummary) => {
    setBusyKey(entry.key);
    try {
      const result = await bridge.lyrics.removeCacheEntry(entry.key);
      showToast(
        result.removed
          ? `Removed “${entryTitle(entry)}” from the lyrics cache`
          : `“${entryTitle(entry)}” was already gone`
      );
      if (inspecting?.key === entry.key) setInspecting(null);
      await refresh();
    } catch (cause) {
      showToast(`Could not delete the cache entry: ${describeError(cause)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const clearAll = async () => {
    if (!confirm("Clear the whole lyrics cache? Songs will be looked up again. Your audio files, lyrics files and library are not touched.")) {
      return;
    }
    setClearing(true);
    try {
      const { removedEntries } = await bridge.lyrics.clearCache();
      showToast(
        removedEntries > 0
          ? `Lyrics cache cleared (${removedEntries} cached ${removedEntries === 1 ? "song" : "songs"} removed)`
          : "Lyrics cache was already empty"
      );
      setInspecting(null);
      await refresh();
    } catch (cause) {
      showToast(`Could not clear the lyrics cache: ${describeError(cause)}`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="settings-section cache-section" data-testid="settings-cache">
      <h2>Lyrics cache</h2>
      <p className="muted">
        Every set of lyrics Cadence has loaded stays here — local TTML/QRC/LRC files, embedded tags,
        files you picked by hand, chosen search results and provider lyrics — so it can be shown again
        offline and after a restart. Deleting an entry never touches the lyrics file, the audio file or
        the library.
      </p>

      <div className="cache-toolbar">
        <label className="cache-search">
          <Search size={15} />
          <input
            type="search"
            value={filter}
            placeholder="Filter by title, artist, album or source"
            data-testid="cache-filter"
            onChange={event => setFilter(event.target.value)}
          />
        </label>
        <span className="cache-stats" data-testid="cache-stats">
          {list ? (
            <>
              <Database size={14} /> {list.stats.entryCount} {list.stats.entryCount === 1 ? "entry" : "entries"} ·{" "}
              {formatBytes(list.stats.bytes)}
              <em title={`${list.stats.bytes.toLocaleString()} bytes on disk`}>
                ({list.stats.bytes.toLocaleString()} bytes)
              </em>
            </>
          ) : (
            "…"
          )}
        </span>
        <button type="button" onClick={() => void refresh()} disabled={loading} data-testid="cache-refresh">
          <RefreshCw size={15} className={loading ? "spin" : undefined} /> {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void clearAll()}
          disabled={clearing || (list?.stats.entryCount ?? 0) === 0}
          data-testid="cache-clear"
        >
          <Trash2 size={15} /> {clearing ? "Clearing…" : "Clear cache"}
        </button>
      </div>

      {inspectError ? (
        <p className="cache-error" role="alert" data-testid="cache-error">
          {inspectError}
        </p>
      ) : null}

      {error ? (
        <div className="cache-empty" role="alert" data-testid="cache-error">
          <strong>Could not read the lyrics cache</strong>
          <em>{error}</em>
          <button type="button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : loading && !list ? (
        <p className="cache-loading" data-testid="cache-loading">
          Reading the lyrics cache…
        </p>
      ) : entries.length === 0 ? (
        <div className="cache-empty" data-testid="cache-empty">
          <strong>The lyrics cache is empty</strong>
          <em>Play a song with lyrics, or run a lyrics search, and it will show up here.</em>
        </div>
      ) : filtered.length === 0 ? (
        <div className="cache-empty" data-testid="cache-empty-filtered">
          <strong>Nothing matches “{filter.trim()}”</strong>
          <em>{entries.length} cached entries are hidden by the filter.</em>
          <button type="button" onClick={() => setFilter("")}>
            Clear filter
          </button>
        </div>
      ) : (
        <ul className="cache-list" data-testid="cache-list">
          {filtered.map(entry => (
            <li className="cache-row" key={entry.key} data-testid="cache-row" data-key={entry.key}>
              <button
                type="button"
                className="cache-row-main"
                onClick={() => void inspect(entry.key)}
                aria-label={`Inspect ${entryTitle(entry)}`}
              >
                <span className="cache-row-title">
                  {entryTitle(entry)}
                  {entry.artist ? <em> — {entry.artist}</em> : null}
                </span>
                <span className="cache-row-meta">
                  {entry.album ? <span>{entry.album}</span> : null}
                  <span>{entry.sources.join(", ") || (entry.negative ? "No lyrics found" : "—")}</span>
                  <span>{entry.formats.map(formatLabel).join(", ") || "—"}</span>
                  <span>{timestamp(entry.savedAt)}</span>
                  {entry.negative ? <span className="cache-badge muted-badge">nothing found</span> : null}
                  {entry.kind === "search" ? <span className="cache-badge">search</span> : null}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${entryTitle(entry)}`}
                title="Delete this entry only"
                disabled={busyKey === entry.key}
                onClick={() => void remove(entry)}
                data-testid="cache-delete"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {inspectLoading ? (
        <p className="cache-loading" data-testid="cache-loading">
          Loading cached lyrics…
        </p>
      ) : null}

      {inspecting ? (
        <CacheInspector detail={inspecting} onClose={() => setInspecting(null)} />
      ) : null}
    </section>
  );
}

function CacheInspector({ detail, onClose }: { detail: LyricsCacheEntryDetail; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cache-inspector"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cache-inspector-title"
        data-testid="cache-inspector"
        onClick={event => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="cache-inspector-title">{entryTitle(detail)}</h2>
            <p className="cache-inspector-sub">
              {[detail.artist, detail.album].filter(Boolean).join(" · ") || "No artist or album tags"} · cached{" "}
              {timestamp(detail.savedAt)}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close cache inspector" data-testid="cache-inspector-close">
            <X size={16} />
          </button>
        </header>
        <div className="cache-inspector-body">
          {detail.candidates.length === 0 ? (
            <p className="muted">This entry records a definitive “no lyrics found” answer from the providers.</p>
          ) : (
            detail.candidates.map(candidate => (
              <CachedCandidateView key={`${candidate.source}:${candidate.cachedAt}`} candidate={candidate} detail={detail} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function CachedCandidateView({
  candidate,
  detail,
}: {
  candidate: LyricsCacheEntryDetail["candidates"][number];
  detail: LyricsCacheEntryDetail;
}) {
  const parsed = useMemo<ParsedLyrics | null>(() => {
    try {
      return parseLyricsText(candidate.text, detail.duration * 1000, {
        title: detail.title,
        artist: detail.artist,
      });
    } catch {
      return null;
    }
  }, [candidate.text, detail.duration, detail.title, detail.artist]);

  const [open, setOpen] = useState(true);
  const sung = parsed?.lyrics.filter(line => !line.isInstrumental) ?? [];
  const translations = sung.filter(line => line.translations && Object.keys(line.translations).length > 0);
  const romanizations = sung.filter(line => Boolean(line.romanization));
  const wordTimed = sung.filter(line => (line.parts?.length ?? 0) > 1);

  return (
    <section className="cache-candidate">
      <header className="cache-candidate-head">
        <button type="button" className="cache-candidate-toggle" onClick={() => setOpen(value => !value)}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          <strong>{candidate.provider}</strong>
          <span className="cache-badge">{formatLabel(candidate.format)}</span>
          <span className="cache-badge">{candidate.origin === "network" ? "provider" : candidate.origin === "manual" ? "your choice" : "local"}</span>
          <span className="muted">{candidate.syncHint}</span>
          {candidate.language ? <span className="muted">{candidate.language}</span> : null}
        </button>
        <span className="cache-candidate-counts">
          {sung.length} lines · {translations.length} translated · {romanizations.length} romanized
          {wordTimed.length > 0 ? ` · ${wordTimed.length} word-timed` : ""}
        </span>
      </header>
      {candidate.sourceHref ? (
        <p className="cache-candidate-path" title={candidate.sourceHref}>
          {candidate.sourceHref}
        </p>
      ) : null}
      {open ? (
        parsed ? (
          <ol className="cache-lyrics" data-testid="cache-inspector-lyrics">
            {parsed.lyrics.map((line, index) => (
              <CachedLine key={index} line={line} />
            ))}
          </ol>
        ) : (
          // Never hide a payload the parser rejected: show the raw text and let the user see it.
          <pre className="cache-raw" data-testid="cache-inspector-raw">
            {candidate.text}
          </pre>
        )
      ) : null}
    </section>
  );
}

function CachedLine({ line }: { line: Lyric }) {
  const translations = line.translations && Object.keys(line.translations).length > 0 ? line.translations : null;
  if (line.isInstrumental) {
    return (
      <li className="cache-lyric-line is-instrumental">
        <span className="cache-lyric-time">{clock(line.startTimeMs)}</span>
        <span className="cache-lyric-text">♪ instrumental</span>
      </li>
    );
  }
  return (
    <li className="cache-lyric-line">
      <span className="cache-lyric-time">{clock(line.startTimeMs)}</span>
      <span className="cache-lyric-text">
        {line.words}
        {line.romanization ? <em className="cache-lyric-romanization">{line.romanization}</em> : null}
        {translations
          ? Object.entries(translations).map(([language, text]) => (
              <em key={language} className="cache-lyric-translation">
                {text}
                <span className="cache-translation-language">{language}</span>
              </em>
            ))
          : null}
      </span>
    </li>
  );
}
