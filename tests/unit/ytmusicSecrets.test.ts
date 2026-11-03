/**
 * Policy tests for the YouTube Music account integration:
 *  - the account cookie is only ever passed through the OS secret store (`bridge.secrets`),
 *    never persisted into settings JSON (the YouTubeMusicSettings shape has no cookie field and
 *    normalize() must drop one if a hand-edited settings file contains it);
 *  - `remoteLyricsKey` produces stable, strictly negative keys that can never collide with a
 *    local track id (ids are >= 0), keeping remote lyrics sessions separate in the store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secretsCalls: { op: string; args: unknown }[] = [];
const settingsPatches: unknown[] = [];

vi.mock("../../src/renderer/state/bridge", () => ({
  hasBridge: () => true,
  bridge: {
    secrets: {
      store: vi.fn(async (args: unknown) => {
        secretsCalls.push({ op: "store", args });
      }),
      get: vi.fn(async (args: unknown) => {
        secretsCalls.push({ op: "get", args });
        return "SAPISID=stored-cookie";
      }),
      delete: vi.fn(async (args: unknown) => {
        secretsCalls.push({ op: "delete", args });
        return true;
      }),
    },
    settings: {
      get: vi.fn(async () => ({})),
      patch: vi.fn(async (patch: unknown) => {
        settingsPatches.push(patch);
        return {};
      }),
    },
    ytmusic: {},
  },
}));

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
  secretsCalls.length = 0;
  settingsPatches.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("YouTube Music account secret policy", () => {
  it("connectAccount sends the cookie to the OS secret store, never to settings", async () => {
    vi.resetModules();
    const { useYtm, YTM_SECRET_SERVICE } = await import("../../src/renderer/state/ytmusicStore");
    await useYtm.getState().connectAccount("  SAPISID=abc123; SID=xyz  ", "My Account");

    const store = secretsCalls.find(call => call.op === "store");
    expect(store).toBeDefined();
    expect(store!.args).toEqual({
      service: YTM_SECRET_SERVICE,
      account: "google-account-cookie",
      secret: "SAPISID=abc123; SID=xyz",
    });

    // The only settings write is the display name — no cookie material anywhere.
    expect(settingsPatches).toHaveLength(1);
    const patch = JSON.stringify(settingsPatches[0]);
    expect(patch).toContain("My Account");
    expect(patch).not.toContain("SAPISID");
    expect(patch).not.toContain("abc123");

    expect(useYtm.getState().account).toEqual({ mode: "connected", name: "My Account" });
  });

  it("disconnectAccount deletes the secret and clears the stored name", async () => {
    vi.resetModules();
    const { useYtm } = await import("../../src/renderer/state/ytmusicStore");
    await useYtm.getState().connectAccount("SAPISID=abc", "A");
    await useYtm.getState().disconnectAccount();
    expect(secretsCalls.some(call => call.op === "delete")).toBe(true);
    expect(JSON.stringify(settingsPatches.at(-1))).not.toContain("SAPISID");
    expect(useYtm.getState().account).toEqual({ mode: "guest" });
  });

  it("rejects an empty cookie without touching the secret store", async () => {
    vi.resetModules();
    const { useYtm } = await import("../../src/renderer/state/ytmusicStore");
    await useYtm.getState().connectAccount("   ", "A");
    expect(secretsCalls).toHaveLength(0);
    expect(useYtm.getState().account.mode).toBe("error");
  });

  it("settings normalization drops any cookie field smuggled into settings JSON", async () => {
    vi.resetModules();
    const { parseSettingsJson } = await import("../../src/main/settingsCore");
    const normalized = parseSettingsJson(
      JSON.stringify({
        youtubeMusic: {
          visitorData: "Cgtabc",
          gl: "ID",
          hl: "id",
          accountName: "A",
          cookie: "SAPISID=leaked",
        },
      })
    );
    expect(JSON.stringify(normalized.youtubeMusic)).not.toContain("SAPISID");
    expect(JSON.stringify(normalized.youtubeMusic)).not.toContain("cookie");
    expect(normalized.youtubeMusic.visitorData).toBe("Cgtabc");
    expect(normalized.youtubeMusic.accountName).toBe("A");
  });
});

describe("remoteLyricsKey", () => {
  it("is stable, strictly negative and source-unique (never collides with local ids >= 0)", async () => {
    vi.resetModules();
    const { remoteLyricsKey } = await import("../../src/renderer/features/lyrics/useLyrics");
    const a = { kind: "youtube-music", remoteId: "dQw4w9WgXcQ", canonicalUrl: "https://music.youtube.com/watch?v=dQw4w9WgXcQ" } as const;
    const b = { kind: "youtube-music", remoteId: "yPYZpwSpKmA", canonicalUrl: "https://music.youtube.com/watch?v=yPYZpwSpKmA" } as const;
    expect(remoteLyricsKey(a)).toBe(remoteLyricsKey(a));
    expect(remoteLyricsKey(a)).toBeLessThan(0);
    expect(remoteLyricsKey(b)).toBeLessThan(0);
    expect(remoteLyricsKey(a)).not.toBe(remoteLyricsKey(b));
  });
});
