/**
 * Artwork sources for the global shader wallpaper. Written for Cadence.
 *
 * The shader warps an image, so it needs *something* to warp. The Now Playing stage always has the
 * playing track's cover; the app-wide wallpaper does not — with nothing playing there is no artwork at
 * all, and a shader over an empty source renders a near-black field, which is exactly what an
 * always-on wallpaper must not look like.
 *
 * When there is no cover, the wallpaper warps a generated gradient built from the app's own accent
 * colour and the shell's dark canvas: two soft radial pools of accent over a deep base, offset so the
 * warp has structure to bend. It is an inline SVG data URL, drawn once per accent value and cached, so
 * there is no network request, no canvas and no extra decode of user media.
 */

/** Deep base the gradient sits on: the same near-black the Now Playing stage uses. */
const BASE = "#08080e";

/** `#rrggbb` → `rgba(r, g, b, a)`; anything unparseable falls back to the brand accent. */
function rgbaFromHex(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = match
    ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
    : [255, 61, 113];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const cache = new Map<string, string>();

/**
 * A 512×512 gradient wash for the wallpaper: accent pools top-left and bottom-right over the deep
 * base, with a cool counterweight so the warp never reads as a single flat hue.
 */
export function generatedShaderSource(accent: string): string {
  const cached = cache.get(accent);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${BASE}"/><stop offset="0.55" stop-color="#0d0c18"/><stop offset="1" stop-color="${BASE}"/>
</linearGradient>
<radialGradient id="warm" cx="0.3" cy="0.28" r="0.72">
<stop offset="0" stop-color="${rgbaFromHex(accent, 0.92)}"/><stop offset="0.55" stop-color="${rgbaFromHex(accent, 0.28)}"/><stop offset="1" stop-color="${rgbaFromHex(accent, 0)}"/>
</radialGradient>
<radialGradient id="cool" cx="0.76" cy="0.74" r="0.6">
<stop offset="0" stop-color="rgba(72, 96, 220, 0.68)"/><stop offset="0.6" stop-color="rgba(58, 74, 180, 0.2)"/><stop offset="1" stop-color="rgba(58, 74, 180, 0)"/>
</radialGradient>
<radialGradient id="glow" cx="0.62" cy="0.16" r="0.4">
<stop offset="0" stop-color="rgba(255, 214, 232, 0.34)"/><stop offset="1" stop-color="rgba(255, 214, 232, 0)"/>
</radialGradient>
</defs>
<rect width="512" height="512" fill="url(#base)"/>
<rect width="512" height="512" fill="url(#cool)"/>
<rect width="512" height="512" fill="url(#warm)"/>
<rect width="512" height="512" fill="url(#glow)"/>
</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(accent, url);
  return url;
}
