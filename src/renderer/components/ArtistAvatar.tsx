/**
 * Circular artist profile picture with a graceful fallback.
 *
 * The component is intentionally dumb: it asks the artist-image store for a picture by name and
 * draws whatever is available. Provider priority, caching, validation and rate limiting all live in
 * the main process, so no UI component ever learns which source a picture came from.
 *
 * The frame keeps a fixed size with `aspect-ratio: 1`, so an unresolved or slow picture reserves
 * exactly the space the final image occupies — no layout shift while pictures stream in.
 */

import { useEffect } from "react";
import { UserRound } from "lucide-react";
import { artistImageKey } from "../../shared/artistImageCache";
import { useArtistImages } from "../state/artistImageStore";
import { Artwork } from "./Artwork";

export interface ArtistAvatarProps {
  /** Artist name exactly as stored in the library. */
  name: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function ArtistAvatar({ name, size = "md", className = "" }: ArtistAvatarProps) {
  const request = useArtistImages(state => state.request);
  const entry = useArtistImages(state => state.entries[artistImageKey(name)]);

  useEffect(() => {
    if (name.trim()) request(name);
  }, [name, request]);

  const credit =
    entry?.status === "ready" && entry.attribution
      ? `Photo: ${entry.attribution}${entry.provider ? ` (${entry.provider})` : ""}`
      : undefined;

  return (
    <Artwork
      src={entry?.status === "ready" ? entry.url : null}
      alt={name}
      size={size}
      rounded="full"
      className={`artist-avatar ${className}`.trim()}
      title={credit}
      fallbackIcon={<UserRound className="artwork-fallback-icon" aria-hidden="true" />}
    />
  );
}

/**
 * The credit line a licensed picture requires (Wikimedia Commons in particular). Renders nothing for
 * sources that need no attribution, and nothing at all until a picture is showing.
 */
export function ArtistImageCredit({ name }: { name: string }) {
  const entry = useArtistImages(state => state.entries[artistImageKey(name)]);
  if (entry?.status !== "ready" || !entry.attribution) return null;
  const label = entry.license ? `Photo: ${entry.attribution}` : `Photo via ${entry.provider ?? entry.attribution}`;
  const openPage = () => {
    const pageUrl = entry.pageUrl;
    if (!pageUrl) return;
    void window.cadence?.app?.openExternal(pageUrl)?.catch(() => undefined);
  };
  return (
    <p className="artist-image-credit" data-testid="artist-image-credit">
      {entry.pageUrl ? (
        <button type="button" onClick={openPage} title={entry.pageUrl}>
          {label}
        </button>
      ) : (
        label
      )}
    </p>
  );
}
