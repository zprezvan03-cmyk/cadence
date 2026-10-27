/**
 * Minimal typings for the synchronous PNG reader this harness uses. pngjs ships no declarations and
 * the project does not take a types-only dependency for a test helper.
 */
declare module "pngjs" {
  export interface PNGImage {
    width: number;
    height: number;
    data: Buffer;
  }
  export const PNG: {
    sync: {
      read(buffer: Buffer): PNGImage;
      write(image: PNGImage): Buffer;
    };
  };
}
