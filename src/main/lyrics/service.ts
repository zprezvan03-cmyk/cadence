/**
 * Cadence lyrics service (Node filesystem adapter over `LyricsServiceCore`).
 */

import type { LibraryStoreCore } from "../library/storeCore";
import type { LyricsCacheCore } from "./cacheCore";
import { nodeLocalLyricsReader } from "./localLyrics";
import { LyricsServiceCore } from "./serviceCore";

export class LyricsService extends LyricsServiceCore {
  constructor(store: LibraryStoreCore, cache: LyricsCacheCore) {
    super(store, cache, nodeLocalLyricsReader);
  }
}
