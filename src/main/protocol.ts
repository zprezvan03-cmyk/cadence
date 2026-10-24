/**
 * `cadence-media` — the streaming protocol the renderer uses for local audio, embedded artwork
 * and animated cover videos. Written for Cadence.
 *
 * WebView2 / Chromium will not read `file://` from a renderer under web security, and `<audio>`
 * needs HTTP range requests to seek reliably. In production Tauri serves this scheme natively in
 * Rust (`src-tauri/src/protocol.rs`); this Node-backed helper provides the identical handler for
 * Node/Vitest integration tests.
 */

import {
  MEDIA_SCHEME,
  MediaAllowlist,
  artworkUrl,
  decodePath,
  encodePath,
  handleMediaRequest as handleMediaRequestCore,
  parseMediaUrl,
  tauriArtworkUrl,
  toMediaUrl,
  toTauriMediaUrl,
  type PathPlatform,
  type ServeOptions as CoreServeOptions,
} from "./media/protocolHandler";
import { serveFile } from "./media/staticFile";

export {
  MEDIA_SCHEME,
  MediaAllowlist,
  artworkUrl,
  decodePath,
  encodePath,
  parseMediaUrl,
  tauriArtworkUrl,
  toMediaUrl,
  toTauriMediaUrl,
};
export type { PathPlatform };

export interface ServeOptions extends Omit<CoreServeOptions, "serve"> {
  serve?: (path: string, request: Request) => Promise<Response>;
}

export function handleMediaRequest(request: Request, options: ServeOptions): Promise<Response> {
  return handleMediaRequestCore(request, {
    ...options,
    serve: options.serve ?? serveFile,
  });
}

export type ProtocolRegistrar = (
  scheme: string,
  handler: (request: Request) => Promise<Response>
) => void;

export function registerMediaProtocol(options: ServeOptions, register?: ProtocolRegistrar): (request: Request) => Promise<Response> {
  const handler = (request: Request) => handleMediaRequest(request, options);
  register?.(MEDIA_SCHEME, handler);
  return handler;
}
