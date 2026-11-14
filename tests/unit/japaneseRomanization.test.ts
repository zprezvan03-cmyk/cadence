import { describe, it, expect } from "vitest";
import romanizeJapanese from "../../src/main/lyrics/japaneseRomanization";

describe("local Japanese romanization", () => {
  it("converts basic examples", async () => {
    expect(await romanizeJapanese("きっと")).toBe("kitto");
    expect(await romanizeJapanese("ちょっと")).toBe("chotto");
    expect(await romanizeJapanese("こんにちは")).toBe("konnichiwa");
    expect(await romanizeJapanese("図書館")).toBe("toshokan");
    expect(await romanizeJapanese("僕たちは")).toBe("bokutachi wa");
  });

  it("converts longer lines", async () => {
    expect(await romanizeJapanese("あの光は何？")).toBe("ano hikari wa nani?");
    expect(await romanizeJapanese("黄昏の図書館で あちこち探したね")).toBe("tasogare no toshokan de achikochi sagashita ne");
    expect(await romanizeJapanese("星の配置 知りたかった古い天体図")).toBe("hoshi no haichi shiritakatta furui tentaizu");
    expect(await romanizeJapanese("きっと そう僕たちは 太古の時代から")).toBe("kitto sō bokutachi wa taiko no jidai kara");
  });

  it("handles empty and repeated", async () => {
    expect(await romanizeJapanese("")).toBe("");
    expect(await romanizeJapanese("   ")).toBe("");
    const a = await romanizeJapanese("きっと");
    const b = await romanizeJapanese("きっと");
    expect(a).toBe(b);
  });

  it("handles spans", async () => {
    const result = await romanizeJapanese("きっと", ["きっ", "と"]) as { text: string; words: string[] | null };
    expect(result.text).toBe("kitto");
    expect(result.words).toEqual(["kit", "to"]);
  });

  it("handles mixed scripts", async () => {
    expect(await romanizeJapanese("Hello 東京!")).toBe("Hello tōkyō!");
  });

  it("batch", async () => {
    const out = await romanizeJapanese(["きっと", "東京"]);
    expect(out).toEqual(["kitto", "tōkyō"]);
  });
});