import type { CSSProperties, ReactNode } from "react";
import { Disc3 } from "lucide-react";
import type { MediaItem } from "../../../shared/types";
import type { Dissolve } from "../../app/useDissolve";
import { artworkFallbackGradient } from "../../components/Artwork";
import type { Cover } from "./usePlaybackPresentation";

export function PlaybackArtwork({ cover, label, size = "sm" }: {
  cover: Dissolve<Cover>;
  label: string;
  size?: "sm" | "hero";
}) {
  return (
    <div className={`artwork artwork-${size} playback-cover`} data-player-part="artwork" role="img" aria-label={label}>
      {[cover.back, cover.front].map(layer => layer && (
        <div
          key={layer.key}
          aria-hidden="true"
          className="playback-cover-layer"
          data-cover-layer={layer === cover.front ? "current" : "outgoing"}
          style={{ background: layer.value.src ? undefined : artworkFallbackGradient(layer.key) }}
        >
          {layer.value.src ? (
            <img src={layer.value.src} alt="" draggable={false} />
          ) : <Disc3 className="artwork-fallback-icon" />}
        </div>
      ))}
    </div>
  );
}

export function PlaybackText({ text, className = "", draggable, children }: {
  text: Dissolve<MediaItem | null>;
  className?: string;
  draggable?: boolean;
  children: (item: MediaItem | null) => ReactNode;
}) {
  return (
    <div
      className={`playback-text ${className}`}
      data-player-part="metadata"
      data-tauri-drag-region={draggable || undefined}
    >
      {[text.front, text.back].map(layer => layer && (
        <div
          key={layer.key}
          data-track-layer={layer === text.front ? "current" : "outgoing"}
          data-tauri-drag-region={draggable || undefined}
          aria-hidden={layer === text.back || undefined}
        >
          {children(layer.value)}
        </div>
      ))}
    </div>
  );
}

export function ArtworkAtmosphere({ cover, intensity = 1, blurPx, fallback = "var(--accent)" }: {
  cover: Dissolve<Cover>;
  intensity?: number;
  blurPx?: number;
  fallback?: string;
}) {
  return (
    <div className="artwork-atmosphere" style={{ opacity: intensity }} aria-hidden="true">
      {[cover.back, cover.front].map(layer => {
        if (!layer) return null;
        const { src, accent } = layer.value;
        return (
          <div
            key={layer.key}
            className="artwork-atmosphere-layer"
            data-atmosphere-layer={layer === cover.front ? "current" : "outgoing"}
            style={{ "--cover-tint": accent ?? fallback } as CSSProperties}
          >
            {blurPx !== undefined && src ? (
              <div className="np-bg-fill np-bg-blurred" style={{
                backgroundImage: `url("${src.replace(/"/g, "%22")}")`,
                filter: `blur(${blurPx}px) saturate(1.15) brightness(0.72)`,
              }} />
            ) : <div className="np-bg-fill artwork-wash" />}
          </div>
        );
      })}
    </div>
  );
}
