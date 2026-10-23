import { describe, expect, it } from "vitest";
import {
  applyRomanization,
  applyTranslations,
  detectSyncType,
  parseLyricsText,
  stripRomanization,
  stripTranslations,
} from "../../src/renderer/features/lyrics/parseLyrics";

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

describe("lyric decorations", () => {
  const base = () => parseLyricsText(RICH_LRC, 8_000).lyrics;

  it("attaches each translation to its own line without touching timing or parts", () => {
    const lyrics = base();
    const decorated = applyTranslations(lyrics, ["First in English", null], "en");
    expect(decorated[0].translation).toEqual({ text: "First in English", lang: "en" });
    expect(decorated[0].translations).toEqual({ en: "First in English" });
    expect(decorated[0].startTimeMs).toBe(lyrics[0].startTimeMs);
    expect(decorated[0].parts).toBe(lyrics[0].parts);
    // A missing translation leaves the line itself untouched — no placeholder decoration.
    expect(decorated[1]).toBe(lyrics[1]);
  });

  it("attaches each romanization to its own line and skips blank results", () => {
    const lyrics = base();
    const decorated = applyRomanization(lyrics, ["", "daini rain"]);
    expect(decorated[0]).toBe(lyrics[0]);
    expect(decorated[1].romanization).toBe("daini rain");
    expect(decorated).toHaveLength(lyrics.length);
  });

  it("keeps translation and romanization on the same line whichever pass runs second", () => {
    const lyrics = base();
    const translationFirst = applyRomanization(
      applyTranslations(lyrics, ["First in English", "Second in English"], "en"),
      ["fāsuto", "sekando"]
    );
    const romanizationFirst = applyTranslations(
      applyRomanization(lyrics, ["fāsuto", "sekando"]),
      ["First in English", "Second in English"],
      "en"
    );
    for (const decorated of [translationFirst, romanizationFirst]) {
      expect(decorated[0].translation?.text).toBe("First in English");
      expect(decorated[0].romanization).toBe("fāsuto");
      expect(decorated[1].translation?.text).toBe("Second in English");
      expect(decorated[1].romanization).toBe("sekando");
      // Decorations never become standalone lyric entries.
      expect(decorated).toHaveLength(lyrics.length);
    }
  });

  it("strip helpers remove only their own decoration", () => {
    const decorated = applyRomanization(
      applyTranslations(base(), ["First in English", "Second in English"], "en"),
      ["fāsuto", "sekando"]
    );
    const noTranslation = stripTranslations(decorated);
    expect(noTranslation[0].translation).toBeUndefined();
    expect(noTranslation[0].translations).toBeUndefined();
    expect(noTranslation[0].romanization).toBe("fāsuto");
    expect(noTranslation[0].words).toBe(decorated[0].words);

    const noRomanization = stripRomanization(decorated);
    expect(noRomanization[0].romanization).toBeUndefined();
    expect(noRomanization[0].translation?.text).toBe("First in English");

    const bare = stripTranslations(noRomanization);
    expect(bare[0].translation).toBeUndefined();
    expect(bare[0].romanization).toBeUndefined();
    expect(bare[0].startTimeMs).toBe(decorated[0].startTimeMs);
  });

  it("strip helpers return the same array when there is nothing to strip", () => {
    const lyrics = base();
    expect(stripTranslations(lyrics)).toBe(lyrics);
    expect(stripRomanization(lyrics)).toBe(lyrics);
  });
});
