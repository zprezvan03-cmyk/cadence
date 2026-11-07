import { describe, expect, it } from "vitest";
import { flattenTimedRomanizationBatch, groupTimedRomanizationResults } from "../../src/main/lyrics/timedRomanization";

describe("timed romanization batch mapping", () => {
  it("flattens original timed spans with stable IDs and full-line context, without timestamps", () => {
    const timedLines = [{ lineIndex: 0, lineId: "line-4", lineText: "桜の花", spans: ["桜", "の花"] }];
    const batch = flattenTimedRomanizationBatch(["桜の花", "空"], ["line-4", "line-5"], timedLines);
    expect(batch.flatLines).toEqual(["桜", "の花", "空"]);
    expect(batch.flatIds).toEqual(["line-4-span-0", "line-4-span-1", "line-5"]);
    expect(batch.promptTimedLines).toEqual([{
      lineId: "line-4",
      lineText: "桜の花",
      spans: [{ id: "line-4-span-0", text: "桜" }, { id: "line-4-span-1", text: "の花" }],
    }]);
    expect(JSON.stringify(batch)).not.toMatch(/startTime|duration|timestamp/i);
  });

  it("groups mocked AI results back to their original line/span positions", () => {
    const timedLines = [{ lineIndex: 1, lineId: "line-8", lineText: "月明かりの夜", spans: ["月明かり", "の夜"] }];
    const batch = flattenTimedRomanizationBatch(["plain Latin", "月明かりの夜", "next"], undefined, timedLines);
    const grouped = groupTimedRomanizationResults(["plain Latin", "tsukiakari", "no yoru", "next romanized"], batch.positions, timedLines);
    expect(grouped.romanizations).toEqual(["plain Latin", "tsukiakari no yoru", "next romanized"]);
    expect(grouped.timedRomanizations).toEqual([null, ["tsukiakari", "no yoru"], null]);
  });

  it("does not claim a timed result when a flattened span response is incomplete", () => {
    const timedLines = [{ lineIndex: 0, lineId: "line-0", lineText: "桜の花", spans: ["桜", "の花"] }];
    const batch = flattenTimedRomanizationBatch(["桜の花"], undefined, timedLines);
    const grouped = groupTimedRomanizationResults(["sakura"], batch.positions, timedLines);
    expect(grouped.timedRomanizations).toEqual([null]);
    expect(grouped.romanizations).toEqual(["sakura"]);
  });
});
