import { useEffect, useMemo, useState } from "react";
import { trackSourceKey } from "../../../shared/media";
import type { MediaItem } from "../../../shared/types";
import { MOTION_DURATION_MS } from "../../app/motion";
import { useDissolve, type VisualLayer } from "../../app/useDissolve";
import { useReducedMotion } from "../../app/useMotionPreference";
import { artworkAccentFromPixels, isCrossOriginRemoteArtwork, measureArtworkAccent } from "../../upstream/shaders/artworkBrightness";

export interface Cover {
  src: string | null;
  accent: string | null;
}

const NO_COVER: VisualLayer<Cover> = { key: "", value: { src: null, accent: null } };
const NO_ITEM: VisualLayer<MediaItem | null> = { key: "", value: null };
const COVER_CACHE_SIZE = 32;
const TEXT_WAIT_MS = 110;
// Cache readiness and a tiny colour sample, not decoded bitmaps. The browser owns the image
// cache (Cadence's content-hashed artwork is immutable). Player surfaces share pending decodes.
const ready = new Map<string, Cover>();
const pending = new Map<string, Promise<Cover>>();

function sampleAccent(image: HTMLImageElement): string | null {
  if (isCrossOriginRemoteArtwork(image.src)) return null;
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, size, size);
    return artworkAccentFromPixels(ctx.getImageData(0, 0, size, size).data);
  } catch {
    return null; // A webview/media protocol may allow displaying an image but not sampling it.
  }
}

function prepareCover(src: string): Promise<Cover> {
  const existing = pending.get(src);
  if (existing) return existing;
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  const request = image.decode().then(
    async (): Promise<Cover> => {
      // Tauri's immutable media scheme may taint a normal <img> in the desktop webview.
      // Its own protocol supports CORS, so use the existing small-bitmap sampler as a fallback.
      const native = /^(cadence-media:|https?:\/\/cadence-media\.localhost\/)/.test(src);
      const accent = sampleAccent(image) ?? (native ? await measureArtworkAccent(src) : null);
      const cover = { src, accent };
      ready.set(src, cover);
      if (ready.size > COVER_CACHE_SIZE) ready.delete(ready.keys().next().value!);
      return cover;
    },
    (): Cover => NO_COVER.value // Don't cache a failed URL forever, e.g. after a library repair.
  ).finally(() => pending.delete(src));
  pending.set(src, request);
  return request;
}

function useCoverAsset(src: string): Cover | undefined {
  const [resolved, setResolved] = useState<{ src: string; cover: Cover } | null>(null);
  const cover = !src ? NO_COVER.value : ready.get(src) ?? (resolved?.src === src ? resolved.cover : undefined);
  useEffect(() => {
    if (!src || cover) return;
    let current = true;
    void prepareCover(src).then(cover => { if (current) setResolved({ src, cover }); });
    return () => { current = false; };
  }, [src, cover]);
  return cover;
}

/** Art and text start together when decoded. If artwork is slow, text catches up on its own;
 * only the outgoing visual is retained, never the actual player/lyrics identity. */
export function usePlaybackPresentation(item: MediaItem | null, storedAccent?: string | null) {
  const reduced = useReducedMotion();
  const animate = !reduced && !document.hidden;
  const src = item?.artworkUrl ?? "";
  const asset = useCoverAsset(src);
  const coverTarget = useMemo<VisualLayer<Cover> | null>(() => asset ? {
    key: src,
    value: { src: asset.src, accent: asset.src ? storedAccent ?? asset.accent : null },
  } : null, [src, asset, storedAccent]);
  const cover = useDissolve(coverTarget, NO_COVER, MOTION_DURATION_MS.layout, animate);

  const key = item ? trackSourceKey(item.source) : "";
  const textTarget = useMemo(() => ({ key, value: item }), [key, item]);
  const [released, setReleased] = useState<VisualLayer<MediaItem | null> | null>(null);
  const waitForCover = Boolean(animate && cover.front.key !== src && released?.key !== key);
  useEffect(() => {
    if (!waitForCover) return;
    const timer = window.setTimeout(() => setReleased(textTarget), TEXT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waitForCover, textTarget]);
  const text = useDissolve(waitForCover ? null : textTarget, textTarget, MOTION_DURATION_MS.view, animate);
  return { cover, text };
}
