/**
 * Regression tests for multi-sidecar lyrics discovery.
 *
 * Every case writes real audio/lyrics files to disk and runs the shipped Node lyrics service
 * (`LyricsService` -> `nodeLocalLyricsReader` -> `LyricsServiceCore`); the last case drives the same
 * core through the Tauri bridge's `cmd_read_sidecar_text` IPC contract. Network providers are
 * stubbed or disabled — nothing here reaches a live API.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { LyricsCache } from "../../src/main/lyrics/cache";
import { LyricsService } from "../../src/main/lyrics/service";
import { LibraryStore } from "../../src/main/library/store";
import {
  nodeLocalLyricsReader,
  readAllLyricsFolder,
  readAllSidecarLyrics,
} from "../../src/main/lyrics/localLyrics";
import { createLocalLyricsReader } from "../../src/main/lyrics/localLyricsCore";
import { findSidecarLyricsFiles } from "../../src/main/library/metadata";
import { scanLibrary } from "../../src/main/library/scanner";
import { installTauriBridge } from "../../src/tauri/bridge";
import { setRuntimeFetch } from "../../src/main/lyrics/http";
import { emptyDatabase, type StoredTrack } from "../../src/main/library/storeCore";
import { DEFAULT_PROVIDER_ORDER } from "../../src/shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../src/shared/types";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_FLAC = join(ROOT, ".artifacts/fixtures/formats/fixture.flac");
const FIXTURE_WAV = join(ROOT, ".artifacts/fixtures/formats/fixture.wav");

const LRC = "[00:01.00]LRC line one\n[00:02.00]LRC line two";
const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:01.000" end="00:00:03.000"><span begin="00:00:01.000" end="00:00:01.600">Syl</span><span begin="00:00:01.600" end="00:00:03.000">lable</span></p>
<p begin="00:00:03.000" end="00:00:05.000"><span begin="00:00:03.000" end="00:00:03.700">TTML</span><span begin="00:00:03.700" end="00:00:05.000">line</span></p>
</div></body></tt>`;
const QRC = `<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricContent="[1000,2000]QRC(1000,700) line(1700,1300)
[3000,2000]Second(3000,800) line(3800,1200)
"/></QrcInfos>`;
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nSRT line one\n\n2\n00:00:02,000 --> 00:00:03,000\nSRT line two\n";
const PLAIN = "Plain text lyric one\nPlain text lyric two";
const MALFORMED_TTML = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>
<p begin="not-a-time"><span begin="also-bad">broken TTML`;
const REMOTE_TTML_SYLLABLE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:01.000" end="00:00:03.000"><span begin="00:00:01.000" end="00:00:01.600">Re</span><span begin="00:00:01.600" end="00:00:03.000">mote</span></p>
</div></body></tt>`;
const REMOTE_TTML_LINE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
<p begin="00:00:01.000" end="00:00:03.000">Remote line lyrics</p>
</div></body></tt>`;

const dirs: string[] = [];

function makeFixture(files: Record<string, string>, audioName = "Song.flac") {
  const dir = mkdtempSync(join(tmpdir(), "cadence-sidecars-"));
  dirs.push(dir);
  const audioPath = join(dir, audioName);
  copyFileSync(FIXTURE_FLAC, audioPath);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
  const cache = new LyricsCache(join(dir, "lyrics-cache.json"));
  const store = {
    getTrack: () => ({ path: audioPath, title: "Song", trackNo: 1 }),
    getLyrics: () => null,
  } as unknown as LibraryStore;
  const service = new LyricsService(store, cache);
  const request = {
    trackId: 1,
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 60,
    localOnly: true,
  } as Parameters<LyricsService["resolve"]>[0];
  return { dir, audioPath, cache, service, request };
}

const localSources = (candidates: LyricsCandidate[]) => candidates.map(candidate => candidate.source);
const statusOf = (statuses: { provider: string; status: string; detail?: string }[], provider: string) =>
  statuses.find(entry => entry.provider === provider);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("multi-sidecar lyrics discovery (real files, real service)", () => {
  it("1. finds an LRC-only sidecar under the local-lrc provider", async () => {
    const { audioPath, service, request } = makeFixture({ "Song.lrc": LRC });

    const all = await readAllSidecarLyrics(audioPath);
    expect(all.map(file => basename(file.path))).toEqual(["Song.lrc"]);
    expect(all[0].format).toBe("lrc");

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(result.candidates)).toEqual(["local-lrc"]);
    expect(result.candidates[0]).toMatchObject({ provider: "Local LRC", text: LRC, syncHint: "synced" });
    expect(result.candidates[0].sourceHref?.endsWith("Song.lrc")).toBe(true);
    expect(statusOf(result.providerStatus, "local-lrc")?.status).toBe("hit");
    expect(statusOf(result.providerStatus, "local-rich")?.status).toBe("miss");
  });

  it("2. finds a TTML-only sidecar under the local-rich provider, never Better Lyrics", async () => {
    const { audioPath, service, request } = makeFixture({ "Song.ttml": TTML });

    const all = await readAllSidecarLyrics(audioPath);
    expect(all.map(file => basename(file.path))).toEqual(["Song.ttml"]);
    expect(all[0].format).toBe("ttml");

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(result.candidates)).toEqual(["local-rich"]);
    expect(result.candidates[0]).toMatchObject({ provider: "Local TTML/QRC", text: TTML, syncHint: "richsync" });
    expect(result.candidates[0].sourceHref?.endsWith("Song.ttml")).toBe(true);
    expect(statusOf(result.providerStatus, "local-rich")?.status).toBe("hit");
    expect(statusOf(result.providerStatus, "local-lrc")?.status).toBe("miss");
    expect(result.candidates.map(candidate => candidate.provider)).not.toContain("Better Lyrics");
  });

  it("3. discovers and attributes BOTH LRC and TTML when they exist together", async () => {
    const { dir, audioPath, service, request } = makeFixture({ "Song.lrc": LRC, "Song.ttml": TTML });

    expect(findSidecarLyricsFiles(audioPath).map(name => basename(name)).sort()).toEqual(["Song.lrc", "Song.ttml"]);
    const all = await readAllSidecarLyrics(audioPath);
    expect(all.map(file => basename(file.path)).sort()).toEqual(["Song.lrc", "Song.ttml"]);

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(result.candidates)).toEqual(["local-rich", "local-lrc"]);
    expect(new Set(localSources(result.candidates)).size).toBe(2);
    const rich = result.candidates.find(candidate => candidate.source === "local-rich")!;
    const line = result.candidates.find(candidate => candidate.source === "local-lrc")!;
    expect(rich).toMatchObject({ provider: "Local TTML/QRC", text: TTML, syncHint: "richsync" });
    expect(line).toMatchObject({ provider: "Local LRC", text: LRC, syncHint: "synced" });
    expect(rich.sourceHref).toBe(join(dir, "Song.ttml"));
    expect(line.sourceHref).toBe(join(dir, "Song.lrc"));
    expect(statusOf(result.providerStatus, "local-rich")?.status).toBe("hit");
    expect(statusOf(result.providerStatus, "local-lrc")?.status).toBe("hit");
  });

  it("4. discovers every supported format but emits only one candidate per local provider", async () => {
    const files = {
      "Song.lrc": LRC,
      "Song.ttml": TTML,
      "Song.qrc": QRC,
      "Song.srt": SRT,
      "Song.txt": PLAIN,
    };
    const { audioPath, service, request } = makeFixture(files);

    const all = await readAllSidecarLyrics(audioPath);
    expect(all.map(file => basename(file.path))).toEqual([
      "Song.lrc",
      "Song.ttml",
      "Song.qrc",
      "Song.srt",
      "Song.txt",
    ]);
    expect(all.map(file => file.format)).toEqual(["lrc", "ttml", "qrc", "srt", "text"]);

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(result.candidates)).toEqual(["local-rich", "local-lrc"]);
    expect(new Set(localSources(result.candidates)).size).toBe(result.candidates.length);
    // The first usable file in the existing extension order represents each slot; all five were read.
    expect(basename(result.candidates[0].sourceHref!)).toBe("Song.ttml");
    expect(basename(result.candidates[1].sourceHref!)).toBe("Song.lrc");
    expect(statusOf(result.providerStatus, "local-rich")?.detail).toContain("+1 more sidecar");
    expect(statusOf(result.providerStatus, "local-lrc")?.detail).toContain("+2 more sidecars");
  });

  it("5. leaves lyrics files belonging to other songs and unsupported extensions alone", async () => {
    const { audioPath, service, request } = makeFixture({
      "Song.lrc": LRC,
      "Other Song.lrc": "[00:01.00]wrong song",
      "Song2.ttml": TTML,
      "Song.extra.qrc": QRC,
      "Song.lrc.bak": "[00:01.00]backup",
      "Song.ass": "[Script Info]\nnot a supported sidecar",
      "notes.txt": "unrelated notes",
    });

    const all = await readAllSidecarLyrics(audioPath);
    expect(all.map(file => basename(file.path))).toEqual(["Song.lrc"]);

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(result.candidates)).toEqual(["local-lrc"]);
    expect(result.candidates[0].text).toBe(LRC);
    expect(statusOf(result.providerStatus, "local-rich")?.status).toBe("miss");
  });

  it("6. handles mixed-case extensions and case-insensitive hosts without duplicates", async () => {
    const mixed = makeFixture({ "Song.LrC": LRC, "Song.TtMl": TTML });
    const mixedFiles = await readAllSidecarLyrics(mixed.audioPath);
    expect(mixedFiles.map(file => basename(file.path)).sort()).toEqual(["Song.LrC", "Song.TtMl"]);
    const mixedResult = await mixed.service.resolve(mixed.request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(mixedResult.candidates)).toEqual(["local-rich", "local-lrc"]);
    expect(new Set(localSources(mixedResult.candidates)).size).toBe(2);

    // Tauri hosts without a directory listing probe generated case variants instead.
    const noListing = createLocalLyricsReader({
      readTextFile: async path =>
        path.endsWith("Song.LrC") ? LRC : path.endsWith("Song.TtMl") ? TTML : null,
    });
    const probed = await noListing.readAllSidecarLyrics(mixed.audioPath);
    expect(probed.map(file => basename(file.path)).sort()).toEqual(["Song.LrC", "Song.TtMl"]);
    expect(new Set(probed.map(file => file.path)).size).toBe(probed.length);

    // On Windows all variants of one extension name the same file; discovery collapses them.
    const windows = createLocalLyricsReader(
      { readTextFile: async path => (path.toLowerCase().endsWith("song.lrc") ? LRC : null) },
      { caseInsensitivePaths: true }
    );
    const windowsFiles = await windows.readAllSidecarLyrics(mixed.audioPath);
    expect(windowsFiles).toHaveLength(1);
    expect(windowsFiles[0].format).toBe("lrc");
  });

  it("7. reports malformed TTML parsing errors while the valid LRC still loads", async () => {
    const { service, request } = makeFixture({ "Song.lrc": LRC, "Song.ttml": MALFORMED_TTML });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await service.resolve(request, DEFAULT_PROVIDER_ORDER);

    expect(localSources(result.candidates)).toEqual(["local-lrc"]);
    expect(result.candidates[0].text).toBe(LRC);
    const richStatus = statusOf(result.providerStatus, "local-rich");
    expect(richStatus?.status).toBe("error");
    expect(richStatus?.detail).toContain("Song.ttml");
    expect(richStatus?.detail).toContain("Unusable");
    expect(warn.mock.calls.some(call => call.some(part => String(part).includes("Song.ttml")))).toBe(true);
  });

  it("8. keeps repeated library scans and repeated resolves free of duplicate results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-sidecar-scan-"));
    dirs.push(dir);
    const music = join(dir, "music");
    mkdirSync(music, { recursive: true });
    copyFileSync(FIXTURE_WAV, join(music, "Song.wav"));
    writeFileSync(join(music, "Song.lrc"), LRC, "utf8");
    writeFileSync(join(music, "Song.ttml"), TTML, "utf8");

    const store = new LibraryStore(join(dir, "library.db"), join(dir, "artwork"), path => `media://${path}`, {
      disableSqlite: true,
    });
    await scanLibrary(store, { folders: [music] });
    const second = await scanLibrary(store, { folders: [music] });
    expect(second.added).toBe(0);
    const tracks = store.getTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].hasSidecarLyrics).toBe(true);

    const service = new LyricsService(store, new LyricsCache(join(dir, "lyrics-cache.json")));
    const request = {
      trackId: tracks[0].id,
      title: "Song",
      artist: "Unknown artist",
      album: "Unknown album",
      duration: 6,
      localOnly: true,
    } as Parameters<LyricsService["resolve"]>[0];
    const first = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    const again = await service.resolve(request, DEFAULT_PROVIDER_ORDER);
    expect(localSources(first.candidates)).toEqual(["local-rich", "local-lrc"]);
    expect(localSources(again.candidates)).toEqual(["local-rich", "local-lrc"]);
    expect(new Set(localSources(again.candidates)).size).toBe(2);
  });

  it("9. reads all files in the Lyrics/ folder convention, including a lowercase folder", async () => {
    const { audioPath } = makeFixture({});
    const lyricsDir = join(audioPath, "..", "lyrics");
    mkdirSync(lyricsDir, { recursive: true });
    writeFileSync(join(lyricsDir, "Song.lrc"), LRC, "utf8");
    writeFileSync(join(lyricsDir, "Song.ttml"), TTML, "utf8");

    const all = await readAllLyricsFolder(audioPath, 1, "Song");
    expect(all.map(file => basename(file.path)).sort()).toEqual(["Song.lrc", "Song.ttml"]);
    expect(new Set(all.map(file => file.path)).size).toBe(2);
  });

  it("10. preserves configured provider priority and remote fallback", async () => {
    const { service, request } = makeFixture({ "Song.lrc": LRC, "Song.ttml": TTML });

    const reordered = await service.resolve(request, [
      "local-lrc",
      "local-rich",
      "lrclib-synced",
      "embedded-tag",
    ]);
    expect(reordered.candidates.slice(0, 2).map(candidate => candidate.source)).toEqual([
      "local-lrc",
      "local-rich",
    ]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("lrclib.net/api/get")) {
        return json({
          id: 1,
          trackName: "Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 60,
          instrumental: false,
          syncedLyrics: "[00:01.00]Remote fallback line",
          plainLyrics: null,
        });
      }
      if (url.includes("binimum.org")) return json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
      return json({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const withFallback = await service.resolve(
      { ...request, localOnly: false, title: "Fallback Song" },
      ["local-lrc", "lrclib-synced", "embedded-tag", "d_local-rich"]
    );
    expect(withFallback.candidates[0].source).toBe("local-lrc");
    expect(withFallback.candidates.map(candidate => candidate.source)).toContain("lrclib-synced");
    expect(statusOf(withFallback.providerStatus, "local-rich")?.status).toBe("skipped");
    expect(withFallback.candidates.map(candidate => candidate.source)).not.toContain("local-rich");
  });

  it("11. keeps local TTML, Better Lyrics and Better Lyrics Line identities separate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-sidecar-identity-"));
    dirs.push(dir);
    const audioPath = join(dir, "Song.flac");
    copyFileSync(FIXTURE_FLAC, audioPath);
    writeFileSync(join(dir, "Song.lrc"), LRC, "utf8");
    writeFileSync(join(dir, "Song.ttml"), TTML, "utf8");
    const store = {
      getTrack: () => ({ path: audioPath, title: "Song", trackNo: 1 }),
      getLyrics: () => null,
    } as unknown as LibraryStore;
    const service = new LyricsService(store, new LyricsCache(join(dir, "lyrics-cache.json")));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/getLyrics") {
          const payload = url.searchParams.get("s") === "Line Song" ? REMOTE_TTML_LINE : REMOTE_TTML_SYLLABLE;
          return json({ ttml: payload });
        }
        if (url.hostname.includes("binimum.org")) return json({ total: 0, source: "HIT-LOCAL-LIBSQL", results: [] });
        return json({ error: "not found" }, 404);
      })
    );

    const syllable = await service.resolve(
      {
        trackId: 1,
        title: "Syllable Song",
        artist: "Artist",
        album: "Album",
        duration: 60,
        localOnly: false,
      } as Parameters<LyricsService["resolve"]>[0],
      DEFAULT_PROVIDER_ORDER
    );
    expect(syllable.candidates.map(candidate => candidate.source)).toEqual([
      "local-rich",
      "blyrics-richsynced",
      "local-lrc",
    ]);
    expect(syllable.candidates.find(candidate => candidate.source === "local-rich")).toMatchObject({
      provider: "Local TTML/QRC",
      text: TTML,
    });
    expect(syllable.candidates.find(candidate => candidate.source === "blyrics-richsynced")).toMatchObject({
      provider: "Better Lyrics",
      text: REMOTE_TTML_SYLLABLE,
    });
    expect(syllable.candidates.find(candidate => candidate.source === "local-lrc")).toMatchObject({
      provider: "Local LRC",
      text: LRC,
    });
    expect(syllable.candidates[0].text).toBe(TTML);

    const line = await service.resolve(
      {
        trackId: 1,
        title: "Line Song",
        artist: "Artist",
        album: "Album",
        duration: 60,
        localOnly: false,
      } as Parameters<LyricsService["resolve"]>[0],
      DEFAULT_PROVIDER_ORDER
    );
    expect(line.candidates.map(candidate => candidate.source)).toContain("blyrics-line");
    expect(line.candidates.map(candidate => candidate.source)).not.toContain("blyrics-richsynced");
  });

  it("12. skips inaccessible or empty sidecars without hiding valid files", async () => {
    const { audioPath } = makeFixture({});
    const reader = createLocalLyricsReader({
      listFiles: async () => ["Song.lrc", "Song.ttml", "Song.qrc"],
      readTextFile: async path => {
        if (path.endsWith("Song.ttml")) throw new Error("EACCES");
        if (path.endsWith("Song.qrc")) return "  \n  ";
        return path.endsWith("Song.lrc") ? LRC : null;
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const all = await reader.readAllSidecarLyrics(audioPath);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ text: LRC, format: "lrc" });
    expect(nodeLocalLyricsReader).toBeTruthy(); // Node adapter is the one used by the service tests.
  });
});

describe("Tauri bridge sidecar IPC path", () => {
  beforeEach(() => {
    if (typeof (globalThis as { window?: unknown }).window === "undefined") {
      (globalThis as unknown as { window: unknown }).window = globalThis;
    }
  });
  afterEach(() => {
    clearMocks();
    setRuntimeFetch((...args) => globalThis.fetch(...args));
    delete (globalThis as { cadence?: unknown }).cadence;
  });

  it("registers the directory-listing command beside sidecar text reads", () => {
    const commands = readFileSync(join(ROOT, "src-tauri/src/commands.rs"), "utf8");
    const registration = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
    expect(commands).toContain("pub async fn cmd_list_directory");
    expect(registration).toContain("commands::cmd_list_directory");
  });

  it("reads LRC and TTML through cmd_read_sidecar_text and exposes both local providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-sidecar-tauri-"));
    dirs.push(dir);
    const audioPath = join(dir, "Song.flac");
    copyFileSync(FIXTURE_FLAC, audioPath);
    writeFileSync(join(dir, "Song.lrc"), LRC, "utf8");
    writeFileSync(join(dir, "Song.ttml"), TTML, "utf8");

    const track: StoredTrack = {
      id: 7,
      path: audioPath,
      title: "Song",
      artist: "Artist",
      albumArtist: "Artist",
      album: "Album",
      genre: "",
      year: null,
      trackNo: 1,
      discNo: 1,
      duration: 60,
      bitrate: null,
      sampleRate: null,
      channels: 2,
      codec: "FLAC",
      container: "flac",
      fileSize: 1,
      mtimeMs: 1,
      artworkFile: null,
      animatedArtPath: null,
      accentColor: null,
      hasEmbeddedLyrics: false,
      hasSidecarLyrics: true,
      playable: true,
      favorite: false,
      addedAt: 1,
      lastPlayedAt: null,
      playCount: 0,
    };
    const db = emptyDatabase();
    db.tracks.push(track);

    mockIPC(
      async (cmd, payload: any) => {
        switch (cmd) {
          case "cmd_bootstrap":
            return {
              appDataDir: dir,
              artworkDir: join(dir, "artwork"),
              platform: "linux",
              arch: "x86_64",
              appVersion: "0.2.2",
              tauriVersion: "2.12.5",
              settingsJson: null,
              lyricsCacheJson: null,
              dbSnapshot: { ...structuredClone(db), lyrics: {} },
              startupFiles: [],
              undecorated: false,
            };
          case "cmd_list_directory":
            // Mirrors the new Rust command: only directory entry names, never full paths.
            try {
              return readdirSync(String(payload?.directory ?? ""));
            } catch {
              return [];
            }
          case "cmd_read_sidecar_text": {
            // Mirrors the Rust command: allowlisted, supported extension, bounded text file.
            const target = String(payload?.path ?? "");
            if (!/\.(lrc|ttml|qrc|srt|txt)$/i.test(target) || !existsSync(target)) return null;
            try {
              return readFileSync(target, "utf8");
            } catch {
              return null;
            }
          }
          case "cmd_load_lyrics":
            return null;
          default:
            return null;
        }
      },
      { shouldMockEvents: true }
    );

    const session = await installTauriBridge();
    try {
      const result = await session.api.lyrics.resolve({
        trackId: 7,
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration: 60,
        localOnly: true,
      } as never);
      expect(localSources(result.candidates)).toEqual(["local-rich", "local-lrc"]);
      expect(result.candidates.map(candidate => basename(candidate.sourceHref ?? "")).sort()).toEqual([
        "Song.lrc",
        "Song.ttml",
      ]);
      expect(new Set(localSources(result.candidates)).size).toBe(2);
      expect(statusOf(result.providerStatus, "local-rich")?.status).toBe("hit");
      expect(statusOf(result.providerStatus, "local-lrc")?.status).toBe("hit");
    } finally {
      session.dispose();
    }
  });
});
