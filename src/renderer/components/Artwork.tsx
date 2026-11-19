/**
 * Artwork with a graceful fallback, plus per-album accent extraction for the UI.
 * Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { Disc3 } from "lucide-react";
import { measureArtworkAccent } from "../upstream/shaders/artworkBrightness";

const MAX_CACHED_ACCENTS = 128;
const accentCache = new Map<string, string>();
const accentRequests = new Map<string, Promise<string | null>>();

function cachedAccent(src: string): string | null {
  const cached = accentCache.get(src);
  if (!cached) return null;
  // Map iteration order provides a small LRU without retaining decoded image data.
  accentCache.delete(src);
  accentCache.set(src, cached);
  return cached;
}

function loadAccent(src: string): Promise<string | null> {
  const existing = accentRequests.get(src);
  if (existing) return existing;
  const request = measureArtworkAccent(src)
    .then(colour => {
      if (colour) {
        accentCache.delete(src);
        accentCache.set(src, colour);
        while (accentCache.size > MAX_CACHED_ACCENTS) {
          const oldest = accentCache.keys().next().value;
          if (typeof oldest !== "string") break;
          accentCache.delete(oldest);
        }
      }
      return colour;
    })
    .finally(() => accentRequests.delete(src));
  accentRequests.set(src, request);
  return request;
}

interface ArtworkProps {
  src: string | null | undefined;
  alt: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "hero";
  rounded?: "sm" | "md" | "full";
  className?: string;
  accentVar?: boolean;
  /** Replaces the default disc glyph while a cover is missing or has failed to load. */
  fallbackIcon?: React.ReactNode;
  /** Native tooltip on the frame (used to surface image credits). */
  title?: string;
}

const FALLBACK_TONES = ["#343039", "#2c3740", "#3e3430", "#2d3833", "#3a3037"];

export function artworkFallbackTone(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length];
}

// Reveal in the image itself. A successful decode does not change the React tree, so a route
// with many thumbnails need not commit each row a second time just to start its CSS fade.
function revealCachedArtwork(image: HTMLImageElement | null) {
  if (image?.complete && image.naturalWidth > 0) image.dataset.loaded = "true";
}

export function Artwork({
  src,
  alt,
  size = "md",
  rounded = "md",
  className = "",
  accentVar,
  fallbackIcon,
  title,
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  const [accent, setAccent] = useState<string | null>(() => (src && accentVar ? cachedAccent(src) : null));

  useEffect(() => {
    setFailed(false);
    // Ordinary artwork only needs the <img>; decoding another bitmap for an unused CSS variable
    // made every song row fetch and analyse its cover. Accent work is opt-in and shared per URL.
    if (!src || !accentVar) {
      setAccent(null);
      return;
    }
    const cached = cachedAccent(src);
    if (cached) {
      setAccent(cached);
      return;
    }
    let cancelled = false;
    void loadAccent(src).then(colour => {
      if (!cancelled) setAccent(colour);
    });
    return () => {
      cancelled = true;
    };
  }, [src, accentVar]);

  const fallbackTone = useMemo(() => artworkFallbackTone(alt), [alt]);

  const showFallback = !src || failed;

  return (
    <div
      className={`artwork artwork-${size} rounded-${rounded} ${className}`}
      title={title}
      style={{
        backgroundColor: showFallback ? fallbackTone : undefined,
        ...(accentVar && accent ? ({ "--artwork-accent": accent } as React.CSSProperties) : {}),
      }}
      data-accent={accentVar ? accent ?? undefined : undefined}
    >
      {!showFallback ? (
        <img
          key={src}
          ref={revealCachedArtwork}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          data-loaded="false"
          onLoad={event => { event.currentTarget.dataset.loaded = "true"; }}
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        (fallbackIcon ?? <Disc3 className="artwork-fallback-icon" aria-hidden="true" />)
      )}
    </div>
  );
}
