/**
 * Random-access `strtok3` tokenizer backed by byte-range reads (either `cadence-media` HTTP Range
 * fetches or Tauri binary IPC chunks), with a 256 KiB read-ahead multi-window cache (pinning
 * offset 0 + up to 3 recent seek windows) so `music-metadata` parses ID3v2 / FLAC / MP4 / Ogg /
 * Opus / WAV tags and cover art in 1-2 reads without re-fetching head chunks or loading full
 * audio frames into memory. Written for Cadence.
 */

import { AbstractTokenizer, EndOfStreamError, type IFileInfo, type IReadChunkOptions } from "strtok3/core";

export type ReadChunkFn = (offset: number, length: number) => Promise<Uint8Array>;

const CACHE_WINDOW_BYTES = 128 * 1024;
const SMALL_FILE_SINGLE_READ_BYTES = 256 * 1024;
const MAX_CACHED_WINDOWS = 4;

interface CachedWindow {
  offset: number;
  data: Uint8Array;
}

export class RangeTokenizer extends AbstractTokenizer {
  readonly fileInfo: IFileInfo;
  private readonly windows: CachedWindow[] = [];

  constructor(
    filePath: string,
    private readonly fileSize: number,
    private readonly readChunk: ReadChunkFn
  ) {
    super();
    this.fileInfo = {
      path: filePath,
      size: fileSize > 0 ? fileSize : undefined,
    };
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  private findCachedWindow(position: number, length: number): CachedWindow | null {
    for (let i = 0; i < this.windows.length; i++) {
      const win = this.windows[i];
      if (position >= win.offset && position + length <= win.offset + win.data.byteLength) {
        return win;
      }
    }
    return null;
  }

  private storeWindow(offset: number, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const existingIdx = this.windows.findIndex(w => w.offset === offset);
    if (existingIdx >= 0) {
      this.windows[existingIdx] = { offset, data };
      return;
    }
    if (this.windows.length >= MAX_CACHED_WINDOWS) {
      // Keep the head window (`offset === 0`) pinned so tail seeks (e.g. MP4 `moov`) never evict it.
      const evictIdx = this.windows.findIndex(w => w.offset !== 0);
      this.windows.splice(evictIdx >= 0 ? evictIdx : 0, 1);
    }
    this.windows.push({ offset, data });
  }

  private async readRangeInto(
    target: Uint8Array,
    position: number,
    length: number
  ): Promise<number> {
    if (length === 0) return 0;
    if (this.fileSize > 0 && position >= this.fileSize) return 0;

    const clampedLength =
      this.fileSize > 0 ? Math.min(length, this.fileSize - position) : length;

    // Serve directly from any cached read-ahead window when fully covered.
    const cached = this.findCachedWindow(position, clampedLength);
    if (cached) {
      const start = position - cached.offset;
      target.set(cached.data.subarray(start, start + clampedLength), 0);
      return clampedLength;
    }

    let fetchLength: number;
    if (this.fileSize > 0) {
      const targetWindow =
        position === 0 && this.fileSize <= SMALL_FILE_SINGLE_READ_BYTES
          ? this.fileSize
          : CACHE_WINDOW_BYTES;
      fetchLength = Math.min(Math.max(clampedLength, targetWindow), this.fileSize - position);
    } else {
      fetchLength = Math.max(clampedLength, CACHE_WINDOW_BYTES);
    }

    const chunk = await this.readChunk(position, fetchLength);
    if (fetchLength <= SMALL_FILE_SINGLE_READ_BYTES) {
      this.storeWindow(position, chunk);
    }

    const copyLength = Math.min(clampedLength, chunk.byteLength);
    target.set(chunk.subarray(0, copyLength), 0);
    return copyLength;
  }

  async readBuffer(uint8Array: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const normOptions = this.normalizeOptions(uint8Array, options);
    this.position = normOptions.position;
    if (normOptions.length === 0) return 0;

    const bytesRead = await this.readRangeInto(uint8Array, normOptions.position, normOptions.length);
    this.position += bytesRead;
    if (bytesRead < normOptions.length && !normOptions.mayBeLess) {
      throw new EndOfStreamError();
    }
    return bytesRead;
  }

  async peekBuffer(uint8Array: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const normOptions = this.normalizeOptions(uint8Array, options);
    this.position = normOptions.position;
    if (normOptions.length === 0) return 0;

    const bytesRead = await this.readRangeInto(uint8Array, normOptions.position, normOptions.length);
    if (bytesRead < normOptions.length && !normOptions.mayBeLess) {
      throw new EndOfStreamError();
    }
    return bytesRead;
  }
}
