/**
 * Artwork with a graceful fallback, plus per-album accent extraction for the UI.
 * Written for Cadence.
 */

import { useEffect, useMemo, useState } from "react";
import { Disc3 } from "lucide-react";
import { measureArtworkAccent } from "../upstream/shaders/artworkBrightness";

const accentCache = new Map<string, string>();

interface ArtworkProps {
  src: string | null | undefined;
  alt: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "hero";
  rounded?: "sm" | "md" | "full";
  className?: string;
  accentVar?: boolean;
}

const FALLBACK_GRADIENTS = [
  "linear-gradient(135deg, #2b1b3d 0%, #110b1a 100%)",
  "linear-gradient(135deg, #1b2f3d 0%, #0b1218 100%)",
  "linear-gradient(135deg, #3d241b 0%, #180f0b 100%)",
  "linear-gradient(135deg, #1b3d2c 0%, #0b1811 100%)",
  "linear-gradient(135deg, #3d1b2c 0%, #180b12 100%)",
];

export function Artwork({ src, alt, size = "md", rounded = "md", className = "", accentVar }: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  const [accent, setAccent] = useState<string | null>(() => (src ? accentCache.get(src) ?? null : null));

  useEffect(() => {
    setFailed(false);
    if (!src) {
      setAccent(null);
      return;
    }
    const cached = accentCache.get(src);
    if (cached) {
      setAccent(cached);
      return;
    }
    let cancelled = false;
    void measureArtworkAccent(src).then(colour => {
      if (cancelled || !colour) return;
      accentCache.set(src, colour);
      setAccent(colour);
    });
    return () => {
      cancelled = true;
    };
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
      data-accent={accent ?? undefined}
    >
      {!showFallback ? (
        <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <Disc3 className="artwork-fallback-icon" aria-hidden="true" />
      )}
    </div>
  );
}
