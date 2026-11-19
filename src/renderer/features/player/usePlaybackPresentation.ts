import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { trackSourceKey } from "../../../shared/media";
import type { MediaItem } from "../../../shared/types";
import { MOTION_DURATION_MS } from "../../app/motion";
import { useDissolve, type VisualLayer } from "../../app/useDissolve";
import { useReducedMotion } from "../../app/useMotionPreference";

export interface Cover { src: string | null; label: string }
const EMPTY: VisualLayer<Cover> = { key: "", value: { src: null, label: "" } };
const READY_LIMIT = 32;
// The renderer mounts only one visible playback-art slot at a time. Preserve its held cover
// when a layout switch remounts that slot during a decode; retain a URL, not an image element.
let heldCover = EMPTY;
// Keep readiness by immutable URL, not images/bitmaps. Share an in-flight decode between the
// player bar and fullscreen and never sample pixels or load another copy for a tint.
const ready = new Set<string>();
const pending = new Map<string, Promise<string | null>>();

function decode(src: string): Promise<string | null> {
  const existing = pending.get(src);
  if (existing) return existing;
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  const request = image.decode().then(() => {
    ready.add(src);
    if (ready.size > READY_LIMIT) ready.delete(ready.values().next().value!);
    return src;
  }, () => null).finally(() => pending.delete(src));
  pending.set(src, request);
  return request;
}

function useDecodedCover(src: string): string | null | undefined {
  const [settled, setSettled] = useState<{ url: string; src: string | null }>();
  const asset = !src ? null : ready.has(src) ? src : settled?.url === src ? settled.src : undefined;
  useEffect(() => {
    if (asset !== undefined) return;
    let current = true;
    void decode(src).then(result => { if (current) setSettled({ url: src, src: result }); });
    return () => { current = false; };
  }, [src, asset]);
  return asset;
}

export function usePlaybackPresentation(item: MediaItem | null, showArtwork = true) {
  const animate = !useReducedMotion() && !document.hidden;
  const src = showArtwork ? item?.artworkUrl ?? "" : "";
  const asset = useDecodedCover(src);
  const label = item?.albumLabel ?? item?.title ?? "";
  const coverTarget = useMemo<VisualLayer<Cover> | null>(() => asset !== undefined ? {
    key: src, value: { src: asset, label },
  } : null, [asset, src, label]);
  const cover = useDissolve(coverTarget, src ? heldCover : EMPTY, MOTION_DURATION_MS.layout, animate && showArtwork);
  useLayoutEffect(() => {
    if (showArtwork) heldCover = cover.front.value.src ? cover.front : EMPTY;
  }, [showArtwork, cover.front]);

  // A title is authoritative on the track commit. Its transition covers the same beat as
  // a cached cover; slow art never makes the metadata wait or rewinds the current identity.
  const key = item ? trackSourceKey(item.source) : "";
  const textTarget = useMemo(() => ({ key, value: item }), [item, key]);
  const text = useDissolve(textTarget, textTarget, MOTION_DURATION_MS.view, animate);
  return { cover, text };
}
