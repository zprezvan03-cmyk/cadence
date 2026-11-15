import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MediaAllowlist, isPathInside, resolveContainedPath } from "../../src/main/media/allowlist";
import { parseMediaUrl, tauriArtworkUrl, toTauriMediaUrl } from "../../src/main/media/protocolHandler";
import { RangeTokenizer } from "../../src/main/library/rangeTokenizer";
import {
  isPlayableExtension,
  readTrackMetadataCore,
  resolveEffectiveExtension,
} from "../../src/main/library/metadataCore";
import { scanLibraryCore } from "../../src/main/library/scannerCore";
import { LibraryStoreCore, emptyDatabase } from "../../src/main/library/storeCore";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  parseSettingsJson,
} from "../../src/main/settingsCore";
import { computeIsMobileLayout } from "../../src/renderer/app/useMobileShell";
import {
  androidPlaybackClock,
  androidSetSystemBarsTheme,
  isAndroidNativeAudio,
  subscribeAndroidAudioEvents,
  subscribeAndroidScanWalkProgress,
  syncQueueToAndroid,
} from "../../src/renderer/audio/androidAudio";
import type { CadenceApi, Track } from "../../src/shared/types";

const rootDir = resolve(import.meta.dirname, "../..");

function makeTrack(id: number, path: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    path,
    streamUrl: toTauriMediaUrl(path, "file", "android"),
    title: `Track ${id}`,
    artist: "Cadence Artist",
    album: "Cadence Album",
    albumArtist: "Cadence Artist",
    genre: "Electronic",
    year: 2026,
    trackNo: id,
    discNo: 1,
    duration: 185,
    bitrate: 320,
    sampleRate: 48000,
    channels: 2,
    codec: "FLAC",
    container: "flac",
    fileSize: 1024,
    mtimeMs: 1000,
    artworkUrl: null,
    animatedArtUrl: null,
    accentColor: null,
    hasEmbeddedLyrics: false,
    favorite: false,
    addedAt: 1000,
    lastPlayedAt: null,
    playCount: 0,
    replayGainTrackDb: -3.5,
    replayGainAlbumDb: null,
    replayGainTrackPeak: 0.92,
    replayGainAlbumPeak: null,
    hasSidecarLyrics: false,
    playable: true,
    ...overrides,
  };
}

describe("Android storage allowlist & media URL routing", () => {
  it("supports Android MediaStore roots and SAF content:// URIs safely", () => {
    expect(isPathInside("mediastore://audio", "content://media/external/audio/media/42", "posix")).toBe(true);
    expect(isPathInside("mediastore://audio", "/storage/emulated/0/Music/song.flac", "posix")).toBe(true);
    expect(isPathInside("mediastore://audio", "/mnt/media_rw/sdcard/Music/song.flac", "posix")).toBe(true);
    expect(isPathInside("mediastore://audio", "/data/data/app.cadence.player/files/secret.db", "posix")).toBe(false);

    expect(
      isPathInside(
        "content://com.android.externalstorage.documents/tree/primary%3AMusic",
        "content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2F01.flac",
        "posix"
      )
    ).toBe(true);

    expect(
      isPathInside(
        "content://com.android.externalstorage.documents/tree/primary%3AMusic",
        "content://com.android.externalstorage.documents/tree/primary%3AMusic/../Downloads/other.mp3",
        "posix"
      )
    ).toBe(false);

    const allowlist = new MediaAllowlist("posix");
    allowlist.setRoots(["mediastore://audio"]);
    expect(allowlist.allows("content://media/external/audio/media/101")).toBe(true);
    expect(allowlist.resolveAllowedPath("content://media/external/audio/media/101")).toBe(
      "content://media/external/audio/media/101"
    );
    expect(allowlist.allows("/storage/emulated/0/Music/track.mp3")).toBe(true);
    expect(allowlist.allows("/etc/passwd")).toBe(false);
    expect(resolveContainedPath("/data/user/0/app.cadence.player/artwork", "cover.jpg", "posix")).toBe(
      "/data/user/0/app.cadence.player/artwork/cover.jpg"
    );
  });

  it("uses http://cadence-media.localhost/ for Android WebView and round-trips parseMediaUrl", () => {
    const safUri = "content://media/external/audio/media/99";
    const mediaUrl = toTauriMediaUrl(safUri, "file", "android");
    expect(mediaUrl.startsWith("http://cadence-media.localhost/file/")).toBe(true);
    expect(parseMediaUrl(mediaUrl)).toEqual({ kind: "file", decodedPath: safUri });

    const artUrl = tauriArtworkUrl("/data/user/0/app.cadence.player/artwork", "abc123.jpg", "android");
    expect(artUrl.startsWith("http://cadence-media.localhost/art/")).toBe(true);
    expect(parseMediaUrl(artUrl)).toEqual({
      kind: "art",
      decodedPath: "/data/user/0/app.cadence.player/artwork/abc123.jpg",
    });
  });
});

describe("Theme preference & responsive mobile shell layout", () => {
  it("normalizes dark/light/system theme settings cleanly", () => {
    expect(DEFAULT_SETTINGS.appearance.theme).toBe("dark");
    expect(parseSettingsJson(JSON.stringify({ appearance: { theme: "light" } })).appearance.theme).toBe("light");
    expect(parseSettingsJson(JSON.stringify({ appearance: { theme: "system" } })).appearance.theme).toBe("system");
    expect(
      normalizeSettings({
        ...structuredClone(DEFAULT_SETTINGS),
        appearance: { ...DEFAULT_SETTINGS.appearance, theme: "invalid" as never },
      }).appearance.theme
    ).toBe("dark");
    expect(
      mergeSettings(structuredClone(DEFAULT_SETTINGS), { appearance: { theme: "light" } }).appearance.theme
    ).toBe("light");
  });

  it("activates mobile shell for Android and real phone viewports while leaving desktop audit sizes untouched", () => {
    expect(computeIsMobileLayout(390, 844, false, false)).toBe(true);
    expect(computeIsMobileLayout(1280, 800, false, false)).toBe(false);
    // Desktop Puppeteer audit viewports must remain desktop
    expect(computeIsMobileLayout(460, 160, false, false)).toBe(false);
    expect(computeIsMobileLayout(700, 900, false, false)).toBe(false);
    expect(computeIsMobileLayout(800, 600, false, false)).toBe(false);
    // Android WebView always gets the mobile shell unless miniPlayer is active
    expect(computeIsMobileLayout(900, 600, false, true)).toBe(true);
    expect(computeIsMobileLayout(390, 844, true, true)).toBe(false);
  });
});

describe("Android native audio bridge adapter", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    androidPlaybackClock.reset();
    (globalThis as { window?: unknown }).window = {};
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("detects window.cadence.android synchronously and interpolates remote playback clock", () => {
    expect(isAndroidNativeAudio()).toBe(false);

    const audioAction = vi.fn().mockResolvedValue({});
    (window as unknown as { cadence: Pick<CadenceApi, "android"> }).cadence = {
      android: {
        requestPermissions: vi.fn(),
        systemInfo: vi.fn(),
        audioAction,
      },
    };
    expect(isAndroidNativeAudio()).toBe(true);

    const onPlayback = vi.fn();
    const onTrackTransition = vi.fn();
    const onOpenNowPlaying = vi.fn();
    const unsub = subscribeAndroidAudioEvents({
      onPlayback,
      onTrackTransition,
      onOpenNowPlaying,
    });

    const dispatch = (
      window as unknown as {
        __cadenceAndroidDispatch?: (msg: { event: string; payload: Record<string, unknown> }) => void;
      }
    ).__cadenceAndroidDispatch;
    expect(typeof dispatch).toBe("function");

    dispatch?.({
      event: "playback",
      payload: {
        playing: true,
        buffering: false,
        ended: false,
        position: 12.5,
        duration: 210,
        buffered: 25,
        rate: 1.0,
        volume: 1,
        muted: false,
        trackId: 7,
        index: 0,
      },
    });

    expect(onPlayback).toHaveBeenCalledTimes(1);
    const snap = androidPlaybackClock.getSnapshot();
    expect(snap.isPlaying).toBe(true);
    expect(snap.duration).toBe(210);
    expect(snap.currentTime).toBeGreaterThanOrEqual(12.5);

    dispatch?.({ event: "trackTransition", payload: { index: 1, trackId: 8 } });
    expect(onTrackTransition).toHaveBeenCalledWith(1, 8);

    dispatch?.({ event: "openNowPlaying", payload: {} });
    expect(onOpenNowPlaying).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("forwards preserveCurrent and resolved artwork paths during syncQueueToAndroid", async () => {
    const audioAction = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { cadence: Pick<CadenceApi, "android"> }).cadence = {
      android: {
        requestPermissions: vi.fn(),
        systemInfo: vi.fn(),
        audioAction,
      },
    };

    const artFileUrl = tauriArtworkUrl("/data/user/0/app.cadence.player/artwork", "cover1.jpg", "android");
    const tracks = [
      makeTrack(1, "content://media/external/audio/media/1", {
        artworkUrl: artFileUrl,
      }),
      makeTrack(2, "/storage/emulated/0/Music/song2.mp3", {
        replayGainTrackDb: 0,
      }),
    ];

    const ok = await syncQueueToAndroid({
      tracks,
      startIndex: 0,
      startPositionSec: 42.5,
      autoplay: true,
      preserveCurrent: true,
      playbackSettings: {
        replayGainMode: "track",
        replayGainPreampDb: 0,
        replayGainPreventClipping: true,
      },
    });

    expect(ok).toBe(true);
    expect(audioAction).toHaveBeenCalledWith("syncQueue", {
      items: [
        expect.objectContaining({
          uri: "content://media/external/audio/media/1",
          trackId: 1,
          artworkPath: "/data/user/0/app.cadence.player/artwork/cover1.jpg",
        }),
        expect.objectContaining({
          uri: "/storage/emulated/0/Music/song2.mp3",
          trackId: 2,
          artworkPath: null,
        }),
      ],
      startIndex: 0,
      startPositionSec: 42.5,
      autoplay: true,
      preserveCurrent: true,
    });

    androidSetSystemBarsTheme(true);
    expect(audioAction).toHaveBeenCalledWith("setSystemBars", { light: true });
  });
});

describe("Android build configuration and overlay contracts", () => {
  it("keeps desktop-only Cargo dependencies gated out of Android targets and uses rustls", () => {
    const cargo = readFileSync(resolve(rootDir, "src-tauri/Cargo.toml"), "utf8");
    expect(cargo).toContain("rustls-tls");
    expect(cargo).toContain('target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies');
    expect(cargo).toContain("tauri-plugin-global-shortcut");
    expect(cargo).toContain("tauri-plugin-single-instance");
    expect(cargo).toContain("rfd = ");

    const tauriAndroidConf = JSON.parse(readFileSync(resolve(rootDir, "src-tauri/tauri.android.conf.json"), "utf8"));
    expect(tauriAndroidConf.bundle.android.minSdkVersion).toBe(26);
  });

  it("includes required Kotlin overlay files, Media3 service, ProGuard rules, and CI workflow", () => {
    const required = [
      "scripts/prepare-android-project.mjs",
      ".github/workflows/build-android.yml",
      "src-tauri/android-overlay/app/proguard-cadence.pro",
      "src-tauri/android-overlay/app/src/main/java/app/cadence/player/AndroidContracts.kt",
      "src-tauri/android-overlay/app/src/main/java/app/cadence/player/CadenceStorageHelper.kt",
      "src-tauri/android-overlay/app/src/main/java/app/cadence/player/CadenceMediaService.kt",
      "src-tauri/android-overlay/app/src/main/java/app/cadence/player/CadenceAndroidPlugin.kt",
      "src-tauri/android-overlay/app/src/main/java/app/cadence/player/MainActivity.kt",
      "src-tauri/android-overlay/app/src/test/java/app/cadence/player/AndroidContractsTest.kt",
      "src-tauri/android-overlay/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    ];
    for (const rel of required) {
      expect(existsSync(resolve(rootDir, rel)), `${rel} must exist`).toBe(true);
    }

    const mainActivity = readFileSync(
      resolve(rootDir, "src-tauri/android-overlay/app/src/main/java/app/cadence/player/MainActivity.kt"),
      "utf8"
    );
    expect(mainActivity).toContain("override val handleBackNavigation: Boolean = false");
    expect(mainActivity).toContain("__cadenceHandleAndroidBack");

    const mediaService = readFileSync(
      resolve(rootDir, "src-tauri/android-overlay/app/src/main/java/app/cadence/player/CadenceMediaService.kt"),
      "utf8"
    );
    expect(mediaService).toContain("MediaSessionService");
    expect(mediaService).toContain("ExoPlayer");
    expect(mediaService).toContain("preserveCurrent");
  });
});

describe("Android scanning performance, RangeTokenizer caching, and MediaStore metadata fallback", () => {
  it("keeps the head window pinned in RangeTokenizer across tail seeks", async () => {
    const fileSize = 2 * 1024 * 1024;
    const reads: Array<{ offset: number; length: number }> = [];
    const tokenizer = new RangeTokenizer("content://media/external/audio/media/9", fileSize, async (offset, length) => {
      reads.push({ offset, length });
      const buf = new Uint8Array(length);
      buf[0] = (offset >> 16) & 0xff;
      return buf;
    });

    const headBuf = new Uint8Array(16);
    await tokenizer.readBuffer(headBuf, { position: 0 });
    expect(reads).toHaveLength(1);
    expect(reads[0].length).toBe(256 * 1024);

    // Seek to 4 separate tail offsets to saturate non-zero cache slots
    for (const pos of [600_000, 900_000, 1_200_000, 1_500_000]) {
      await tokenizer.readBuffer(new Uint8Array(16), { position: pos });
    }
    expect(reads).toHaveLength(5);

    // Offset 0 must still be pinned and served with zero additional readChunk IPC calls
    await tokenizer.readBuffer(new Uint8Array(16), { position: 128 });
    expect(reads).toHaveLength(5);
  });

  it("marks extensionless MediaStore content:// URIs playable and uses fallback tags + duration probe", async () => {
    const uri = "content://media/external/audio/media/42";
    expect(resolveEffectiveExtension(uri, "01 - Track.FLAC", "audio/flac")).toBe(".flac");
    expect(resolveEffectiveExtension(uri, undefined, "audio/mp4; codecs=mp4a.40.2")).toBe(".m4a");
    expect(isPlayableExtension(uri, "01 - Track.FLAC", "audio/flac")).toBe(true);
    expect(isPlayableExtension(uri, undefined, "audio/opus")).toBe(true);
    expect(isPlayableExtension(uri, "cover.jpg", "image/jpeg")).toBe(false);

    const probed = vi.fn().mockResolvedValue(212.5);
    const parsed = await readTrackMetadataCore(uri, {
      fileSize: 64,
      mtimeMs: 1000,
      displayName: "01 - Midnight.opus",
      mimeType: "audio/opus",
      fallbackTags: {
        title: "Midnight",
        artist: "Aurora",
        album: "Nocturne",
        albumArtist: "Aurora",
        duration: null,
        trackNo: 1,
        discNo: 2,
        year: 2025,
      },
      skipEofDurationScan: true,
      probeDuration: probed,
      readChunk: async (_offset, length) => new Uint8Array(length),
      saveArtwork: async () => "art.jpg",
      fileExists: () => false,
    });

    expect(parsed.playable).toBe(true);
    expect(parsed.title).toBe("Midnight");
    expect(parsed.artist).toBe("Aurora");
    expect(parsed.album).toBe("Nocturne");
    expect(parsed.trackNo).toBe(1);
    expect(parsed.discNo).toBe(2);
    expect(parsed.year).toBe(2025);
    expect(parsed.duration).toBe(212.5);
    expect(probed).toHaveBeenCalledTimes(1);
  });

  it("streams live scanWalkProgress events and periodic batch refreshes during scanLibraryCore", async () => {
    const originalWindow = globalThis.window;
    (globalThis as { window?: unknown }).window = {};
    try {
      const seenUpdates: number[] = [];
      const unsub = subscribeAndroidScanWalkProgress(seen => seenUpdates.push(seen));
      const dispatch = (
        window as unknown as {
          __cadenceAndroidDispatch?: (msg: { event: string; payload: Record<string, unknown> }) => void;
        }
      ).__cadenceAndroidDispatch;
      dispatch?.({ event: "scanWalkProgress", payload: { filesSeen: 75 } });
      expect(seenUpdates).toEqual([75]);
      unsub();
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }

    const store = new LibraryStoreCore(
      "/tmp/art",
      p => p,
      { engine: "json", writeThrough: false },
      emptyDatabase()
    );
    const files = Array.from({ length: 30 }, (_, idx) => ({
      path: `/storage/emulated/0/Music/track-${idx}.mp3`,
      size: 1000 + idx,
      mtimeMs: 1000,
      hasSidecarLyrics: false,
      animatedArtPath: null,
    }));

    const batchUpdates: number[] = [];
    const result = await scanLibraryCore(
      store,
      {
        folders: ["mediastore://audio"],
        onBatchUpdated: () => batchUpdates.push(store.getTracks().length),
      },
      {
        walkFolders: async (_folders, onFileSeen) => {
          onFileSeen?.(15);
          onFileSeen?.(30);
          return { files, errors: [] };
        },
        parseTrack: async file => ({
          path: file.path,
          title: file.path,
          artist: "Artist",
          albumArtist: "Artist",
          album: "Album",
          genre: "",
          year: 2026,
          trackNo: 1,
          discNo: 1,
          duration: 180,
          bitrate: 320,
          sampleRate: 44100,
          channels: 2,
          codec: "MP3",
          container: "mp3",
          fileSize: file.size,
          mtimeMs: file.mtimeMs,
          artworkFile: null,
          animatedArtPath: null,
          embeddedLyrics: null,
          hasSidecarLyrics: false,
          playable: true,
          replayGainTrackDb: null,
          replayGainAlbumDb: null,
          replayGainTrackPeak: null,
          replayGainAlbumPeak: null,
        }),
      }
    );

    expect(result.added).toBe(30);
    expect(batchUpdates.length).toBeGreaterThanOrEqual(1);
    expect(store.getTracks().length).toBe(30);
  });
});
