/**
 * Random-access `strtok3` tokenizer backed by byte-range reads (either `cadence-media` HTTP Range
 * fetches or Tauri binary IPC chunks), with a 64 KiB read-ahead cache so `music-metadata` parses
 * ID3v2 / FLAC / MP4 / Ogg / Opus / WAV tags and cover art in 1-2 reads without loading full audio
 * frames into memory. Written for Cadence.
 */

import { AbstractTokenizer, EndOfStreamError, type IFileInfo, type IReadChunkOptions } from "strtok3/core";

export type ReadChunkFn = (offset: number, length: number) => Promise<Uint8Array>;

const CACHE_WINDOW_BYTES = 64 * 1024;

export class RangeTokenizer extends AbstractTokenizer {
  readonly fileInfo: IFileInfo;
  private cachedOffset = -1;
  private cachedData: Uint8Array = new Uint8Array(0);

  constructor(
    filePath: string,
    private readonly fileSize: number,
    private readonly readChunk: ReadChunkFn
  ) {
    super();
    this.fileInfo = { path: filePath, size: fileSize };
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  private async readRangeInto(
    target: Uint8Array,
    position: number,
    length: number
  ): Promise<number> {
    if (length === 0 || position >= this.fileSize) return 0;
    const clampedLength = Math.min(length, this.fileSize - position);

    // Serve directly from the read-ahead window when fully covered.
    if (
      this.cachedOffset >= 0 &&
      position >= this.cachedOffset &&
      position + clampedLength <= this.cachedOffset + this.cachedData.byteLength
    ) {
      const start = position - this.cachedOffset;
      target.set(this.cachedData.subarray(start, start + clampedLength), 0);
      return clampedLength;
    }

    const fetchLength = Math.min(
      Math.max(clampedLength, CACHE_WINDOW_BYTES),
      this.fileSize - position
    );
    const chunk = await this.readChunk(position, fetchLength);
    if (fetchLength <= CACHE_WINDOW_BYTES * 2) {
      this.cachedOffset = position;
      this.cachedData = chunk;
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
    if (normOptions.length === 0) return 0;

    const bytesRead = await this.readRangeInto(uint8Array, normOptions.position, normOptions.length);
    if (bytesRead < normOptions.length && !normOptions.mayBeLess) {
      throw new EndOfStreamError();
    }
    return bytesRead;
  }
}
