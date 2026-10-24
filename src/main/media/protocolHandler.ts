/**
 * Pure `cadence-media` URL helpers and request handler, kept free of desktop-runtime and Node
 * imports so WebView2, unit tests and integration harnesses all exercise the exact same audio and
 * artwork containment logic. Written for Cadence.
 */

import {
  MediaAllowlist,
  detectRuntimePlatform,
  resolveContainedPath,
  resolvePathApi,
  stripWindowsDevicePrefix,
  win32Path,
  type PathPlatform,
} from "./allowlist";

export const MEDIA_SCHEME = "cadence-media";

export const MEDIA_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

export { MediaAllowlist };
export type { PathPlatform };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

export function encodePath(path: string): string {
  const bytes = utf8Encoder.encode(path);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodePath(encoded: string): string | null {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function toMediaUrl(path: string, kind: "file" | "art" = "file", platform?: PathPlatform): string {
  const pathApi = resolvePathApi(platform, path);
  const normalized = pathApi === win32Path ? pathApi.resolve(stripWindowsDevicePrefix(path)) : pathApi.resolve(path);
  return `${MEDIA_SCHEME}://${kind}/${encodePath(normalized)}`;
}

/**
 * Formats a `cadence-media` URL for Tauri's URI scheme router:
 * - Windows WebView2 maps custom protocols to `http://<scheme>.localhost/<path>`
 * - macOS / Linux map custom protocols to `<scheme>://localhost/<path>`
 */
export function toTauriMediaUrl(
  path: string,
  kind: "file" | "art" = "file",
  platform: PathPlatform = detectRuntimePlatform()
): string {
  const pathApi = resolvePathApi(platform, path);
  const normalized = pathApi === win32Path ? pathApi.resolve(stripWindowsDevicePrefix(path)) : pathApi.resolve(path);
  const encoded = encodePath(normalized);
  if (platform === "win32") {
    return `http://${MEDIA_SCHEME}.localhost/${kind}/${encoded}`;
  }
  return `${MEDIA_SCHEME}://localhost/${kind}/${encoded}`;
}

export function artworkUrl(artworkDirectory: string, fileName: string, platform?: PathPlatform): string {
  const pathApi = resolvePathApi(platform, artworkDirectory);
  return `${MEDIA_SCHEME}://art/${encodePath(pathApi.join(artworkDirectory, fileName))}`;
}

export function tauriArtworkUrl(
  artworkDirectory: string,
  fileName: string,
  platform: PathPlatform = detectRuntimePlatform()
): string {
  const pathApi = resolvePathApi(platform, artworkDirectory);
  return toTauriMediaUrl(pathApi.join(artworkDirectory, fileName), "art", platform);
}

/**
 * Infers an image MIME type from a `cadence-media` artwork URL (decoding the base64url filename
 * when needed) so OS media sessions (`navigator.mediaSession` / Windows SMTC) receive the exact
 * artwork format (`image/png`, `image/webp`, `image/gif`, `image/bmp`, or `image/jpeg`).
 */
export function inferArtworkMimeType(artworkUrl: string): string {
  try {
    const parsed = new URL(artworkUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const tail = segments[segments.length - 1] ?? "";
    const decoded = (decodePath(tail) ?? parsed.pathname).toLowerCase();
    if (decoded.endsWith(".png")) return "image/png";
    if (decoded.endsWith(".webp")) return "image/webp";
    if (decoded.endsWith(".gif")) return "image/gif";
    if (decoded.endsWith(".bmp")) return "image/bmp";
  } catch {
    /* fall through */
  }
  return "image/jpeg";
}

/**
 * Parses both host-routed (`cadence-media://file/<b64>`) and Tauri path-routed
 * (`http://cadence-media.localhost/file/<b64>`, `cadence-media://localhost/file/<b64>`) media URLs.
 */
export function parseMediaUrl(rawUrl: string): { kind: "file" | "art"; decodedPath: string } | { error: "bad-request" | "not-found" } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "bad-request" };
  }

  let kind: string = url.host.toLowerCase();
  let rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");

  if (kind === "localhost" || kind === `${MEDIA_SCHEME}.localhost`) {
    const slash = rawPath.indexOf("/");
    if (slash === -1) return { error: "bad-request" };
    kind = rawPath.slice(0, slash).toLowerCase();
    rawPath = rawPath.slice(slash + 1).replace(/^\/+/, "");
  }

  if (kind !== "file" && kind !== "art") {
    return { error: "not-found" };
  }
  if (!rawPath) return { error: "bad-request" };
  const decodedPath = decodePath(rawPath);
  if (!decodedPath) return { error: "bad-request" };

  return { kind, decodedPath };
}

export interface ServeOptions {
  allowlist: MediaAllowlist;
  artworkDirectory: string;
  platform?: PathPlatform;
  serve: (path: string, request: Request) => Promise<Response>;
}

export async function handleMediaRequest(request: Request, options: ServeOptions): Promise<Response> {
  try {
    const parsed = parseMediaUrl(request.url);
    if ("error" in parsed) {
      return parsed.error === "not-found"
        ? new Response("Unknown media host", { status: 404, headers: MEDIA_CORS_HEADERS })
        : new Response("Bad request", { status: 400, headers: MEDIA_CORS_HEADERS });
    }

    if (parsed.kind === "art") {
      const artworkPath = resolveContainedPath(options.artworkDirectory, parsed.decodedPath, options.platform);
      if (!artworkPath) {
        return new Response("Forbidden", { status: 403, headers: MEDIA_CORS_HEADERS });
      }
      return await options.serve(artworkPath, request);
    }

    const allowedPath = options.allowlist.resolveAllowedPath(parsed.decodedPath);
    if (!allowedPath) {
      return new Response("Forbidden", { status: 403, headers: MEDIA_CORS_HEADERS });
    }
    return await options.serve(allowedPath, request);
  } catch (error) {
    console.error("[Cadence] media protocol error:", error);
    return new Response("Server error", { status: 500, headers: MEDIA_CORS_HEADERS });
  }
}
