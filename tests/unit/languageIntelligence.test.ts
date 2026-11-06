import { describe, expect, it } from "vitest";
import { analyzeLyrics, scriptOf } from "../../src/main/lyrics/languageIntelligence";

describe("offline lyrics language/script intelligence", () => {
  it("identifies Japanese script and needs romanization", () => {
    const result = analyzeLyrics(["君のことが好き", "夜空に星が光る"]);
    expect(result.language).toBe("ja"); expect(result.script).toBe("Japanese"); expect(result.romanizationLikelyNeeded).toBe(true);
  });
  it("recognizes Japanese kana context even when lines include Han", () => {
    const result = analyzeLyrics("君が好きだよ\nさよなら世界");
    expect(result.language).toBe("ja"); expect(result.romanizationLikelyNeeded).toBe(true);
  });
  it("does not romanize Japanese already written in romaji", () => {
    const result = analyzeLyrics(["Watashi wa kimi no yume", "Anata no kokoro ni ai"]);
    expect(result.language).toBe("ja-Latn"); expect(result.romanizationLikelyNeeded).toBe(false);
  });
  it("detects Korean, Russian and Arabic from script while keeping script distinct", () => {
    expect(analyzeLyrics("사랑은 언제나 아름다워").language).toBe("ko");
    expect(analyzeLyrics("Я люблю тебя сегодня").language).toBe("ru");
    expect(analyzeLyrics("أحبك في كل ليلة").language).toBe("ar");
    expect(scriptOf("Я люблю тебя")).toBe("Cyrillic");
  });
  it("treats Han-only text as uncertain Chinese rather than claiming certainty", () => {
    const result = analyzeLyrics("我爱你直到永远");
    expect(result.language).toBe("zh"); expect(result.confidence).toBeLessThan(.7);
  });
  it("aggregates repeated choruses and mixed English phrases", () => {
    const result = analyzeLyrics(["君が好き", "I love you", "君が好き", "君が好き"]);
    expect(result.language).toBe("ja"); expect(result.mixed).toBe(true);
  });
  it("handles English, instrumental markers and too-short uncertain input", () => {
    expect(analyzeLyrics(["I love you", "♪", "The night is here"]).language).toBe("en");
    expect(analyzeLyrics("♪").language).toBe("und");
    expect(analyzeLyrics("愛").confidence).toBeLessThan(.7);
    expect(analyzeLyrics("I").language).toBe("und");
  });
  it("requires no network access", () => {
    expect(analyzeLyrics("Hello, this is a song").language).toBe("en");
  });
});
