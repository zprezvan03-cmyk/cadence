/** Resolve a metadata-identified ALAC track to the native lossless PCM bridge. */

import { isAlacCodec } from "./codecs";

export interface PlaybackSourceTrack {
  path?: string;
  streamUrl: string;
  codec?: string | null;
}

export type AlacSourcePreparer = (path: string) => Promise<string>;

function nativeAlacPreparer(): AlacSourcePreparer | undefined {
  if (typeof window === "undefined") return undefined;
  const prepare = window.cadence?.player?.prepareAlacSource;
  return typeof prepare === "function" ? prepare.bind(window.cadence.player) : undefined;
}

/**
 * Only the codec reported by the container metadata selects the ALAC decoder; `.m4a` alone is
 * deliberately insufficient because AAC commonly uses the same extension.
 */
export async function resolvePlaybackSource(
  track: PlaybackSourceTrack,
  prepareAlacSource: AlacSourcePreparer | undefined = nativeAlacPreparer()
): Promise<string> {
  if (!isAlacCodec(track.codec)) return track.streamUrl;
  if (!track.path) throw new Error("The ALAC track has no source path.");
  if (!prepareAlacSource) throw new Error("The native ALAC decoder is not available in this runtime.");
  return prepareAlacSource(track.path);
}
