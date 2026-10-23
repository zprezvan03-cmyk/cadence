/**
 * Cadence lyrics service: provider orchestration and fallback.
 *
 * Provider ordering follows the upstream Better Lyrics model (local/Better Lyrics first, plain
 * text last) and reuses `mergePreferredProviders` from the extension so a persisted order that
 * predates a new provider still migrates the same way. Written for Cadence around ported pieces.
 */

import type { LibraryStore } from "../library/store";
import type { LyricsCandidate, LyricsResolveRequest, LyricsResolveResult } from "../../shared/types";
import {
  DEFAULT_PROVIDER_ORDER,
  type LyricSourceKey,
} from "../../shared/upstream/better-lyrics/constants";
import { mergePreferredProviders } from "../../shared/upstream/better-lyrics/providerList";
import { LyricsCache } from "./cache";
import { fetchLrclib } from "./lrclib";
import { readEmbeddedLyrics, readLyricsFile, readLyricsFolder, readSidecarLyrics } from "./localLyrics";

export class LyricsService {
  constructor(
    private readonly store: LibraryStore,
    private readonly cache: LyricsCache
  ) {}

  private orderFor(providerOrder: string[] | undefined): LyricSourceKey[] {
    const merged = mergePreferredProviders(providerOrder?.length ? providerOrder : DEFAULT_PROVIDER_ORDER, DEFAULT_PROVIDER_ORDER);
    const valid = merged.filter((key): key is LyricSourceKey =>
      (DEFAULT_PROVIDER_ORDER as string[]).includes(key)
    );
    return valid.length ? valid : (DEFAULT_PROVIDER_ORDER as LyricSourceKey[]);
  }

  async resolve(
    request: LyricsResolveRequest,
    providerOrder?: string[],
    signal?: AbortSignal
  ): Promise<LyricsResolveResult> {
    const order = this.orderFor(providerOrder);
    const candidates: LyricsCandidate[] = [];
    const providerStatus: LyricsResolveResult["providerStatus"] = [];
    const track = this.store.getTrack(request.trackId);
    const trackPath = track?.path ?? null;

    const pushLocal = (candidate: LyricsCandidate | null, provider: string, label: string) => {
      if (!candidate) {
        providerStatus.push({ provider, status: "miss" });
        return;
      }
      candidates.push(candidate);
      providerStatus.push({ provider, status: "hit", detail: label });
    };

    if (trackPath && order.includes("local-sidecar")) {
      const sidecar =
        (await readSidecarLyrics(trackPath)) ??
        (await readLyricsFolder(trackPath, track?.trackNo ?? null, track?.title ?? request.title));
      pushLocal(
        sidecar
          ? {
              source: "local-sidecar",
              provider: "Local file",
              text: sidecar.text,
              syncHint: sidecar.format === "ttml" || sidecar.format === "qrc" ? "richsync" : "synced",
              language: null,
              songwriters: [],
              sourceHref: sidecar.path,
              cached: true,
            }
          : null,
        "local-sidecar",
        sidecar?.path ?? ""
      );
    }

    if (order.includes("embedded-tag")) {
      const embedded = readEmbeddedLyrics(this.store, request.trackId);
      pushLocal(
        embedded
          ? {
              source: "embedded-tag",
              provider: "Embedded tag",
              text: embedded.text,
              syncHint: embedded.kind === "lrc" ? "synced" : "none",
              language: null,
              songwriters: [],
              sourceHref: trackPath,
              cached: true,
            }
          : null,
        "embedded-tag",
        "USLT/SYLT tag"
      );
    }

    const networkProviders = order.includes("lrclib-synced") || order.includes("lrclib-plain");
    const wantsNetwork = !request.localOnly && networkProviders;
    const cacheKey = LyricsCache.key(request.artist, request.title, request.album, request.duration);

    if (wantsNetwork) {
      const cached = this.cache.get(cacheKey);
      if (cached !== null) {
        if (cached.length > 0) {
          for (const candidate of cached) {
            if (order.includes(candidate.source as LyricSourceKey)) candidates.push(candidate);
          }
          providerStatus.push({ provider: "lrclib", status: "hit", detail: "Cached lyrics" });
        } else {
          providerStatus.push({ provider: "lrclib", status: "miss", detail: "Cached negative result" });
        }
      } else {
        try {
          const result = await fetchLrclib(
            {
              title: request.title,
              artist: request.artist,
              album: request.album,
              duration: request.duration,
            },
            signal
          );
          const wanted = result.candidates.filter(candidate => order.includes(candidate.source as LyricSourceKey));
          candidates.push(...wanted);
          providerStatus.push(...result.status);
          this.cache.set(cacheKey, wanted);
        } catch (error) {
          if ((error as Error).name === "AbortError") throw error;
          providerStatus.push({ provider: "lrclib", status: "error", detail: (error as Error).message });
        }
      }
    } else {
      providerStatus.push({
        provider: "lrclib",
        status: "skipped",
        detail: request.localOnly ? "Offline mode" : "Provider disabled",
      });
    }

    // Stable order: local sources before network ones, matching upstream priority.
    const orderIndex = (source: string): number => (DEFAULT_PROVIDER_ORDER as string[]).indexOf(source);
    candidates.sort((a, b) => orderIndex(a.source) - orderIndex(b.source));

    return { candidates, providerStatus };
  }

  async resolveUserFile(trackId: number, path: string): Promise<LyricsResolveResult> {
    const file = await readLyricsFile(path);
    if (!file) return { candidates: [], providerStatus: [{ provider: "user-file", status: "error", detail: "Unreadable file" }] };
    const track = this.store.getTrack(trackId);
    return {
      candidates: [
        {
          source: "user-file",
          provider: "Chosen file",
          text: file.text,
          syncHint: file.format === "ttml" || file.format === "qrc" ? "richsync" : "synced",
          language: null,
          songwriters: [],
          sourceHref: file.path,
          cached: true,
        },
      ],
      providerStatus: [{ provider: "user-file", status: "hit", detail: track?.title ?? file.path }],
    };
  }

  flush(): void {
    this.cache.flush();
  }
}
