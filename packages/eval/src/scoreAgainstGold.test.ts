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
    const gold = goldAnswer("Q5");
    const result = scoreAgainstGold({
      engineName: "test",
      questionId: "Q5",
      finalAnswer:
        "This is a staged pipeline, not just vector search. It must normalize sources into a common chunk schema. It deduplicates at document, chunk, and claim level using canonicalization, embeddings, and claim overlap. Submodular greedy token budget coverage selection uses Bayesian priors and updates, and warns consensus is not truth.",
      sources: [
        {
          url: "https://example.com/submodular-summarization",
          title: "Submodular optimization for summarization literature",
          source_name: "crossref",
          source_type: "academic",
          provenance: "secondary"
        }
      ],
      tokenCount: 42,
      timeToResultMs: 10,
      gold
    });

    expect(result.score_status).toBe("scored");
    expect(result.facts_hit).toBeGreaterThanOrEqual(6);
    expect(result.required_source_types_hit).toBe(1);
    expect(result.required_source_types_total).toBe(4);
    expect(result.notes.join(" ")).toContain("Strict deterministic gold precheck");
  });

  it("does not award an atomic fact for one shared keyword", () => {
    const result = scoreAgainstGold({
      engineName: "test",
      questionId: "Q1",
      finalAnswer: "Deficits are a fiscal concern, but this answer does not cite official projections or net interest costs.",
      sources: [],
      tokenCount: 10,
      timeToResultMs: 5,
      gold: goldAnswer("Q1")
    });

    expect(result.facts_hit).toBe(0);
  });

  it("does not let one generic primary source satisfy unrelated required-source descriptors", () => {
    const result = scoreAgainstGold({
      engineName: "test",
      questionId: "Q4",
      finalAnswer: "SEC EDGAR contains public filings and the SEC publishes access guidance.",
      sources: [
        {
          url: "https://www.sec.gov/os/accessing-edgar-data",
          title: "SEC EDGAR Access Guidance",
          source_name: "official_docs",
          source_type: "government",
          provenance: "primary"
        }
      ],
      tokenCount: 20,
      timeToResultMs: 5,
      gold: goldAnswer("Q4")
    });

    expect(result.primary_source_count).toBe(1);
    expect(result.required_source_types_hit).toBe(1);
    expect(result.required_source_types_total).toBe(4);
  });

  it("requires distinct descriptor-matched sources for repeated required source types", () => {
    const result = scoreAgainstGold({
      engineName: "test",
      questionId: "Q1",
      finalAnswer:
        "Rising debt creates net interest cost pressure, while inflation mechanics depend on monetary policy and capacity. AI also raises energy and grid demand.",
      sources: [
        {
          url: "https://www.cbo.gov/publication/long-term-budget-outlook",
          title: "CBO long-term budget projections and net interest costs",
          source_name: "official_docs",
          source_type: "government",
          provenance: "primary"
        },
        {
          url: "https://fiscaldata.treasury.gov/datasets/interest-expense-debt-outstanding",
          title: "Treasury interest cost data from Fiscal Data",
          source_name: "data_gov",
          source_type: "government",
          provenance: "primary"
        },
        {
          url: "https://www.iea.org/reports/energy-and-ai",
          title: "IEA data center energy and grid demand report",
          source_name: "official_docs",
          source_type: "government",
          provenance: "primary"
        },
        {
          url: "https://www.federalreserve.gov/econres/debt-inflation-mechanics.htm",
          title: "Federal Reserve macroeconomic source for inflation and debt mechanics",
          source_name: "official_docs",
          source_type: "academic",
          provenance: "primary"
        }
      ],
      tokenCount: 80,
      timeToResultMs: 20,
      gold: goldAnswer("Q1")
    });

    expect(result.required_source_types_hit).toBe(4);
  });
});

function goldAnswer(questionId: string) {
  const loaded = loadGoldArtifact();
  if (!loaded.ok) throw new Error("gold did not load");
  const gold = loaded.artifact.answers.find((answer) => answer.question_id === questionId);
  if (!gold) throw new Error(`missing gold answer ${questionId}`);
  return gold;
}
