import { describe, expect, it } from "vitest";
import {
  applyFileRomanization,
  applyRomanization,
  applyTranslations,
  detectSyncType,
  parseLyricsText,
  romanizationGaps,
  scatterRomanizations,
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

describe("local file romanization priority", () => {
  // A TTML sidecar whose transliterations cover only the first two lines.
  const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="ja">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <itunes:metadata>
        <transliterations>
          <transliteration xml:lang="ja-Latn">
            <text for="L1">sakura no hana ga saku</text>
            <text for="L2">sora wa aoi</text>
          </transliteration>
        </transliterations>
      </itunes:metadata>
    </metadata>
  </head>
  <body dur="00:10.000">
    <div>
      <p begin="00:00.500" end="00:02.500" itunes:key="L1" ttm:agent="v1">桜の花が咲く</p>
      <p begin="00:03.000" end="00:05.000" itunes:key="L2" ttm:agent="v1">空は青い</p>
      <p begin="00:05.500" end="00:07.500" itunes:key="L3" ttm:agent="v1">風が吹く</p>
    </div>
  </body>
</tt>`;
  const local = () => parseLyricsText(TTML, 10_000).lyrics;

  it("parses file-supplied romanization onto the lines it belongs to", () => {
    const lyrics = local();
    expect(lyrics).toHaveLength(3);
    expect(lyrics[0].romanization).toBe("sakura no hana ga saku");
    expect(lyrics[1].romanization).toBe("sora wa aoi");
    expect(lyrics[2].romanization).toBeUndefined();
  });

  it("never overwrites local romanization with generated text, and fills only the gaps", () => {
    const lyrics = local();
    const generated = ["AUTO one", "AUTO two", "AUTO three"];
    const merged = applyRomanization(lyrics, generated);
    expect(merged[0]).toBe(lyrics[0]);
    expect(merged[1]).toBe(lyrics[1]);
    expect(merged[0].romanization).toBe("sakura no hana ga saku");
    expect(merged[2].romanization).toBe("AUTO three");
    // Reprocessing with a different generated batch changes nothing.
    const reprocessed = applyRomanization(merged, ["OTHER one", "OTHER two", "OTHER three"]);
    expect(reprocessed.map(line => line.romanization)).toEqual([
      "sakura no hana ga saku",
      "sora wa aoi",
      "AUTO three",
    ]);
  });

  it("preserves local romanization exactly, including Unicode and formatting", () => {
    const lyrics = local();
    const unicode = applyRomanization(
      [{ ...lyrics[2], romanization: "kaze ga fuku —  Kaze  " }],
      ["AUTO"]
    );
    expect(unicode[0].romanization).toBe("kaze ga fuku —  Kaze  ");
    // An empty generated result is not a reason to erase a supplied one.
    const emptied = applyRomanization(lyrics, ["", null, null]);
    expect(emptied[0].romanization).toBe("sakura no hana ga saku");
    expect(emptied[1].romanization).toBe("sora wa aoi");
  });

  it("reports only the lines missing local romanization as generation gaps", () => {
    expect(romanizationGaps(local())).toEqual([2]);
    const filled = applyRomanization(local(), [null, null, "kaze ga fuku"]);
    expect(romanizationGaps(filled)).toEqual([]);
    expect(romanizationGaps(parseLyricsText(LINE_LRC, 11_000).lyrics)).toEqual([0, 1, 2]);
  });

  it("scatters generated results back onto the gap lines only", () => {
    expect(scatterRomanizations(3, [2], ["kaze ga fuku"])).toEqual([null, null, "kaze ga fuku"]);
    expect(scatterRomanizations(3, [], [])).toEqual([null, null, null]);
  });

  it("the romanization toggle hides local and generated text alike, and restores the file's text without a request", () => {
    const lyrics = local();
    const withGenerated = applyRomanization(lyrics, [null, null, "AUTO three"]);
    expect(withGenerated.map(line => line.romanization)).toEqual([
      "sakura no hana ga saku",
      "sora wa aoi",
      "AUTO three",
    ]);

    // Toggle off: every romanized line is hidden, including the two the file supplied.
    const off = stripRomanization(withGenerated);
    expect(off.map(line => line.romanization)).toEqual([undefined, undefined, undefined]);
    // Nothing left to strip: identity contract.
    expect(stripRomanization(off)).toBe(off);

    // Toggle on again: the file's text is restored verbatim, generated text is not resurrected.
    const on = applyFileRomanization(off, lyrics);
    expect(on.map(line => line.romanization)).toEqual(["sakura no hana ga saku", "sora wa aoi", undefined]);
    // Applying it again is a no-op.
    expect(applyFileRomanization(on, lyrics)).toBe(on);
  });

  it("restores file romanization word timing together with the text", () => {
    const lyrics = local();
    const timed = lyrics.map((line, index) =>
      index === 0
        ? {
            ...line,
            timedRomanization: [
              { startTimeMs: 1000, durationMs: 500, words: "sakura ", isBackground: false },
              { startTimeMs: 1500, durationMs: 1000, words: "no hana", isBackground: false },
            ],
          }
        : line
    );
    const decorated = applyFileRomanization(stripRomanization(timed), timed);
    expect(decorated[0].romanization).toBe("sakura no hana ga saku");
    expect(decorated[0].timedRomanization?.map(part => part.words)).toEqual(["sakura ", "no hana"]);
    const stripped = stripRomanization(decorated);
    expect(stripped[0].romanization).toBeUndefined();
    expect(stripped[0].timedRomanization).toBeUndefined();
  });
});
