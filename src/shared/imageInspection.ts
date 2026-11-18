/**
 * Minimal, dependency-free image inspection for Cadence.
 *
 * Artist profile pictures arrive from third-party APIs as untrusted bytes. Before Cadence writes
 * one into its artwork cache it needs three facts a URL alone cannot prove: that the payload really
 * is an image, which format it is (so the file gets the right extension and MIME type), and how big
 * it is (so a 1×1 tracking pixel or a stretched banner is never presented as a portrait).
 *
 * Only the container headers are parsed — no decoding, no canvas, no extra dependency — so this
 * runs in the main process, in Vitest, and in the renderer alike.
 */

export type InspectedImageFormat = "jpeg" | "png" | "webp" | "gif" | "bmp";

export interface InspectedImage {
  format: InspectedImageFormat;
  mimeType: string;
  extension: ".jpg" | ".png" | ".webp" | ".gif" | ".bmp";
  width: number;
  height: number;
}

export interface ImageValidationOptions {
  /** Smallest accepted edge in pixels. Avatars are drawn at ≤ 220 px, so 96 is a safe floor. */
  minEdge?: number;
  /** Largest accepted edge in pixels; guards against gigantic originals. */
  maxEdge?: number;
  /** Largest accepted aspect ratio (width/height or height/width). */
  maxAspectRatio?: number;
  /** Largest accepted payload in bytes. */
  maxBytes?: number;
}

export type ImageValidationFailure =
  | "empty"
  | "too-large"
  | "unrecognized-format"
  | "unreadable-dimensions"
  | "too-small"
  | "extreme-aspect-ratio";

export interface ImageValidationResult {
  ok: boolean;
  image: InspectedImage | null;
  failure: ImageValidationFailure | null;
}

export const DEFAULT_MAX_ARTIST_IMAGE_BYTES = 8 * 1024 * 1024;

/** Reads a big-endian 16-bit integer; `null` when the buffer is too short. */
function readU16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    ((bytes[offset] << 24) >>> 0) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** PNG stores its dimensions in the leading IHDR chunk. */
function inspectPng(bytes: Uint8Array): InspectedImage | null {
  if (!matchesAscii(bytes, 1, "PNG")) return null;
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (!width || !height) return null;
  return { format: "png", mimeType: "image/png", extension: ".png", width, height };
}

/** GIF stores a little-endian logical screen descriptor at offset 6. */
function inspectGif(bytes: Uint8Array): InspectedImage | null {
  if (!matchesAscii(bytes, 0, "GIF8")) return null;
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  if (!width || !height) return null;
  return { format: "gif", mimeType: "image/gif", extension: ".gif", width, height };
}

function inspectBmp(bytes: Uint8Array): InspectedImage | null {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const width = readU32BE(bytes, 18);
  const height = readU32BE(bytes, 22);
  if (!width || !height) return null;
  return {
    format: "bmp",
    mimeType: "image/bmp",
    extension: ".bmp",
    width,
    height: Math.abs(height),
  };
}

/**
 * JPEG carries its size in the first start-of-frame (SOFn) segment, which may follow any number of
 * metadata segments (JFIF, EXIF thumbnails, ICC profiles, comments).
 */
function inspectJpeg(bytes: Uint8Array): InspectedImage | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Padding fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = readU16BE(bytes, offset + 2);
    if (!length || length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      if (!width || !height) return null;
      return { format: "jpeg", mimeType: "image/jpeg", extension: ".jpg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP has three sub-formats; VP8X carries canvas size, VP8/VP8L carry their own header size. */
function inspectWebp(bytes: Uint8Array): InspectedImage | null {
  if (!matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) return null;
  const chunk = [bytes[12], bytes[13], bytes[14], bytes[15]];
  const chunkType = String.fromCharCode(...chunk);
  if (chunkType === "VP8X") {
    const width = readU24LE(bytes, 24);
    const height = readU24LE(bytes, 27);
    if (!width || !height) return null;
    return { format: "webp", mimeType: "image/webp", extension: ".webp", width: width + 1, height: height + 1 };
  }
  if (chunkType === "VP8 ") {
    const width = readU16LE(bytes, 26);
    const height = readU16LE(bytes, 28);
    if (!width || !height) return null;
    return { format: "webp", mimeType: "image/webp", extension: ".webp", width: width & 0x3fff, height: height & 0x3fff };
  }
  if (chunkType === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { format: "webp", mimeType: "image/webp", extension: ".webp", width, height };
  }
  return null;
}

/** Sniffs an image container from its leading bytes. Returns `null` for anything else. */
export function inspectImageBytes(bytes: Uint8Array): InspectedImage | null {
  if (!bytes || bytes.length < 16) return null;
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes) ?? inspectGif(bytes) ?? inspectBmp(bytes);
}

/** Guesses a MIME type from declared headers or a URL extension, for diagnostics only. */
export function guessImageMimeType(contentType: string | null | undefined, url?: string): string | null {
  const declared = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  const tail = (url ?? "").split("?")[0].toLowerCase();
  if (tail.endsWith(".png")) return "image/png";
  if (tail.endsWith(".jpg") || tail.endsWith(".jpeg")) return "image/jpeg";
  if (tail.endsWith(".webp")) return "image/webp";
  if (tail.endsWith(".gif")) return "image/gif";
  if (tail.endsWith(".bmp")) return "image/bmp";
  return null;
}

/**
 * Validates downloaded artist picture bytes: a recognised image container, sane dimensions and a
 * bounded payload. Providers whose payload fails here are treated as a miss so the next provider
 * in priority order gets a turn.
 */
export function validateArtistImageBytes(
  bytes: Uint8Array,
  options: ImageValidationOptions = {}
): ImageValidationResult {
  const minEdge = options.minEdge ?? 96;
  const maxEdge = options.maxEdge ?? 8192;
  const maxAspectRatio = options.maxAspectRatio ?? 3;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIST_IMAGE_BYTES;
  if (!bytes || bytes.length === 0) return { ok: false, image: null, failure: "empty" };
  if (bytes.length > maxBytes) return { ok: false, image: null, failure: "too-large" };
  const image = inspectImageBytes(bytes);
  if (!image) return { ok: false, image: null, failure: "unrecognized-format" };
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
    return { ok: false, image: null, failure: "unreadable-dimensions" };
  }
  if (Math.min(image.width, image.height) < minEdge) {
    return { ok: false, image, failure: "too-small" };
  }
  if (Math.max(image.width, image.height) > maxEdge) {
    return { ok: false, image, failure: "too-large" };
  }
  const aspect = Math.max(image.width, image.height) / Math.min(image.width, image.height);
  if (aspect > maxAspectRatio) {
    return { ok: false, image, failure: "extreme-aspect-ratio" };
  }
  return { ok: true, image, failure: null };
}
