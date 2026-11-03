/**
 * PORTED FROM UPSTREAM — Better Lyrics Shaders
 * Repository: https://github.com/better-lyrics/shaders
 * Commit:     d878877cb225e1bcfef205c2937141a26112ebec
 * Original:   contents/lib/artworkBrightness.ts
 * License:    GPL-3.0
 *
 * Changes for Cadence: logging goes to the renderer console instead of the extension logger.
 * Same-app artwork is fetched, while cross-origin remote thumbnails are loaded as CORS images
 * (governed by `img-src`, not `connect-src`); if the image host does not grant CORS, pixel
 * measurement is skipped. The luminance maths (Rec.709, 90th percentile highlight, 0.8 maximum
 * reduction) is unchanged.
 */

const SAMPLE_SIZE = 32;
const HIGHLIGHT_PERCENTILE = 0.9;
const MAX_TARGET_REDUCTION = 0.8;

export const measureHighlightLuminance = (rgbaPixels: Uint8ClampedArray): number => {
  const pixelCount = rgbaPixels.length / 4;
  if (pixelCount === 0) return 0;

  const luminances = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    luminances[pixel] =
      (0.2126 * rgbaPixels[offset] + 0.7152 * rgbaPixels[offset + 1] + 0.0722 * rgbaPixels[offset + 2]) / 255;
  }
  luminances.sort();
  return luminances[Math.min(pixelCount - 1, Math.floor(pixelCount * HIGHLIGHT_PERCENTILE))];
};

export const brightnessForHighlight = (highlightLuminance: number, dimStrength: number): number => {
  const targetHighlightLuminance = 1 - MAX_TARGET_REDUCTION * Math.min(1, Math.max(0, dimStrength));
  if (highlightLuminance <= targetHighlightLuminance) return 1;
  return targetHighlightLuminance / highlightLuminance;
};

export function isCrossOriginRemoteArtwork(imageUrl: string): boolean {
  try {
    const url = new URL(imageUrl, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname === "cadence-media.localhost") return false;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function shouldLoadArtworkAsImage(imageUrl: string): boolean {
  try {
    const url = new URL(imageUrl, window.location.href);
    return url.protocol === "data:" || url.protocol === "blob:" || isCrossOriginRemoteArtwork(imageUrl);
  } catch {
    return false;
  }
}

async function loadArtworkBitmap(
  imageUrl: string,
  resizeQuality: ResizeQuality
): Promise<ImageBitmap | null> {
  const options: ImageBitmapOptions = {
    resizeWidth: SAMPLE_SIZE,
    resizeHeight: SAMPLE_SIZE,
    resizeQuality,
  };

  if (shouldLoadArtworkAsImage(imageUrl)) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.src = imageUrl;
    try {
      await image.decode();
      return await createImageBitmap(image, options);
    } catch {
      // Brightness/accent extraction is decorative. A thumbnail host that does not grant CORS
      // can still be displayed normally; it just cannot be read back from a canvas.
      return null;
    }
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    console.warn("[Cadence] Artwork brightness request failed:", response.status, imageUrl);
    return null;
  }
  return createImageBitmap(await response.blob(), options);
}

async function loadArtworkPixels(
  imageUrl: string,
  resizeQuality: ResizeQuality
): Promise<Uint8ClampedArray | null> {
  const bitmap = await loadArtworkBitmap(imageUrl, resizeQuality);
  if (!bitmap) return null;
  try {
    const canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } finally {
    bitmap.close();
  }
}

export const measureArtworkHighlight = async (imageUrl: string): Promise<number | null> => {
  try {
    const pixels = await loadArtworkPixels(imageUrl, "high");
    return pixels ? measureHighlightLuminance(pixels) : null;
  } catch (error) {
    console.error("[Cadence] Failed to measure artwork brightness:", error);
    return null;
  }
};

/** Dominant colour, used by the UI for per-album accents. Not part of the upstream module. */
export const measureArtworkAccent = async (imageUrl: string): Promise<string | null> => {
  try {
    const data = await loadArtworkPixels(imageUrl, "low");
    if (!data) return null;

    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.5) continue;
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const luminance = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      // Prefer saturated mid-tones: they read as an accent rather than as grey.
      const w = (0.15 + saturation) * (1 - Math.abs(luminance - 0.55));
      r += data[i] * w;
      g += data[i + 1] * w;
      b += data[i + 2] * w;
      weight += w;
    }
    if (weight === 0) return null;
    const toHex = (value: number) => Math.round(Math.min(255, value)).toString(16).padStart(2, "0");
    return `#${toHex(r / weight)}${toHex(g / weight)}${toHex(b / weight)}`;
  } catch {
    return null;
  }
};
