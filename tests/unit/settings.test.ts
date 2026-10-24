import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/main/settings";
import { SettingsCore, parseSettingsJson } from "../../src/main/settingsCore";
import { DEFAULT_PROVIDER_ORDER } from "../../src/shared/upstream/better-lyrics/constants";
import { emptyDatabase } from "../../src/main/library/storeCore";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import { installTauriBridge } from "../../src/tauri/bridge";
import { useSettings } from "../../src/renderer/state/settingsStore";

const workDir = mkdtempSync(join(tmpdir(), "cadence-settings-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("secondary font size settings", () => {
  it("ships defaults matching the renderer's secondary typography", () => {
    expect(DEFAULT_SETTINGS.lyrics.translationFontSizePx).toBe(32);
    expect(DEFAULT_SETTINGS.lyrics.romanizationFontSizePx).toBe(26);
  });

  it("adds the sizes to settings files written before they existed, keeping the rest", () => {
    const file = join(workDir, "legacy.json");
    writeFileSync(
      file,
      JSON.stringify({ lyrics: { fontSizeRem: 2.2, translationLanguage: "en" } }),
      "utf8"
    );
    const settings = new SettingsStore(file).get();
    expect(settings.lyrics.fontSizeRem).toBe(2.2);
    expect(settings.lyrics.translationLanguage).toBe("en");
    expect(settings.lyrics.translationFontSizePx).toBe(32);
    expect(settings.lyrics.romanizationFontSizePx).toBe(26);
  });

  it("persists the two sizes independently across a restart", () => {
    const file = join(workDir, "sizes.json");
    const first = new SettingsStore(file);
    first.patch({ lyrics: { translationFontSizePx: 18 } });
    first.patch({ lyrics: { romanizationFontSizePx: 14 } });

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.lyrics.translationFontSizePx).toBe(18);
    expect(onDisk.lyrics.romanizationFontSizePx).toBe(14);

    const reopened = new SettingsStore(file).get();
    expect(reopened.lyrics.translationFontSizePx).toBe(18);
    expect(reopened.lyrics.romanizationFontSizePx).toBe(14);
  });
});

describe("providerOrder persistence, startup hydration, and Tauri restart round-trip", () => {
  beforeEach(() => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as unknown as { window: unknown }).window = globalThis;
    }
    useSettings.setState({ settings: null, loaded: false, error: null });
  });

  afterEach(() => {
    clearMocks();
    setRuntimeFetch((...args) => globalThis.fetch(...args));
    delete (globalThis as { cadence?: unknown }).cadence;
  });

  it("preserves default order for users who never customized settings", () => {
    const file = join(workDir, "never-customized.json");
    const store = new SettingsStore(file);
    expect(store.get().lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
    expect(parseSettingsJson(null).lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("persists custom providerOrder (including d_-disabled removals) across SettingsStore restarts without overwriting with defaults", () => {
    const file = join(workDir, "custom-order.json");
    const customOrder = [
      "lrclib-plain",
      "unison-synced",
      "local-rich",
      "unison-richsynced",
      "binimum-richsynced",
      "blyrics-wordsynced",
      "local-lrc",
      "blyrics-line",
      "blyrics-synced",
      "qq-line",
      "lrclib-synced",
      "embedded-tag",
      "d_blyrics-richsynced",
    ];

    const session1 = new SettingsStore(file);
    session1.patch({ lyrics: { providerOrder: customOrder } });

    // Reopening from disk must NOT overwrite custom order with defaults or re-enable d_ slots.
    const session2 = new SettingsStore(file);
    expect(session2.get().lyrics.providerOrder).toEqual(customOrder);
  });

  it("serializes rapid async SettingsCore writes in order and never writes defaults during startup hydration", async () => {
    const writes: string[] = [];
    let unblockFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>(resolve => {
      unblockFirstWrite = resolve;
    });

    const initialCustom = [
      "embedded-tag",
      ...DEFAULT_PROVIDER_ORDER.filter(key => key !== "embedded-tag"),
    ];
    let writeCount = 0;
    const core = new SettingsCore({
      initialJson: JSON.stringify({ lyrics: { providerOrder: initialCustom } }),
      persist: async json => {
        writeCount += 1;
        if (writeCount === 1) await firstWriteGate;
        writes.push(json);
      },
    });

    // Startup hydration alone must never write back to disk.
    expect(writes).toHaveLength(0);
    expect(core.get().lyrics.providerOrder).toEqual(initialCustom);

    const step1 = [
      "lrclib-synced",
      ...DEFAULT_PROVIDER_ORDER.filter(key => key !== "lrclib-synced"),
    ];
    const step2 = [
      "unison-synced",
      "lrclib-synced",
      ...DEFAULT_PROVIDER_ORDER.filter(key => key !== "unison-synced" && key !== "lrclib-synced"),
    ];

    core.patch({ lyrics: { providerOrder: step1 } });
    core.patch({ lyrics: { providerOrder: step2 } });

    unblockFirstWrite();
    await core.flush();

    expect(writes).toHaveLength(2);
    const finalPersisted = parseSettingsJson(writes.at(-1));
    expect(finalPersisted.lyrics.providerOrder).toEqual(step2);
  });

  it("handles malformed settings JSON and malformed providerOrder payloads safely without throwing", () => {
    expect(parseSettingsJson("{broken json").lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
    expect(parseSettingsJson("null").lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
    expect(parseSettingsJson("[]").lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);
    expect(parseSettingsJson(JSON.stringify({ lyrics: null })).lyrics.providerOrder).toEqual(
      DEFAULT_PROVIDER_ORDER
    );
    expect(
      parseSettingsJson(JSON.stringify({ lyrics: { providerOrder: "not-an-array" } })).lyrics
        .providerOrder
    ).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("prevents a late startup load() from overwriting a user providerOrder patch in useSettings", async () => {
    let resolveInitialGet!: (value: typeof DEFAULT_SETTINGS) => void;
    const slowInitialGet = new Promise<typeof DEFAULT_SETTINGS>(resolve => {
      resolveInitialGet = resolve;
    });

    const customOrder = [
      "lrclib-plain",
      ...DEFAULT_PROVIDER_ORDER.filter(key => key !== "lrclib-plain"),
    ];

    (globalThis as unknown as { cadence: unknown }).cadence = {
      settings: {
        get: () => slowInitialGet,
        patch: async (patch: { lyrics?: { providerOrder?: string[] } }) => ({
          ...structuredClone(DEFAULT_SETTINGS),
          lyrics: {
            ...DEFAULT_SETTINGS.lyrics,
            providerOrder: patch.lyrics?.providerOrder ?? [...DEFAULT_PROVIDER_ORDER],
          },
        }),
        reset: async () => structuredClone(DEFAULT_SETTINGS),
      },
    };

    const pendingLoad = useSettings.getState().load();
    await useSettings.getState().patch({ lyrics: { providerOrder: customOrder } });

    // Now the stale initial load resolves with DEFAULT_PROVIDER_ORDER; it must NOT clobber customOrder.
    resolveInitialGet(structuredClone(DEFAULT_SETTINGS));
    await pendingLoad;

    expect(useSettings.getState().settings?.lyrics.providerOrder).toEqual(customOrder);
  });

  it("survives a full Tauri bridge close-and-reopen cycle and drives actual lyrics fetching order on restart", async () => {
    const disk = new Map<string, string>();
    const networkOrder: string[] = [];

    const wireMockBackend = () => {
      mockIPC(
        async (cmd, args) => {
          const payload = (args ?? {}) as Record<string, unknown>;
          switch (cmd) {
            case "cmd_bootstrap":
              return {
                platform: "win32",
                appDataDir: "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player",
                artworkDir: "C:\\Users\\Alice\\AppData\\Roaming\\app.cadence.player\\artwork",
                dbJson: disk.get("library") ?? JSON.stringify(emptyDatabase()),
                settingsJson: disk.get("settings") ?? null,
                lyricsCacheJson: disk.get("lyricsCache") ?? null,
                startupFiles: [],
              };
            case "cmd_write_user_json":
              disk.set(String(payload.kind), String(payload.content));
              return null;
            case "cmd_save_library_db":
              disk.set("library", String(payload.json));
              return null;
            case "cmd_set_allowed_roots":
              return null;
            case "cmd_http_abort":
              return null;
            case "cmd_http_fetch": {
              const reqArgs = payload.args as { url: string };
              const parsed = new URL(reqArgs.url);
              networkOrder.push(`${parsed.hostname}${parsed.pathname}`);
              if (parsed.hostname === "lrclib.net") {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    id: 101,
                    trackName: "Restart Song",
                    artistName: "Restart Artist",
                    albumName: "",
                    duration: 180,
                    syncedLyrics: "[00:01.00]lrclib synced",
                    plainLyrics: "lrclib plain first",
                  }),
                };
              }
              if (parsed.hostname === "unison.betterlyrics.org") {
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    success: true,
                    data: {
                      id: 99,
                      song: "Restart Song",
                      artist: "Restart Artist",
                      duration: 180,
                      format: "lrc",
                      syncType: "linesync",
                      lyrics: "[00:01.00]unison second",
                    },
                  }),
                };
              }
              return {
                status: 404,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ error: "not found" }),
              };
            }
            default:
              throw new Error(`Unexpected IPC command: ${cmd}`);
          }
        },
        { shouldMockEvents: true }
      );
    };

    // Session 1: fresh install -> user reorders providers and removes blyrics-richsynced (marked d_).
    wireMockBackend();
    const session1 = await installTauriBridge();
    await useSettings.getState().load();
    expect(useSettings.getState().settings?.lyrics.providerOrder).toEqual(DEFAULT_PROVIDER_ORDER);

    const customOrder = [
      "lrclib-plain",
      "unison-synced",
      "local-rich",
      "unison-richsynced",
      "binimum-richsynced",
      "blyrics-wordsynced",
      "local-lrc",
      "blyrics-line",
      "blyrics-synced",
      "qq-line",
      "lrclib-synced",
      "embedded-tag",
      "d_blyrics-richsynced",
    ];
    await useSettings.getState().patch({ lyrics: { providerOrder: customOrder } });
    session1.dispose();
    clearMocks();

    // Session 2: reopen Cadence from persisted disk state and resolve lyrics for an uncached track.
    useSettings.setState({ settings: null, loaded: false, error: null });
    wireMockBackend();

    const session2 = await installTauriBridge();
    await useSettings.getState().load();

    // Custom order + d_ removal survived restart intact.
    expect(useSettings.getState().settings?.lyrics.providerOrder).toEqual(customOrder);

    const resolved = await session2.api.lyrics.resolve({
      trackId: 999,
      title: "Restart Song",
      artist: "Restart Artist",
      album: "",
      duration: 180,
    });

    // LRCLIB was invoked FIRST (before Unison, BiniLyrics, and Better Lyrics), and disabled /getLyrics was skipped!
    expect(networkOrder[0]).toBe("lrclib.net/api/get");
    expect(networkOrder[1]).toBe("unison.betterlyrics.org/lyrics");
    expect(networkOrder).not.toContain("api.betterlyrics.org/getLyrics");
    expect(resolved.candidates.map(c => c.source)).toEqual([
      "lrclib-plain",
      "unison-synced",
      "lrclib-synced",
    ]);

    session2.dispose();
  });
});

