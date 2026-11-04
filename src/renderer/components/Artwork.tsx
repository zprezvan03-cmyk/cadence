/**
 * Artwork with a graceful fallback, plus per-album accent extraction for the UI.
 * Written for Cadence.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
}

const FALLBACK_GRADIENTS = [
  "linear-gradient(135deg, #4b4e55 0%, #34363b 100%)",
  "linear-gradient(135deg, #45484f 0%, #303236 100%)",
  "linear-gradient(135deg, #50535a 0%, #383a3f 100%)",
  "linear-gradient(135deg, #414349 0%, #2d2f33 100%)",
  "linear-gradient(135deg, #484a50 0%, #33353a 100%)",
];

export function Artwork({ src, alt, size = "md", rounded = "md", className = "", accentVar }: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [accent, setAccent] = useState<string | null>(() => (src && accentVar ? cachedAccent(src) : null));

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
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

  // A cached cover can finish before React's onLoad is observed; treat an
  // already-complete image as loaded so the fade-in can never strand it invisible.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, [src]);

  const gradient = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < alt.length; i++) hash = (hash * 31 + alt.charCodeAt(i)) >>> 0;
    return FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length];
  }, [alt]);

  const showFallback = !src || failed;

  return (
    <div
      className={`artwork artwork-${size} rounded-${rounded} ${className}`}
      style={{
        background: showFallback ? gradient : undefined,
        ...(accentVar && accent ? ({ "--artwork-accent": accent } as React.CSSProperties) : {}),
      }}
      data-accent={accentVar ? accent ?? undefined : undefined}
    >
      {!showFallback ? (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          data-loaded={loaded}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        <Disc3 className="artwork-fallback-icon" aria-hidden="true" />
      )}
    </div>
  );
}
