/** Resolve a metadata-identified ALAC track to the native lossless PCM bridge. */

import { isAlacCodec } from "./codecs";

export interface PlaybackSourceTrack {
  path?: string;
  streamUrl: string;
  codec?: string | null;
}

export type AlacSourcePreparer = (path: string) => Promise<string>;

/**
 * A native ALAC preparation decodes the whole file, and the bridge has no way to cancel or join
 * one: two calls that arrive before the first finishes both start their own full decode. A double
 * click, a queue change or a decode scan can all ask for the same file at once, so identical
 * concurrent requests share one call here. Entries only live while the call is in flight, so a file
 * replaced on disk is still re-decoded on the next request.
 */
const inFlightPreparations = new WeakMap<AlacSourcePreparer, Map<string, Promise<string>>>();

function prepareOnce(prepareAlacSource: AlacSourcePreparer, path: string): Promise<string> {
  let pending = inFlightPreparations.get(prepareAlacSource);
  if (!pending) {
    pending = new Map();
    inFlightPreparations.set(prepareAlacSource, pending);
  }
  const key = path;
  const existing = pending.get(key);
  if (existing) return existing;
  const shared = prepareAlacSource(path).finally(() => {
    if (pending.get(key) === shared) pending.delete(key);
  });
  pending.set(key, shared);
  return shared;
}

/**
 * The bound bridge method is cached: `resolvePlaybackSource` runs on every load, and a fresh
 * `prepare.bind(...)` object every time would defeat the in-flight sharing below (and allocate).
 */
let cachedPreparer: AlacSourcePreparer | undefined;
let cachedPreparerSource: unknown;

function nativeAlacPreparer(): AlacSourcePreparer | undefined {
  if (typeof window === "undefined") return undefined;
  const prepare = window.cadence?.player?.prepareAlacSource;
  if (typeof prepare !== "function") return undefined;
  if (prepare !== cachedPreparerSource) {
    cachedPreparerSource = prepare;
    cachedPreparer = prepare.bind(window.cadence.player);
  }
  return cachedPreparer;
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
  return prepareOnce(prepareAlacSource, track.path);
}
