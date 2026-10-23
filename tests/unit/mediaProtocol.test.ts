import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const registeredHandlers = new Map<string, (request: Request) => Promise<Response>>();

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
      registeredHandlers.set(scheme, handler);
    }),
  },
}));

import {
  MediaAllowlist,
  isPathInside,
  resolveContainedPath,
} from "../../src/main/media/allowlist";
import { serveFile } from "../../src/main/media/staticFile";
import {
  MEDIA_SCHEME,
  artworkUrl,
  encodePath,
  handleMediaRequest,
  registerMediaProtocol,
  toMediaUrl,
} from "../../src/main/protocol";
import { LibraryController } from "../../src/main/library/controller";

const fixturesDir = resolve(import.meta.dirname, "../../.artifacts/fixtures/formats");
let workDir: string;

beforeAll(() => {
  if (!existsSync(join(fixturesDir, "fixture.flac"))) {
    throw new Error("Audio fixtures are missing. Run: python3 tests/fixtures/generate-audio.py");
  }
  workDir = mkdtempSync(join(tmpdir(), "cadence-protocol-"));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("isPathInside & resolveContainedPath", () => {
  it("allows files and nested directories inside Windows roots", () => {
    expect(isPathInside("C:\\Users\\Alice\\Music", "C:\\Users\\Alice\\Music\\Track.flac", "win32")).toBe(true);
    expect(
      isPathInside("C:\\Users\\Alice\\Music\\", "C:\\Users\\Alice\\Music\\Album\\Disc 1\\01 - Song.mp3", "win32")
    ).toBe(true);
    expect(isPathInside("C:/Users/Alice/Music", "C:\\Users\\Alice\\Music\\Song.ogg", "win32")).toBe(true);
    expect(isPathInside("E:\\", "E:\\Lossless\\Album\\Track.flac", "win32")).toBe(true);
    expect(isPathInside("\\\\NAS\\Music", "\\\\NAS\\Music\\Album\\Track.flac", "win32")).toBe(true);
    expect(
      isPathInside("C:\\Users\\Alice\\Music", "\\\\?\\C:\\Users\\Alice\\Music\\Album\\Track.flac", "win32")
    ).toBe(true);
    // Names starting with ".." inside the directory are valid children, not parent traversals.
    expect(isPathInside("C:\\Users\\Alice\\Music", "C:\\Users\\Alice\\Music\\..hidden\\Track.flac", "win32")).toBe(
      true
    );
  });

  it("handles case differences according to platform semantics (case-insensitive on Windows, case-sensitive on POSIX)", () => {
    expect(
      isPathInside("C:\\Users\\Alice\\Music", "c:\\users\\alice\\music\\Album\\Track.flac", "win32")
    ).toBe(true);
    expect(isPathInside("c:\\users\\alice\\music", "C:\\Users\\Alice\\Music", "win32")).toBe(true);
    expect(isPathInside("C:\\Users\\Jörg\\Musik", "c:\\users\\jörg\\musik\\Lied.flac", "win32")).toBe(true);
    expect(isPathInside("\\\\Server\\Share\\Music", "\\\\server\\share\\music\\Track.flac", "win32")).toBe(true);

    expect(isPathInside("/home/alice/Music", "/home/alice/music/Track.flac", "posix")).toBe(false);
    expect(isPathInside("/home/alice/Music", "/home/alice/Music/Track.flac", "posix")).toBe(true);
  });

  it("rejects sibling-directory prefixes on both Windows and POSIX", () => {
    expect(isPathInside("C:\\Users\\Alice\\Music", "C:\\Users\\Alice\\Music2\\Track.flac", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Alice\\Music", "c:\\users\\alice\\music-backup\\Track.flac", "win32")).toBe(false);
    expect(isPathInside("\\\\NAS\\Music", "\\\\NAS\\MusicArchive\\Track.flac", "win32")).toBe(false);
    expect(
      resolveContainedPath(
        "C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork",
        "C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork2\\cover.png",
        "win32"
      )
    ).toBeNull();

    expect(isPathInside("/home/alice/Music", "/home/alice/Music2/Track.flac", "posix")).toBe(false);
    expect(isPathInside("/home/alice/Music", "/home/alice/Music-extra/Track.flac", "posix")).toBe(false);
    expect(
      resolveContainedPath("/home/alice/.config/Cadence/artwork", "/home/alice/.config/Cadence/artwork2/cover.png", "posix")
    ).toBeNull();
  });

  it("rejects traversal, cross-drive, drive-relative and NUL-byte paths", () => {
    expect(
      isPathInside("C:\\Users\\Alice\\Music", "C:\\Users\\Alice\\Music\\..\\Documents\\secret.txt", "win32")
    ).toBe(false);
    expect(
      isPathInside("C:\\Users\\Alice\\Music", "C:\\Users\\Alice\\Music\\Album\\..\\..\\Music2\\Track.flac", "win32")
    ).toBe(false);
    expect(isPathInside("C:\\Users\\Alice\\Music", "D:\\Users\\Alice\\Music\\Track.flac", "win32")).toBe(false);
    expect(isPathInside("E:\\", "D:\\Track.flac", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Alice\\Music", "C:Track.flac", "win32")).toBe(false);
    expect(isPathInside("\\\\NAS\\Music", "\\\\OtherNAS\\Music\\Track.flac", "win32")).toBe(false);

    expect(
      resolveContainedPath("C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork", "..\\settings.json", "win32")
    ).toBeNull();
    expect(
      resolveContainedPath("C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork", "../settings.json", "win32")
    ).toBeNull();
    expect(
      resolveContainedPath("C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork", "C:..\\settings.json", "win32")
    ).toBeNull();
    expect(
      resolveContainedPath("C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork", "\\Windows\\win.ini", "win32")
    ).toBeNull();

    expect(isPathInside("/home/alice/Music", "/home/alice/Music/../secret.txt", "posix")).toBe(false);
    expect(isPathInside("/home/alice/Music", "/etc/passwd", "posix")).toBe(false);
    expect(resolveContainedPath("/home/alice/.config/Cadence/artwork", "../settings.json", "posix")).toBeNull();
    expect(isPathInside("/home/alice/Music", "/home/alice/Music/Track.flac\0.png", "posix")).toBe(false);
    expect(isPathInside("", "/home/alice/Music/Track.flac", "posix")).toBe(false);
    expect(isPathInside("/home/alice/Music", "", "posix")).toBe(false);
  });

  it("supports POSIX roots, trailing slashes and dot-prefixed child names", () => {
    expect(isPathInside("/home/alice/Music/", "/home/alice/Music/Album/Track.flac", "posix")).toBe(true);
    expect(isPathInside("/", "/var/lib/music/Track.flac", "posix")).toBe(true);
    expect(isPathInside("/home/alice/Music", "/home/alice/Music/..dots/Track.flac", "posix")).toBe(true);
    expect(resolveContainedPath("/home/alice/.config/Cadence/artwork", "abc123.png", "posix")).toBe(
      "/home/alice/.config/Cadence/artwork/abc123.png"
    );
  });
});

describe("MediaAllowlist", () => {
  it("deduplicates and removes Windows roots case-insensitively", () => {
    const allowlist = new MediaAllowlist("win32");
    allowlist.addRoot("C:\\Users\\Alice\\Music\\");
    allowlist.addRoot("c:/users/alice/music");
    expect(allowlist.getRoots()).toHaveLength(1);
    expect(allowlist.allows("D:\\Music\\Track.flac")).toBe(false);
    expect(allowlist.allows("c:\\users\\alice\\music\\Album\\Track.flac")).toBe(true);

    allowlist.removeRoot("C:\\USERS\\ALICE\\MUSIC");
    expect(allowlist.allows("C:\\Users\\Alice\\Music\\Album\\Track.flac")).toBe(false);
  });

  it("keeps POSIX roots case-sensitive", () => {
    const allowlist = new MediaAllowlist("posix");
    allowlist.addRoot("/home/alice/Music");
    expect(allowlist.allows("/home/alice/Music/Album/Track.flac")).toBe(true);
    expect(allowlist.allows("/home/alice/music/Album/Track.flac")).toBe(false);
    expect(allowlist.allows("/home/alice/Music2/Track.flac")).toBe(false);
  });
});

describe("cadence-media:// protocol handler", () => {
  it("serves permitted Windows audio and artwork requests without 403 and blocks escapes", async () => {
    const winMusicRoot = "C:\\Users\\Alice\\Music";
    const winArtworkRoot = "C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork";
    const winFlacPath = "C:\\Users\\Alice\\Music\\Test Bench\\fixture.flac";
    const winCoverPath = "C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork\\cover.png";

    const realFlac = join(fixturesDir, "fixture.flac");
    const realCover = join(fixturesDir, "cover.png");

    const allowlist = new MediaAllowlist("win32");
    allowlist.addRoot(winArtworkRoot);
    allowlist.addRoot(winMusicRoot);

    registerMediaProtocol({
      allowlist,
      artworkDirectory: winArtworkRoot,
      platform: "win32",
      serve: async (resolvedPath, req) => {
        if (resolvedPath.toLowerCase() === winFlacPath.toLowerCase()) return serveFile(realFlac, req);
        if (resolvedPath.toLowerCase() === winCoverPath.toLowerCase()) return serveFile(realCover, req);
        return new Response("Not found", { status: 404 });
      },
    });

    const handler = registeredHandlers.get(MEDIA_SCHEME)!;
    expect(handler).toBeTypeOf("function");

    // 1. Permitted Windows audio request (full + HTTP Range) + case difference
    const audioRes = await handler(new Request(toMediaUrl(winFlacPath, "file", "win32")));
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get("Content-Type")).toBe("audio/flac");

    const rangeRes = await handler(
      new Request(toMediaUrl("c:\\users\\alice\\music\\test bench\\fixture.flac", "file", "win32"), {
        headers: { Range: "bytes=0-3" },
      })
    );
    expect(rangeRes.status).toBe(206);
    expect(Buffer.from(await rangeRes.arrayBuffer()).toString("ascii")).toBe("fLaC");

    // 2. Permitted Windows artwork requests (full path via toMediaUrl, artworkUrl helper, relative filename, case diff)
    for (const url of [
      toMediaUrl(winCoverPath, "art", "win32"),
      artworkUrl(winArtworkRoot, "cover.png", "win32"),
      `${MEDIA_SCHEME}://art/${encodePath("cover.png")}`,
      toMediaUrl("c:\\users\\alice\\appdata\\roaming\\cadence\\artwork\\cover.png", "art", "win32"),
    ]) {
      const artRes = await handler(new Request(url));
      expect(artRes.status).toBe(200);
      expect(artRes.headers.get("Content-Type")).toBe("image/png");
      const bytes = Buffer.from(await artRes.arrayBuffer());
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }

    // 3. Forbidden Windows sibling-prefix, traversal, drive-relative, and cross-drive requests -> 403
    for (const forbiddenUrl of [
      toMediaUrl("C:\\Users\\Alice\\Music2\\fixture.flac", "file", "win32"),
      `${MEDIA_SCHEME}://file/${encodePath("C:\\Users\\Alice\\Music\\..\\Secret\\fixture.flac")}`,
      `${MEDIA_SCHEME}://file/${encodePath("D:\\Users\\Alice\\Music\\fixture.flac")}`,
      `${MEDIA_SCHEME}://file/${encodePath("C:fixture.flac")}`,
      `${MEDIA_SCHEME}://art/${encodePath("..\\settings.json")}`,
      `${MEDIA_SCHEME}://art/${encodePath("../settings.json")}`,
      `${MEDIA_SCHEME}://art/${encodePath("C:\\Users\\Alice\\AppData\\Roaming\\Cadence\\artwork2\\cover.png")}`,
      `${MEDIA_SCHEME}://art/${encodePath("C:..\\settings.json")}`,
    ]) {
      const res = await handler(new Request(forbiddenUrl));
      expect(res.status).toBe(403);
    }

    // 4. Missing file inside permitted Windows folder -> 404 (not 403)
    const missingRes = await handler(
      new Request(toMediaUrl("C:\\Users\\Alice\\Music\\missing-track.flac", "file", "win32"))
    );
    expect(missingRes.status).toBe(404);
  });

  it("serves real scanned library audio and extracted artwork over POSIX paths and revokes removed folders", async () => {
    const musicFolder = join(workDir, "music");
    const siblingFolder = join(workDir, "music-extra");
    const artworkDir = join(workDir, "artwork");
    mkdirSync(musicFolder, { recursive: true });
    mkdirSync(siblingFolder, { recursive: true });
    cpSync(join(fixturesDir, "fixture.flac"), join(musicFolder, "fixture.flac"));
    cpSync(join(fixturesDir, "fixture.mp3"), join(siblingFolder, "fixture.mp3"));
    writeFileSync(join(workDir, "settings.json"), '{"secret":true}');

    const allowlist = new MediaAllowlist();
    const controller = new LibraryController(
      { dbPath: join(workDir, "library.db"), artworkDirectory: artworkDir },
      allowlist,
      (path, isArtwork) => toMediaUrl(path, isArtwork ? "art" : "file")
    );

    await controller.addFolder(musicFolder);
    const snapshot = controller.snapshot();
    expect(snapshot.tracks).toHaveLength(1);
    const track = snapshot.tracks[0];
    expect(track.artworkUrl).toBeTruthy();

    const options = { allowlist, artworkDirectory: controller.artworkDirectory };

    // Audio stream (GET + HEAD + Range) succeeds with 200/206
    const headRes = await handleMediaRequest(new Request(track.streamUrl, { method: "HEAD" }), options);
    expect(headRes.status).toBe(200);
    expect(Number(headRes.headers.get("Content-Length"))).toBeGreaterThan(1000);

    const streamRes = await handleMediaRequest(
      new Request(track.streamUrl, { headers: { Range: "bytes=0-3" } }),
      options
    );
    expect(streamRes.status).toBe(206);
    expect(Buffer.from(await streamRes.arrayBuffer()).toString("ascii")).toBe("fLaC");

    // Extracted artwork succeeds with 200
    const artRes = await handleMediaRequest(new Request(track.artworkUrl!), options);
    expect(artRes.status).toBe(200);
    expect(artRes.headers.get("Content-Type")).toBe("image/png");

    // Sibling prefix and parent traversal receive 403
    const siblingRes = await handleMediaRequest(
      new Request(toMediaUrl(join(siblingFolder, "fixture.mp3"), "file")),
      options
    );
    expect(siblingRes.status).toBe(403);

    const traversalArtRes = await handleMediaRequest(
      new Request(`${MEDIA_SCHEME}://art/${encodePath("../settings.json")}`),
      options
    );
    expect(traversalArtRes.status).toBe(403);

    // Removing the music folder revokes audio access (403) while keeping cached artwork readable
    await controller.removeFolder(musicFolder);
    const afterRemoveAudio = await handleMediaRequest(new Request(track.streamUrl), options);
    expect(afterRemoveAudio.status).toBe(403);
    const afterRemoveArt = await handleMediaRequest(new Request(track.artworkUrl!), options);
    expect(afterRemoveArt.status).toBe(200);

    controller.close();
  });
});
