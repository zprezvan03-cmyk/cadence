/**
 * Renderer-side automation state: seamless same-track refresh in the lyrics store, the
 * onboarding auto-show/step rules, and the Fetch All store's explicit-start contract
 * (Fetch All must only ever start from a user action, never from rendering or subscribing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("seamless lyrics refresh (lyricsStore)", () => {
  it("keeps fallback lyrics visible during a same-track upgrade pass", async () => {
    vi.resetModules();
    const { useLyricsStore } = await import("../../src/renderer/state/lyricsStore");
    const lines = [{ words: "first line" }] as never[];
    useLyricsStore.getState().setActive(3, {
      status: "ready",
      lyrics: lines as never,
      activeSource: "lrclib-synced",
      candidates: [{ source: "lrclib-synced" } as never],
    });

    useLyricsStore.getState().beginResolve(3);
    const refreshing = useLyricsStore.getState();
    expect(refreshing.status).toBe("loading");
    expect(refreshing.refreshing).toBe(true);
    // The fallback never leaves the screen while providers search for something better.
    expect(refreshing.lyrics).toBe(lines);
    expect(refreshing.activeSource).toBe("lrclib-synced");

    // A different track, by contrast, must not inherit the previous song's lines.
    useLyricsStore.getState().beginResolve(4);
    const next = useLyricsStore.getState();
    expect(next.lyrics).toBeNull();
    expect(next.refreshing).toBe(false);
    expect(next.candidates).toEqual([]);
  });
});

describe("onboarding rules", () => {
  it("auto-shows only on a true first launch, and always on explicit replay", async () => {
    const { shouldAutoShowOnboarding, clampOnboardingStep } = await import(
      "../../src/renderer/state/onboardingStore"
    );
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: true, onboardingCompleted: false, folderCount: 0, trackCount: 0, replayRequested: false })
    ).toBe(true);
    // Existing installs (folders already configured) never get a surprise first-run flow.
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: true, onboardingCompleted: false, folderCount: 2, trackCount: 0, replayRequested: false })
    ).toBe(false);
    // Tracks without a registered folder (scanned elsewhere, folder later removed) is still
    // not a first launch.
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: true, onboardingCompleted: false, folderCount: 0, trackCount: 12, replayRequested: false })
    ).toBe(false);
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: true, onboardingCompleted: true, folderCount: 0, trackCount: 0, replayRequested: false })
    ).toBe(false);
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: false, onboardingCompleted: false, folderCount: 0, trackCount: 0, replayRequested: false })
    ).toBe(false);
    expect(
      shouldAutoShowOnboarding({ settingsLoaded: true, onboardingCompleted: true, folderCount: 5, trackCount: 9, replayRequested: true })
    ).toBe(true);
    expect(clampOnboardingStep(-2)).toBe(0);
    expect(clampOnboardingStep(99)).toBe(4);
    expect(clampOnboardingStep(2.4)).toBe(2);
  });

  it("replay opens at Welcome, steps advance with clamping, finish hides the flow", async () => {
    vi.resetModules();
    const { useOnboarding } = await import("../../src/renderer/state/onboardingStore");
    const store = useOnboarding.getState();
    expect(store.visible).toBe(false);

    store.replay();
    expect(useOnboarding.getState()).toMatchObject({ visible: true, step: 0 });
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(1);
    useOnboarding.getState().goTo(99);
    expect(useOnboarding.getState().step).toBe(4);
    useOnboarding.getState().back();
    expect(useOnboarding.getState().step).toBe(3);
    useOnboarding.getState().finish();
    expect(useOnboarding.getState()).toMatchObject({ visible: false, step: 0 });
  });
});

describe("Fetch All store contract", () => {
  it("never starts a job from init/subscription; start is an explicit action that returns at once", async () => {
    vi.resetModules();
    const idle = {
      jobId: null,
      state: "idle",
      total: 0,
      processed: 0,
      found: 0,
      notFound: 0,
      failed: 0,
      skipped: 0,
      currentTrack: null,
      startedAt: null,
      finishedAt: null,
    };
    let progressListener: ((snapshot: never) => void) | null = null;
    const fetchAll = {
      getState: vi.fn(async () => idle),
      start: vi.fn(async () => ({ ...idle, jobId: "job-1", state: "running", total: 3 })),
      pause: vi.fn(async () => idle),
      resume: vi.fn(async () => idle),
      cancel: vi.fn(async () => idle),
      retryFailed: vi.fn(async () => idle),
      stats: vi.fn(async () => ({ totalTracks: 3, withLyrics: 1, needsSearch: 2, fullyProcessed: 1 })),
      promote: vi.fn(async () => undefined),
      onProgress: vi.fn((listener: (snapshot: unknown) => void) => {
        progressListener = listener;
        return () => undefined;
      }),
    };
    vi.stubGlobal("window", { cadence: { lyrics: { fetchAll } } });

    const { useFetchAll } = await import("../../src/renderer/state/fetchAllStore");
    useFetchAll.getState().init();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetchAll.start).not.toHaveBeenCalled();
    expect(useFetchAll.getState().snapshot.state).toBe("idle");

    // The onboarding button's action: kicks the job off and resolves immediately with the
    // running snapshot — the caller advances without waiting for any fetching to finish.
    await useFetchAll.getState().start();
    expect(fetchAll.start).toHaveBeenCalledTimes(1);
    expect(useFetchAll.getState().snapshot).toMatchObject({ state: "running", total: 3 });

    // Progress snapshots from the bridge are mirrored verbatim (top bar reads this state).
    (progressListener as ((snapshot: unknown) => void) | null)?.({
      ...idle,
      jobId: "job-1",
      state: "running",
      total: 3,
      processed: 2,
      found: 2,
    });
    expect(useFetchAll.getState().snapshot).toMatchObject({ processed: 2, found: 2 });

    await useFetchAll.getState().refreshStats();
    expect(useFetchAll.getState().stats).toEqual({ totalTracks: 3, withLyrics: 1, needsSearch: 2, fullyProcessed: 1 });
  });
});
