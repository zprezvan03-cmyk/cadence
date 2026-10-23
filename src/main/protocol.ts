/**
 * `cadence-media://` — the streaming protocol the renderer uses for local audio, embedded artwork
 * and animated cover videos. Written for Cadence.
 *
 * Chromium will not read `file://` from a renderer under web security, and `<audio>` needs HTTP
 * range requests to seek reliably. This protocol provides both, plus the CORS headers Web Audio
 * needs before `createMediaElementSource` is allowed to expose samples to the analyser.
 */

import { protocol } from "electron";
import {
  MEDIA_SCHEME,
  MediaAllowlist,
  artworkUrl,
  encodePath,
  handleMediaRequest,
  toMediaUrl,
  type PathPlatform,
  type ServeOptions,
} from "./media/protocolHandler";

export { MEDIA_SCHEME, MediaAllowlist, artworkUrl, encodePath, handleMediaRequest, toMediaUrl };
export type { PathPlatform, ServeOptions };

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

export function registerMediaProtocol(options: ServeOptions): void {
  protocol.handle(MEDIA_SCHEME, request => handleMediaRequest(request, options));
}
