import { describe, expect, it } from "vitest";
import { canonicalBenchmarkText, createLoadingResults, questionIdFromQuery } from "./api";

describe("benchmark question UI normalization", () => {
  it("maps smart-punctuation benchmark text to the locked question id", () => {
    const q1 =
      "What\u2019s gonna happen if we keep spending more and more money on debt? How can we approach fixing this, and how is AI poised to help exactly? What is it currently doing that\u2019s pushing us towards this?";

    expect(questionIdFromQuery(q1)).toBe("Q1");
    expect(createLoadingResults(q1)[0]?.question_id).toBe("Q1");
  });

  it("maps ASCII-normalized benchmark text to the same locked question id", () => {
    const q4 =
      "To match and beat top traders, I want to learn about how institutions and banks get news updates fast and quick to gain a competitive edge over other traders in markets? I'd like to know about their strategies and infrastructure so that I can research more about this.";

    expect(questionIdFromQuery(q4)).toBe("Q4");
    expect(createLoadingResults(q4)[1]?.question_id).toBe("Q4");
  });

  it("canonicalizes smart and ASCII punctuation equivalently without changing arbitrary text into a benchmark", () => {
    expect(canonicalBenchmarkText("What\u2019s next?")).toBe(canonicalBenchmarkText("What's next?"));
    expect(questionIdFromQuery("What's next?")).toBe("ad-hoc");
  });
});
