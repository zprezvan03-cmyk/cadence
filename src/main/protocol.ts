/**
 * `cadence-media://` — the streaming protocol the renderer uses for local audio, embedded artwork
 * and animated cover videos. Written for Cadence.
 *
 * Chromium will not read `file://` from a renderer under web security, and `<audio>` needs HTTP
 * range requests to seek reliably. This protocol provides both, plus the CORS headers Web Audio
 * needs before `createMediaElementSource` is allowed to expose samples to the analyser.
 */

import { join, resolve } from "node:path";
import { protocol } from "electron";
import { MediaAllowlist } from "./media/allowlist";
import { CORS_HEADERS, serveFile } from "./media/staticFile";

export const MEDIA_SCHEME = "cadence-media";

export { MediaAllowlist };

/** Must run before `app.whenReady()`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

export function encodePath(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

export function toMediaUrl(path: string, kind: "file" | "art" = "file"): string {
  return `${MEDIA_SCHEME}://${kind}/${encodePath(resolve(path))}`;
}

interface ServeOptions {
  allowlist: MediaAllowlist;
  artworkDirectory: string;
}

export function registerMediaProtocol(options: ServeOptions): void {
  protocol.handle(MEDIA_SCHEME, async request => {
    try {
      const url = new URL(request.url);
      const decoded = Buffer.from(url.pathname.replace(/^\//, ""), "base64url").toString("utf8");
      if (!decoded) return new Response("Bad request", { status: 400, headers: CORS_HEADERS });

      if (url.host === "art") {
        const artworkRoot = resolve(options.artworkDirectory);
        const artworkPath = resolve(artworkRoot, decoded);
        if (artworkPath !== artworkRoot && !artworkPath.startsWith(artworkRoot + "/")) {
          return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
        }
        return await serveFile(artworkPath, request);
      }

      if (url.host === "file") {
        if (!options.allowlist.allows(decoded)) {
          return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
        }
        return await serveFile(decoded, request);
      }

      return new Response("Unknown media host", { status: 404, headers: CORS_HEADERS });
    } catch (error) {
      console.error("[Cadence] media protocol error:", error);
      return new Response("Server error", { status: 500, headers: CORS_HEADERS });
    }
  });
}

export function artworkUrl(artworkDirectory: string, fileName: string): string {
  return `${MEDIA_SCHEME}://art/${Buffer.from(join(artworkDirectory, fileName), "utf8").toString("base64url")}`;
}
