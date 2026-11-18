import type { ReactNode } from "react";
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
    <div className={`artwork artwork-${size} rounded-md playback-cover`} data-player-part="artwork" role="img" aria-label={label}>
      {[cover.back, cover.front].map(layer => layer && (
        <div
          key={layer.key}
          aria-hidden="true"
          className="playback-cover-layer"
          data-cover-layer={layer === cover.front ? "current" : "outgoing"}
          style={{ background: layer.value.src ? undefined : artworkFallbackGradient(layer.value.label || label) }}
        >
          {layer.value.src
            ? <img src={layer.value.src} alt="" draggable={false} />
            : <Disc3 className="artwork-fallback-icon" />}
        </div>
      ))}
    </div>
  );
}

export function PlaybackText({ text, className = "", shared, draggable, children }: {
  text: Dissolve<MediaItem | null>;
  className?: string;
  shared?: boolean;
  draggable?: boolean;
  children: (item: MediaItem | null) => ReactNode;
}) {
  return (
    <div
      className={`playback-text ${className}`}
      data-player-part={shared ? "metadata" : undefined}
      data-tauri-drag-region={draggable || undefined}
    >
      {[text.front, text.back].map(layer => layer && (
        <div
          key={layer.key}
          data-track-layer={layer === text.front ? "current" : "outgoing"}
          data-tauri-drag-region={draggable || undefined}
          inert={layer === text.back || undefined}
          aria-hidden={layer === text.back || undefined}
        >
          {children(layer.value)}
        </div>
      ))}
    </div>
  );
}
