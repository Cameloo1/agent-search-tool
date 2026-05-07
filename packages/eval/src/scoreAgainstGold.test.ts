import { describe, expect, it } from "vitest";
import { loadGoldArtifact } from "./questions.js";
import { scoreAgainstGold } from "./scoreAgainstGold.js";

describe("gold scoring", () => {
  it("loads the locked gold artifact", () => {
    const loaded = loadGoldArtifact();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.artifact.questions).toHaveLength(5);
  });

  it("scores claim hits and source coverage", () => {
    const loaded = loadGoldArtifact();
    if (!loaded.ok) throw new Error("gold did not load");
    const gold = loaded.artifact.answers.find((answer) => answer.question_id === "Q5");
    const result = scoreAgainstGold({
      engineName: "test",
      questionId: "Q5",
      finalAnswer:
        "This is a staged pipeline, not just vector search. It uses a common chunk schema, document chunk claim dedup, submodular greedy token budget selection, Bayesian priors and updates, and warns consensus is not truth.",
      sources: [{ url: "https://example.com", title: "paper", source_name: "crossref", source_type: "academic", provenance: "secondary" }],
      tokenCount: 42,
      timeToResultMs: 10,
      gold
    });

    expect(result.score_status).toBe("scored");
    expect(result.facts_hit).toBeGreaterThan(3);
    expect(result.required_source_types_total).toBeGreaterThan(0);
  });
});
