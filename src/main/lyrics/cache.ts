/**
 * Persistent lyrics cache for Cadence (Node filesystem adapter over `LyricsCacheCore`), so a song
 * played offline still has the lyrics that were fetched while online. Written for Cadence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LyricsCacheCore } from "./cacheCore";

export class LyricsCache extends LyricsCacheCore {
  constructor(filePath: string) {
    let initialJson: string | null = null;
    if (existsSync(filePath)) {
      try {
        initialJson = readFileSync(filePath, "utf8");
      } catch {
        initialJson = null;
      }
    }
    super({
      initialJson,
      persist: json => {
        mkdirSync(dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp`;
        writeFileSync(temporary, json);
        renameSync(temporary, filePath);
      },
    });
  }
}
