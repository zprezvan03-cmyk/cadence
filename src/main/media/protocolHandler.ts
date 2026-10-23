/**
 * Pure `cadence-media://` URL helpers and request handler, kept free of Electron imports so unit
 * and integration tests can exercise the exact audio and artwork containment logic directly.
 * Written for Cadence.
 */

import { win32 } from "node:path";
import {
  MediaAllowlist,
  resolveContainedPath,
  resolvePathApi,
  stripWindowsDevicePrefix,
  type PathPlatform,
} from "./allowlist";
import { CORS_HEADERS, serveFile } from "./staticFile";

export const MEDIA_SCHEME = "cadence-media";

export { MediaAllowlist };
export type { PathPlatform };

export function encodePath(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

export function toMediaUrl(path: string, kind: "file" | "art" = "file", platform?: PathPlatform): string {
  const pathApi = resolvePathApi(platform, path);
  const normalized = pathApi === win32 ? pathApi.resolve(stripWindowsDevicePrefix(path)) : pathApi.resolve(path);
  return `${MEDIA_SCHEME}://${kind}/${encodePath(normalized)}`;
}

export function artworkUrl(artworkDirectory: string, fileName: string, platform?: PathPlatform): string {
  const pathApi = resolvePathApi(platform, artworkDirectory);
  return `${MEDIA_SCHEME}://art/${encodePath(pathApi.join(artworkDirectory, fileName))}`;
}

export interface ServeOptions {
  allowlist: MediaAllowlist;
  artworkDirectory: string;
  platform?: PathPlatform;
  serve?: (path: string, request: Request) => Promise<Response>;
}

export async function handleMediaRequest(request: Request, options: ServeOptions): Promise<Response> {
  try {
    const url = new URL(request.url);
    const encoded = url.pathname.replace(/^\/+/, "");
    if (!encoded) return new Response("Bad request", { status: 400, headers: CORS_HEADERS });
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (!decoded) return new Response("Bad request", { status: 400, headers: CORS_HEADERS });

    const serve = options.serve ?? serveFile;

    if (url.host === "art") {
      const artworkPath = resolveContainedPath(options.artworkDirectory, decoded, options.platform);
      if (!artworkPath) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }
      return await serve(artworkPath, request);
    }

    if (url.host === "file") {
      const allowedPath = options.allowlist.resolveAllowedPath(decoded);
      if (!allowedPath) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }
      return await serve(allowedPath, request);
    }

    return new Response("Unknown media host", { status: 404, headers: CORS_HEADERS });
  } catch (error) {
    console.error("[Cadence] media protocol error:", error);
    return new Response("Server error", { status: 500, headers: CORS_HEADERS });
  }
}
