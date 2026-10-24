/**
 * Tests for the application-level lyrics session store that fixes lyrics disappearing when the
 * Now Playing view unmounts on tab changes. A localStorage stub stands in for the browser API;
 * modules are dynamically imported so hydration timing can be controlled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../src/shared/types";

const STORAGE_KEY = "cadence.lyrics.session.v1";

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

const track = (id: number): Track =>
  ({
    id,
    path: `/music/song-${id}.flac`,
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    albumArtist: "Artist",
    duration: 200,
    trackNo: id,
  }) as Track;

async function freshStore(storage?: MemoryStorage) {
  vi.resetModules();
  if (storage) vi.stubGlobal("localStorage", storage);
  else vi.stubGlobal("localStorage", new MemoryStorage());
  return import("../../src/renderer/state/lyricsStore");
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("lyrics session store", () => {
  it("keeps active lyrics and selection alive without any component mounted", async () => {
    const { useLyricsStore } = await freshStore();
    const store = useLyricsStore.getState();

    store.setActive(7, {
      status: "ready",
      candidates: [{ source: "blyrics-richsynced", provider: "Better Lyrics", text: "lyrics", syncHint: "richsync" } as never],
      activeSource: "blyrics-richsynced",
      syncType: "richsync",
      providerStatus: [{ provider: "better-lyrics", status: "hit" }],
    });
    store.setSelectedSource(7, "blyrics-richsynced");

    // Simulate LyricsView unmounting and remounting: the module singleton is never re-created,
    // so every value the view needs is still present with no refetch triggered by state loss.
    const after = useLyricsStore.getState();
    expect(after.status).toBe("ready");
    expect(after.activeSource).toBe("blyrics-richsynced");
    expect(after.candidates).toHaveLength(1);
    expect(after.selectedSources[7]).toBe("blyrics-richsynced");
  });

  it("creates one search session per track, seeded from the track tags, and isolates them", async () => {
    const { useLyricsStore } = await freshStore();
    const store = useLyricsStore.getState();

    const first = store.ensureSession(track(1));
    expect(first.draft).toEqual({ title: "Song 1", artist: "Artist", album: "Album", youtubeUrl: "" });
    expect(first.manual.status).toBe("idle");

    store.patchDraft(1, { title: "Corrected Title" });
    store.setManual(1, { status: "ready", results: [{ source: "lrclib-synced", text: "x" } as never], error: null });

    // A second track gets its own session; the first one is untouched.
    store.ensureSession(track(2));
    expect(useLyricsStore.getState().sessions[1].draft.title).toBe("Corrected Title");
    expect(useLyricsStore.getState().sessions[1].manual.status).toBe("ready");
    expect(useLyricsStore.getState().sessions[2].draft.title).toBe("Song 2");
    expect(useLyricsStore.getState().sessions[2].manual.status).toBe("idle");

    // Re-calling ensureSession never resets an existing session (reopening the selector).
    const again = useLyricsStore.getState().ensureSession(track(1));
    expect(again.draft.title).toBe("Corrected Title");
    expect(again.manual.status).toBe("ready");
  });

  it("persists drafts, YouTube metadata and selections, but not full result rows", async () => {
    const storage = new MemoryStorage();
    const { useLyricsStore } = await freshStore(storage);
    const store = useLyricsStore.getState();

    store.ensureSession(track(3));
    store.patchDraft(3, { title: "Typed Query", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" });
    store.setYoutube(3, {
      status: "ready",
      videoId: "dQw4w9WgXcQ",
      metadata: { videoId: "dQw4w9WgXcQ", title: "Video", artist: "Channel", durationSeconds: 211, thumbnailUrl: null },
      detail: null,
    });
    store.setManual(3, { status: "ready", results: [{ source: "unison-synced", text: "full lyric text" } as never], error: null });
    store.setSelectedSource(3, "unison-synced");

    const persisted = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(persisted.drafts[3].title).toBe("Typed Query");
    expect(persisted.youtube[3].metadata.title).toBe("Video");
    expect(persisted.selectedSources[3]).toBe("unison-synced");
    // Heavy result text stays in memory only; the main-process LyricsCache owns durable lyric text.
    expect(JSON.stringify(persisted)).not.toContain("full lyric text");
  });

  it("rehydrates drafts and selections on a fresh load (application restart)", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        drafts: { 5: { title: "Restored Query", artist: "Restored Artist", album: "Album", youtubeUrl: "" } },
        youtube: { 5: { status: "idle", videoId: null, metadata: null, detail: null } },
        selectedSources: { 5: "lrclib-plain" },
      })
    );

    const { useLyricsStore } = await freshStore(storage);
    const session = useLyricsStore.getState().ensureSession(track(5));
    expect(session.draft.title).toBe("Restored Query");
    expect(session.draft.artist).toBe("Restored Artist");
    expect(useLyricsStore.getState().selectedSources[5]).toBe("lrclib-plain");
  });

  it("clearSearch is the only thing that resets a session, back to the track defaults", async () => {
    const { useLyricsStore } = await freshStore();
    const store = useLyricsStore.getState();
    store.ensureSession(track(9));
    store.patchDraft(9, { title: "Changed", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" });
    store.setManual(9, { status: "ready", results: [{ source: "x", text: "y" } as never], error: null });

    store.clearSearch(9, track(9));

    const session = useLyricsStore.getState().sessions[9];
    expect(session.draft).toEqual({ title: "Song 9", artist: "Artist", album: "Album", youtubeUrl: "" });
    expect(session.manual.status).toBe("idle");
    expect(session.youtube.status).toBe("idle");
    // The active lyrics selection is a separate concern and is not cleared.
    expect(useLyricsStore.getState().selectedSources[9]).toBeUndefined();
  });

  it("records a selection for the active track only and survives storage failures", async () => {
    const { useLyricsStore } = await freshStore();
    const store = useLyricsStore.getState();
    store.ensureSession(track(1));
    store.setActive(1, { status: "ready" });
    store.setSelectedSource(1, "binimum-richsynced");
    expect(useLyricsStore.getState().activeSource).toBe("binimum-richsynced");

    // A selection made for another track must not move the active source.
    store.setSelectedSource(2, "lrclib-synced");
    expect(useLyricsStore.getState().activeSource).toBe("binimum-richsynced");

    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage quota exceeded");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    };
    vi.stubGlobal("localStorage", failing);
    expect(() => store.patchDraft(1, { title: "No persistence but still works" })).not.toThrow();
    expect(useLyricsStore.getState().sessions[1].draft.title).toBe("No persistence but still works");
  });

  it("ignores corrupted persisted data and starts clean", async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{not valid json");
    const { useLyricsStore } = await freshStore(storage);
    expect(useLyricsStore.getState().selectedSources).toEqual({});
    const session = useLyricsStore.getState().ensureSession(track(11));
    expect(session.draft.title).toBe("Song 11");
  });

  it("strips synthetic Unknown artist / Unknown album placeholders when seeding and clearing drafts", async () => {
    const { useLyricsStore } = await freshStore();
    const store = useLyricsStore.getState();

    const untagged: Track = {
      ...track(21),
      title: "  Loose File  ",
      artist: "  Unknown Artist ",
      album: "unknown album",
    };
    const seeded = store.ensureSession(untagged);
    expect(seeded.draft).toEqual({ title: "Loose File", artist: "", album: "", youtubeUrl: "" });

    store.patchDraft(21, { artist: "Typed Artist", album: "Typed Album" });
    store.clearSearch(21, untagged);
    expect(useLyricsStore.getState().sessions[21].draft).toEqual({
      title: "Loose File",
      artist: "",
      album: "",
      youtubeUrl: "",
    });

    const realUnknown: Track = {
      ...track(22),
      title: "Multi-Love",
      artist: "Unknown Mortal Orchestra",
      album: "Unknown Pleasures",
    };
    expect(store.ensureSession(realUnknown).draft).toEqual({
      title: "Multi-Love",
      artist: "Unknown Mortal Orchestra",
      album: "Unknown Pleasures",
      youtubeUrl: "",
    });
  });
});
