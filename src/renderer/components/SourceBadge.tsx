/**
 * One consistent provenance badge for remote media.
 *
 * Local tracks intentionally render nothing and keep their existing appearance. Generic Data
 * API videos say “YouTube”; only items whose actual source is YouTube Music say so.
 */

import { Youtube } from "lucide-react";
import { sourceDisplayName } from "../../shared/media";
import type { MediaItem, TrackSource } from "../../shared/types";

export function SourceBadge({
  source,
  compact = false,
  className = "",
}: {
  source: TrackSource | MediaItem;
  compact?: boolean;
  className?: string;
}) {
  const trackSource = "source" in source ? source.source : source;
  const label = sourceDisplayName(trackSource);
  if (!label) return null;
  return (
    <span
      className={`source-badge ${compact ? "compact" : ""} ${className}`.trim()}
      data-testid="source-badge"
      data-source-kind={trackSource.kind}
      title={`Source: ${label}`}
    >
      <Youtube size={compact ? 11 : 12} aria-hidden="true" />
      <span>{compact && trackSource.kind === "youtube-music" ? "YT Music" : label}</span>
    </span>
  );
}
