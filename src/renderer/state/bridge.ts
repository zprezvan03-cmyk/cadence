/**
 * The renderer's only door to the main process. In the packaged app `window.cadence` is installed
 * by the preload script; the automated Chromium test harness installs an HTTP-backed
 * implementation of the same contract before the app boots, so no renderer code knows the
 * difference.
 */

import type { CadenceApi } from "../../shared/types";

function missing(): never {
  throw new Error(
    "The Cadence bridge is unavailable. The renderer must be hosted by the desktop shell (or the test harness)."
  );
}

export const bridge: CadenceApi = new Proxy({} as CadenceApi, {
  get(_target, property) {
    const api = globalThis.window?.cadence;
    if (!api) return missing;
    return (api as unknown as Record<string, unknown>)[property as string];
  },
});

export function hasBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.cadence);
}
