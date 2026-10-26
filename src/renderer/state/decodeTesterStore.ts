/**
 * Decode Tester state: scan progress/results, the "Keep" acknowledgements, selection for bulk
 * removal, and the delete/export actions. Written for Cadence.
 *
 * "Keep" marks a problematic file as intentionally retained. It never hides the file from scan
 * results on its own — the view only hides kept rows when the user explicitly enables the
 * "hide kept" filter — and the marks persist across restarts (localStorage) and re-scans.
 */

import { create } from "zustand";
import type { DecodeProblem, Track } from "../../shared/types";
import {
  dedupePaths,
  probeTrackDecode,
  runDecodeScan,
  type DecodeProbeTrack,
} from "../audio/decodeProbe";
import { bridge } from "./bridge";

const KEPT_STORAGE_KEY = "cadence.decodeTester.kept.v1";

export type DecodeScanStatus = "idle" | "scanning" | "done" | "canceled" | "error";

function loadKeptPaths(): string[] {
  try {
    const raw = localStorage.getItem(KEPT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? dedupePaths(parsed.filter((value): value is string => typeof value === "string")) : [];
  } catch {
    return [];
  }
}

function persistKeptPaths(paths: string[]): void {
  try {
    localStorage.setItem(KEPT_STORAGE_KEY, JSON.stringify(paths));
  } catch {
    /* private-mode or quota failures only lose persistence, never the in-memory marks */
  }
}

/** Problems visible under the kept-files filter. Kept files stay visible unless explicitly hidden. */
export function visibleDecodeProblems(
  problems: DecodeProblem[],
  keptPaths: readonly string[],
  hideKept: boolean
): DecodeProblem[] {
  if (!hideKept) return problems;
  const kept = new Set(keptPaths);
  return problems.filter(problem => !kept.has(problem.path));
}

interface DecodeTesterState {
  status: DecodeScanStatus;
  scanned: number;
  total: number;
  problems: DecodeProblem[];
  keptPaths: string[];
  selectedPaths: string[];
  hideKept: boolean;
  error: string | null;
  /** Outcome of the last delete/export action, shown as an inline banner. */
  actionMessage: string | null;
  /** Files whose confirmed deletion failed, keyed by path with the OS error. */
  deleteErrors: Record<string, string>;
  deleting: boolean;
  exporting: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  startScan: (tracks: Track[]) => Promise<void>;
  cancelScan: () => void;
  toggleKept: (path: string) => void;
  isKept: (path: string) => boolean;
  toggleSelected: (path: string, selected?: boolean) => void;
  selectPaths: (paths: string[]) => void;
  clearSelection: () => void;
  setHideKept: (value: boolean) => void;
  removeFiles: (paths: string[]) => Promise<void>;
  exportFileList: () => Promise<void>;
  dismissActionMessage: () => void;
}

let activeController: AbortController | null = null;

export const useDecodeTester = create<DecodeTesterState>()((set, get) => ({
  status: "idle",
  scanned: 0,
  total: 0,
  problems: [],
  keptPaths: loadKeptPaths(),
  selectedPaths: [],
  hideKept: false,
  error: null,
  actionMessage: null,
  deleteErrors: {},
  deleting: false,
  exporting: false,
  startedAt: null,
  finishedAt: null,

  startScan: async tracks => {
    if (get().status === "scanning") return;
    const controller = new AbortController();
    activeController = controller;
    const probeTracks: DecodeProbeTrack[] = tracks.map(track => ({
      id: track.id,
      path: track.path,
      streamUrl: track.streamUrl,
      codec: track.codec,
      duration: track.duration,
    }));
    set({
      status: "scanning",
      scanned: 0,
      total: dedupePaths(probeTracks.map(track => track.path)).length,
      problems: [],
      selectedPaths: [],
      error: null,
      actionMessage: null,
      deleteErrors: {},
      startedAt: Date.now(),
      finishedAt: null,
    });
    try {
      const outcome = await runDecodeScan(
        probeTracks,
        (track, signal) => probeTrackDecode(track, { signal }),
        {
          concurrency: 3,
          signal: controller.signal,
          onProgress: progress => {
            // A superseded scan must not overwrite the current one's progress.
            if (activeController !== controller) return;
            set({ scanned: progress.scanned, total: progress.total, problems: progress.problems });
          },
        }
      );
      if (activeController !== controller) return;
      set({
        status: outcome.canceled ? "canceled" : "done",
        scanned: outcome.scanned,
        total: outcome.total,
        problems: outcome.problems,
        finishedAt: Date.now(),
      });
    } catch (error) {
      if (activeController !== controller) return;
      set({
        status: "error",
        error: (error as Error)?.message ?? "The decode scan failed unexpectedly.",
        finishedAt: Date.now(),
      });
    } finally {
      if (activeController === controller) activeController = null;
    }
  },

  cancelScan: () => {
    activeController?.abort();
  },

  toggleKept: path => {
    const kept = new Set(get().keptPaths);
    if (kept.has(path)) kept.delete(path);
    else kept.add(path);
    const keptPaths = [...kept];
    persistKeptPaths(keptPaths);
    set({ keptPaths });
  },

  isKept: path => get().keptPaths.includes(path),

  toggleSelected: (path, selected) => {
    const current = new Set(get().selectedPaths);
    const next = selected ?? !current.has(path);
    if (next) current.add(path);
    else current.delete(path);
    set({ selectedPaths: [...current] });
  },

  selectPaths: paths => set({ selectedPaths: dedupePaths(paths) }),

  clearSelection: () => set({ selectedPaths: [] }),

  setHideKept: value => set({ hideKept: value }),

  removeFiles: async paths => {
    const unique = dedupePaths(paths);
    if (unique.length === 0 || get().deleting) return;
    set({ deleting: true, actionMessage: null });
    try {
      const outcomes = await bridge.decodeTester.deleteFiles(unique);
      const deleted = new Set(outcomes.filter(outcome => outcome.deleted).map(outcome => outcome.path));
      const deleteErrors = { ...get().deleteErrors };
      for (const outcome of outcomes) {
        if (outcome.deleted) delete deleteErrors[outcome.path];
        else deleteErrors[outcome.path] = outcome.error ?? "Deletion failed";
      }
      // A file that no longer exists needs neither a Keep mark nor a selection entry.
      const keptPaths = get().keptPaths.filter(path => !deleted.has(path));
      if (keptPaths.length !== get().keptPaths.length) persistKeptPaths(keptPaths);
      const failedCount = outcomes.length - deleted.size;
      set({
        deleting: false,
        problems: get().problems.filter(problem => !deleted.has(problem.path)),
        selectedPaths: get().selectedPaths.filter(path => !deleted.has(path)),
        keptPaths,
        deleteErrors,
        actionMessage:
          failedCount === 0
            ? `Deleted ${deleted.size} file${deleted.size === 1 ? "" : "s"} from disk and removed ${deleted.size === 1 ? "it" : "them"} from the library.`
            : `Deleted ${deleted.size} of ${outcomes.length} files. ${failedCount} could not be deleted — see the note on each remaining row.`,
      });
    } catch (error) {
      set({
        deleting: false,
        actionMessage: `Deletion failed: ${(error as Error)?.message ?? String(error)}`,
      });
    }
  },

  exportFileList: async () => {
    if (get().exporting) return;
    const paths = dedupePaths(get().problems.map(problem => problem.path));
    if (paths.length === 0) return;
    set({ exporting: true, actionMessage: null });
    try {
      const result = await bridge.decodeTester.exportFileList(paths);
      set({
        exporting: false,
        actionMessage: result.canceled
          ? null
          : `Exported ${paths.length} problematic file path${paths.length === 1 ? "" : "s"} to ${result.path ?? "a text file"}.`,
      });
    } catch (error) {
      set({
        exporting: false,
        actionMessage: `Export failed: ${(error as Error)?.message ?? String(error)}`,
      });
    }
  },

  dismissActionMessage: () => set({ actionMessage: null }),
}));
