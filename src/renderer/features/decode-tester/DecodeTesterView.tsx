/**
 * Decode Tester page: scans the library by really decoding every file, lists the ones the
 * playback decoder cannot handle, and offers Keep / Remove / Export actions for them.
 * Written for Cadence.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  FolderPlus,
  Loader2,
  Play,
  Square,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";
import type { DecodeProblem, Track } from "../../../shared/types";
import { DECODE_PROBLEM_KIND_LABELS } from "../../audio/decodeProbe";
import { bridge } from "../../state/bridge";
import { useDecodeTester, visibleDecodeProblems } from "../../state/decodeTesterStore";
import { useLibrary } from "../../state/libraryStore";

const EMPTY_TRACKS: readonly Track[] = [];

function ProblemRow({
  problem,
  kept,
  selected,
  deleteError,
  onToggleKept,
  onToggleSelected,
  onShowInFolder,
  onRemove,
}: {
  problem: DecodeProblem;
  kept: boolean;
  selected: boolean;
  deleteError?: string;
  onToggleKept: () => void;
  onToggleSelected: (value: boolean) => void;
  onShowInFolder: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={`decode-row ${kept ? "is-kept" : ""}`}
      data-testid="decode-problem-row"
      data-path={problem.path}
      data-kind={problem.kind}
    >
      <input
        type="checkbox"
        className="decode-row-check"
        checked={selected}
        onChange={event => onToggleSelected(event.target.checked)}
        aria-label={`Select ${problem.fileName}`}
      />
      <div className="decode-row-main">
        <div className="decode-row-title">
          <strong title={problem.fileName}>{problem.fileName}</strong>
          <span className={`badge decode-kind decode-kind-${problem.kind}`}>
            {DECODE_PROBLEM_KIND_LABELS[problem.kind]}
          </span>
          {kept ? <span className="badge decode-kept-badge">Kept</span> : null}
          {problem.codec ? <span className="decode-row-codec">{problem.codec}</span> : null}
        </div>
        <span className="decode-row-path" title={problem.path}>
          {problem.path}
        </span>
        <span className="decode-row-message">{problem.message}</span>
        {deleteError ? (
          <span className="decode-row-delete-error">Could not delete this file: {deleteError}</span>
        ) : null}
      </div>
      <div className="decode-row-actions">
        <button
          type="button"
          className={kept ? "decode-keep active" : "decode-keep"}
          onClick={onToggleKept}
          aria-pressed={kept}
          title={kept ? "Stop marking this file as intentionally kept" : "Mark this file as intentionally kept"}
        >
          {kept ? "Kept" : "Keep"}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onShowInFolder}
          aria-label={`Show ${problem.fileName} in folder`}
          title="Show in folder"
        >
          <FolderOpen size={16} />
        </button>
        <button
          type="button"
          className="icon-button danger"
          onClick={onRemove}
          aria-label={`Remove ${problem.fileName}`}
          title="Delete this file…"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}

function ConfirmDeleteDialog({
  paths,
  problems,
  deleting,
  onCancel,
  onConfirm,
}: {
  paths: string[];
  problems: DecodeProblem[];
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const byPath = useMemo(() => new Map(problems.map(problem => [problem.path, problem])), [problems]);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal decode-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="decode-confirm-title"
        data-testid="decode-confirm-dialog"
        onClick={event => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="decode-confirm-title">
            Delete {paths.length} file{paths.length === 1 ? "" : "s"}?
          </h2>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel deletion">
            <X size={16} />
          </button>
        </header>
        <p className="decode-confirm-warning">
          <AlertTriangle size={16} /> These files will be permanently deleted from disk and removed from
          your Cadence library. This cannot be undone.
        </p>
        <ul className="decode-confirm-list" data-testid="decode-confirm-list">
          {paths.map(path => (
            <li key={path}>
              <strong>{byPath.get(path)?.fileName ?? path}</strong>
              <span title={path}>{path}</span>
            </li>
          ))}
        </ul>
        <footer className="decode-confirm-footer">
          <button type="button" onClick={onCancel} data-testid="decode-confirm-cancel" disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            ref={confirmRef}
            onClick={onConfirm}
            data-testid="decode-confirm-delete"
            disabled={deleting}
          >
            <Trash2 size={15} /> {deleting ? "Deleting…" : `Delete ${paths.length} file${paths.length === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function DecodeTesterView() {
  const tracks = useLibrary(state => state.snapshot?.tracks ?? EMPTY_TRACKS);
  const snapshotReady = useLibrary(state => state.snapshot !== null);
  const addFolder = useLibrary(state => state.addFolder);
  const libraryScanning = useLibrary(state => state.scanning);

  const status = useDecodeTester(state => state.status);
  const scanned = useDecodeTester(state => state.scanned);
  const total = useDecodeTester(state => state.total);
  const problems = useDecodeTester(state => state.problems);
  const keptPaths = useDecodeTester(state => state.keptPaths);
  const selectedPaths = useDecodeTester(state => state.selectedPaths);
  const hideKept = useDecodeTester(state => state.hideKept);
  const error = useDecodeTester(state => state.error);
  const actionMessage = useDecodeTester(state => state.actionMessage);
  const deleteErrors = useDecodeTester(state => state.deleteErrors);
  const deleting = useDecodeTester(state => state.deleting);
  const exporting = useDecodeTester(state => state.exporting);
  const startScan = useDecodeTester(state => state.startScan);
  const cancelScan = useDecodeTester(state => state.cancelScan);
  const toggleKept = useDecodeTester(state => state.toggleKept);
  const toggleSelected = useDecodeTester(state => state.toggleSelected);
  const selectPaths = useDecodeTester(state => state.selectPaths);
  const clearSelection = useDecodeTester(state => state.clearSelection);
  const setHideKept = useDecodeTester(state => state.setHideKept);
  const removeFiles = useDecodeTester(state => state.removeFiles);
  const exportFileList = useDecodeTester(state => state.exportFileList);
  const dismissActionMessage = useDecodeTester(state => state.dismissActionMessage);

  const [confirmPaths, setConfirmPaths] = useState<string[] | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const keptSet = useMemo(() => new Set(keptPaths), [keptPaths]);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const visible = useMemo(
    () => visibleDecodeProblems(problems, keptPaths, hideKept),
    [problems, keptPaths, hideKept]
  );
  const keptCount = useMemo(
    () => problems.filter(problem => keptSet.has(problem.path)).length,
    [problems, keptSet]
  );
  const selectedVisible = useMemo(
    () => visible.filter(problem => selectedSet.has(problem.path)),
    [visible, selectedSet]
  );
  const scanning = status === "scanning";
  const progressPercent = total > 0 ? Math.round((scanned / total) * 100) : 0;

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate =
      selectedVisible.length > 0 && selectedVisible.length < visible.length;
  }, [selectedVisible.length, visible.length]);

  const showInFolder = (problem: DecodeProblem) => {
    setRevealError(null);
    void bridge.app.openPath(problem.path).catch((revealFailure: Error) => {
      setRevealError(`Could not show ${problem.fileName} in its folder: ${revealFailure.message}`);
    });
  };

  const confirmDelete = () => {
    if (!confirmPaths) return;
    const paths = confirmPaths;
    setConfirmPaths(null);
    void removeFiles(paths);
  };

  const statusLine = ((): string => {
    switch (status) {
      case "scanning":
        return `Scanning… ${scanned} of ${total} files checked`;
      case "done":
        return `Scan complete — ${total} files checked, ${problems.length} problematic`;
      case "canceled":
        return `Scan canceled — ${scanned} of ${total} files checked, ${problems.length} problematic so far`;
      case "error":
        return "Scan failed";
      default:
        return tracks.length > 0 ? `${tracks.length} files in your library` : "No files in your library yet";
    }
  })();

  return (
    <div className="view decode-view" data-testid="decode-tester-view">
      <header className="view-heading">
        <div>
          <p className="eyebrow">Library tools</p>
          <h1>Decode Tester</h1>
          <p className="muted decode-intro">
            Every file in your library is really decoded — beginning, middle and end — with the same
            decoder Cadence plays with, so corrupt, truncated and unsupported files are found by trying
            to play their audio, not by reading their tags. Scanning never modifies your files.
          </p>
        </div>
        <div className="heading-actions">
          {scanning ? (
            <button type="button" onClick={cancelScan} data-testid="decode-cancel-button">
              <Square size={15} /> Cancel scan
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void startScan([...tracks])}
              disabled={!snapshotReady || tracks.length === 0}
              data-testid="decode-scan-button"
            >
              <Play size={16} fill="currentColor" /> {status === "idle" ? "Scan library" : "Scan again"}
            </button>
          )}
        </div>
      </header>

      <div className="decode-status" data-testid="decode-status" role="status">
        <Stethoscope size={17} />
        <span>{statusLine}</span>
        {problems.length > 0 ? (
          <span className="decode-status-count" data-testid="decode-summary">
            {problems.length} problematic file{problems.length === 1 ? "" : "s"}
            {keptCount > 0 ? ` · ${keptCount} kept` : ""}
          </span>
        ) : null}
      </div>

      {scanning ? (
        <div className="decode-progress" data-testid="decode-progress">
          <div
            className="decode-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={scanned}
            aria-label="Decode scan progress"
          >
            <div className="decode-progress-bar" style={{ width: `${progressPercent}%` }} />
          </div>
          <span>
            Scanned {scanned} of {total} files ({progressPercent}%)
          </span>
          <Loader2 size={15} className="decode-spinner" />
        </div>
      ) : null}

      {actionMessage ? (
        <div className="decode-banner" role="status" data-testid="decode-action-message">
          <span>{actionMessage}</span>
          <button type="button" className="icon-button" onClick={dismissActionMessage} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {revealError ? (
        <div className="decode-banner is-error" role="alert">
          <span>{revealError}</span>
          <button type="button" className="icon-button" onClick={() => setRevealError(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ states */}
      {!snapshotReady ? (
        <div className="view-loading">Loading your library…</div>
      ) : tracks.length === 0 ? (
        <div className="empty-state" data-testid="decode-empty-no-files">
          <Stethoscope size={34} />
          <p>
            <strong>No supported audio files found.</strong>
            <br />
            Add a music folder first, then run the Decode Tester over it.
          </p>
          <button type="button" className="primary" onClick={() => void addFolder()} disabled={libraryScanning}>
            <FolderPlus size={16} /> {libraryScanning ? "Scanning…" : "Add music folder"}
          </button>
        </div>
      ) : status === "idle" ? (
        <div className="empty-state" data-testid="decode-empty-idle">
          <Stethoscope size={34} />
          <p>
            Not scanned yet. A scan decodes the start, middle and end of all {tracks.length} files and
            lists only the ones the player would fail on. Music keeps playing while it runs.
          </p>
        </div>
      ) : status === "error" ? (
        <div className="empty-state" data-testid="decode-scan-failed">
          <AlertTriangle size={34} />
          <p>
            <strong>Scan failed.</strong>
            <br />
            {error ?? "Something went wrong while scanning."}
          </p>
          <button type="button" className="primary" onClick={() => void startScan([...tracks])}>
            Try again
          </button>
        </div>
      ) : status === "done" && problems.length === 0 ? (
        <div className="empty-state" data-testid="decode-empty-no-errors">
          <CheckCircle2 size={34} />
          <p>
            <strong>No errors found.</strong>
            <br />
            All {total} files in your library decode correctly.
          </p>
        </div>
      ) : scanning && problems.length === 0 ? (
        <div className="empty-state" data-testid="decode-empty-scanning">
          <Loader2 size={34} className="decode-spinner" />
          <p>Scan in progress — problematic files will appear here as they are found.</p>
        </div>
      ) : problems.length > 0 && visible.length === 0 ? (
        <div className="empty-state" data-testid="decode-empty-all-kept">
          <CheckCircle2 size={34} />
          <p>
            All {problems.length} problematic file{problems.length === 1 ? " is" : "s are"} marked as kept
            and currently hidden. Turn off “Hide kept files” to see {problems.length === 1 ? "it" : "them"}.
          </p>
        </div>
      ) : null}

      {/* ------------------------------------------------------------- list */}
      {problems.length > 0 ? (
        <>
          <div className="decode-toolbar">
            <label className="decode-select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={visible.length > 0 && selectedVisible.length === visible.length}
                onChange={event => {
                  if (event.target.checked) selectPaths(visible.map(problem => problem.path));
                  else clearSelection();
                }}
                data-testid="decode-select-all"
              />
              Select all shown
            </label>
            <label className="decode-hide-kept">
              <input
                type="checkbox"
                checked={hideKept}
                onChange={event => setHideKept(event.target.checked)}
                data-testid="decode-hide-kept"
              />
              Hide kept files
            </label>
            <span className="decode-toolbar-spacer" />
            <button
              type="button"
              onClick={() => void exportFileList()}
              disabled={exporting || scanning}
              data-testid="decode-export-button"
              title="Save every problematic file path to a plain-text file"
            >
              <Download size={15} /> {exporting ? "Exporting…" : "Export file list (.txt)"}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => setConfirmPaths(selectedPaths.filter(path => problems.some(p => p.path === path)))}
              disabled={selectedPaths.length === 0 || deleting || scanning}
              data-testid="decode-remove-selected"
            >
              <Trash2 size={15} /> Remove selected ({selectedPaths.length})
            </button>
          </div>

          {visible.length > 0 ? (
            <ul className="decode-list">
              {visible.map(problem => (
                <ProblemRow
                  key={problem.path}
                  problem={problem}
                  kept={keptSet.has(problem.path)}
                  selected={selectedSet.has(problem.path)}
                  deleteError={deleteErrors[problem.path]}
                  onToggleKept={() => toggleKept(problem.path)}
                  onToggleSelected={value => toggleSelected(problem.path, value)}
                  onShowInFolder={() => showInFolder(problem)}
                  onRemove={() => setConfirmPaths([problem.path])}
                />
              ))}
            </ul>
          ) : null}
          <p className="muted decode-footnote">
            <strong>Keep</strong> only marks a file as intentionally retained — it stays in future scan
            results unless you hide kept files above. <strong>Remove</strong> asks for confirmation, then
            permanently deletes the selected files from disk. Exporting writes every problematic path
            (including kept ones) to a UTF-8 text file, one per line.
          </p>
        </>
      ) : null}

      {status === "canceled" && problems.length === 0 ? (
        <div className="empty-state" data-testid="decode-empty-canceled">
          <p>Scan canceled before any problem was found. Run it again whenever you are ready.</p>
        </div>
      ) : null}

      {confirmPaths && confirmPaths.length > 0 ? (
        <ConfirmDeleteDialog
          paths={confirmPaths}
          problems={problems}
          deleting={deleting}
          onCancel={() => setConfirmPaths(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}
