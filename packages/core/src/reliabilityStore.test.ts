import { describe, expect, it } from "vitest";
import type { NormalizedChunk } from "@agent-search/shared";
import { InMemoryReliabilityStore, applyReliabilityScores, observeSelectedChunks } from "./reliabilityStore.js";

describe("Bayesian source reliability store", () => {
  it("initializes with deterministic source-type priors and updates from observations", async () => {
    const store = new InMemoryReliabilityStore();
    await store.initialize();

    const prior = await store.getRecord("sec_edgar", "markets_macro", 0.95);
    expect(prior.score).toBeCloseTo(0.95, 2);

    const contradicted = await store.update("sec_edgar", "markets_macro", "contradicted", 0.95);
    expect(contradicted.score).toBeLessThan(prior.score);
  });

  it("adjusts chunk source weights without replacing relevance scores", async () => {
    const store = new InMemoryReliabilityStore();
    await store.initialize();
    await store.update("github", "technical_retrieval", "confirmed", 0.78);

    const [adjusted] = await applyReliabilityScores([chunk("github", "code")], store, "technical_retrieval");

    expect(adjusted._internal.relevance_to_query).toBe(0.8);
    expect(adjusted._internal.source_weight).toBeGreaterThan(0.7);
  });

  it("records selected chunks as reliability observations", async () => {
    const store = new InMemoryReliabilityStore();
    await store.initialize();

    await observeSelectedChunks([chunk("wikipedia", "encyclopedic")], store, "general", "observed");
    const record = await store.getRecord("wikipedia", "general", 0.58);

    expect(record.observations).toBe(1);
  });
});

function chunk(sourceName: "github" | "wikipedia", sourceType: "code" | "encyclopedic"): NormalizedChunk {
  return {
    id: `${sourceName}:1`,
    content: "A source chunk with claims.",
    metadata: {
      url: `https://example.com/${sourceName}`,
      source_name: sourceName,
      source_type: sourceType,
      title: sourceName,
      publish_date: null,
      author: null,
      confidence_score: 0.8,
      summary: null,
      claim_graph: [{ claim: "A source chunk has a claim.", claim_type: "asserted", supporting_text_offset: [0, 20] }],
      epistemic_stance: "secondary_analysis",
      surprise_score: 0.5
    },
    _internal: {
      relevance_to_query: 0.8,
      source_weight: 0.7,
      freshness_fitness: 0.8,
      embedding: []
    }
  };
}
