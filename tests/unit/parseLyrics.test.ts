import { describe, expect, it } from "vitest";
import { detectSyncType, parseLyricsText } from "../../src/renderer/features/lyrics/parseLyrics";

const LINE_LRC = "[ti:Test]\n[00:01.00]First line\n[00:03.50]Second line\n[00:06.00]Third line";
const RICH_LRC = "[00:01.00]<00:01.00>Word <00:01.30>level <00:01.70>sync\n[00:04.00]<00:04.00>Second <00:04.40>line";

describe("detectSyncType", () => {
  it("reports word level only when parts exist", () => {
    const line = parseLyricsText(LINE_LRC, 10_000);
    const rich = parseLyricsText(RICH_LRC, 10_000);
    expect(detectSyncType(line.lyrics)).toBe("synced");
    expect(detectSyncType(rich.lyrics)).toBe("richsync");
  });

  it("keeps plain text unsynced", () => {
    const plain = parseLyricsText("just some words\nand another line", 10_000);
    expect(detectSyncType(plain.lyrics)).toBe("none");
  });
});

describe("parseLyricsText", () => {
  it("parses LRC line timings into milliseconds", () => {
    const parsed = parseLyricsText(LINE_LRC, 11_000);
    expect(parsed.lyrics).toHaveLength(3);
    expect(parsed.lyrics[0].words).toContain("First line");
    expect(parsed.lyrics[0].startTimeMs).toBe(1000);
    expect(parsed.lyrics[2].startTimeMs).toBe(6000);
    expect(parsed.syncType).toBe("synced");
    // Line-level files must not gain per-word parts.
    expect(parsed.lyrics.every(line => !line.parts || line.parts.length === 0)).toBe(true);
  });

  it("parses enhanced LRC into word parts with their own timings", () => {
    const parsed = parseLyricsText(RICH_LRC, 8_000);
    expect(parsed.syncType).toBe("richsync");
    const first = parsed.lyrics[0];
    expect(first.parts?.length).toBeGreaterThanOrEqual(3);
    const words = first.parts!.map(part => part.words.trim());
    expect(words).toContain("Word");
    expect(words).toContain("sync");
    expect(first.parts![1].startTimeMs).toBeGreaterThan(first.parts![0].startTimeMs);
  });

  it("flags instrumental-only files", () => {
    const parsed = parseLyricsText("[00:00.00][instrumental only]", 5_000);
    expect(parsed.instrumentalOnly).toBe(true);
  });

  it("detects the script of the lyrics", () => {
    const cyrillic = parseLyricsText("[00:01.00]Привет мир\n[00:03.00]Как дела", 8_000);
    expect(cyrillic.language).toBeTruthy();
    const latin = parseLyricsText(LINE_LRC, 11_000);
    expect(latin.language).toBeNull();
  });

  it("handles empty input without throwing", () => {
    const parsed = parseLyricsText("", 3_000);
    expect(parsed.lyrics).toEqual([]);
    expect(parsed.syncType).toBe("none");
  });
});
