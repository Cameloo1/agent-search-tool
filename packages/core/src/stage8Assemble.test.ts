import { describe, expect, it } from "vitest";
import type { IntentObject, NormalizedChunk } from "@agent-search/shared";
import { assembleFinalChunks } from "./stage8Assemble.js";

function chunk(id: string, content: string, sourceType: NormalizedChunk["metadata"]["source_type"], relevance: number): NormalizedChunk {
  return {
    id,
    content,
    metadata: {
      url: `https://example.com/${id}`,
      source_name: sourceType === "filing" ? "sec_edgar" : "wikipedia",
      source_type: sourceType,
      title: id,
      publish_date: null,
      author: null,
      confidence_score: 0.9,
      summary: null,
      claim_graph: [{ claim: content, claim_type: "asserted", supporting_text_offset: [0, content.length] }],
      epistemic_stance: sourceType === "filing" ? "primary_source" : "tertiary_summary",
      surprise_score: 0.7
    },
    _internal: {
      relevance_to_query: relevance,
      source_weight: sourceType === "filing" ? 0.98 : 0.72,
      freshness_fitness: 0.8,
      embedding: []
    }
  };
}

const intent: IntentObject = {
  core_intent: "source attribution",
  query_type: ["source-attribution", "adversarial"],
  entities: [],
  temporal_constraints: null,
  required_source_types: ["filing"]
};

describe("stage 8 assembler", () => {
  it("selects chunks under budget and records rejection reasons", () => {
    const result = assembleFinalChunks(
      [
        chunk("primary", "SEC filing primary evidence.", "filing", 0.9),
        chunk("long", Array.from({ length: 200 }, () => "background").join(" "), "encyclopedic", 0.7)
      ],
      intent,
      20
    );

    expect(result.chunks.map((c) => c.id)).toContain("primary");
    expect(result.selection.estimated_tokens_used).toBeLessThanOrEqual(20);
    expect(result.selection.rejected_chunk_ids).toContain("long");
  });

  it("reserves budget for required source-type coverage", () => {
    const result = assembleFinalChunks(
      [
        chunk("academic-a", "Academic oil price model.", "academic", 0.95),
        chunk("academic-b", "Another academic oil price model.", "academic", 0.94),
        chunk("government", "Official government oil price data.", "government", 0.5),
        chunk("wiki", "Crude oil benchmark background.", "encyclopedic", 0.48)
      ],
      {
        core_intent: "oil forecast",
        query_type: ["fresh-fact", "multi-hop"],
        entities: [],
        temporal_constraints: "current",
        required_source_types: ["government", "academic", "encyclopedic"]
      },
      120
    );

    const sourceTypes = result.chunks.map((selected) => selected.metadata.source_type);
    expect(sourceTypes).toContain("government");
    expect(sourceTypes).toContain("academic");
    expect(sourceTypes).toContain("encyclopedic");
  });

  it("does not select a required source-type chunk with near-zero contextual relevance", () => {
    const result = assembleFinalChunks(
      [
        chunk("about-author", "About the author biography.", "filing", 0.01),
        chunk("useful", "Useful secondary market-structure evidence.", "academic", 0.75)
      ],
      intent,
      120
    );

    expect(result.chunks.map((selected) => selected.id)).not.toContain("about-author");
    expect(result.selection.rejected_chunk_ids).toContain("about-author");
  });

  it("uses explicit deterministic tie-breaks and records final marginal gains", () => {
    const result = assembleFinalChunks(
      [
        chunk("b", "Same topic evidence.", "academic", 0.6),
        chunk("a", "Same topic evidence.", "academic", 0.6)
      ],
      {
        core_intent: "tie break",
        query_type: ["multi-hop"],
        entities: [],
        temporal_constraints: null,
        required_source_types: []
      },
      4
    );

    expect(result.selection.selected_chunk_ids).toEqual(["a"]);
    expect(result.selection.rejected_chunk_ids).toContain("b");
    expect(Object.keys(result.selection.final_marginal_gains).sort()).toEqual(["a", "b"]);
    expect(result.selection.final_marginal_gains.a).toBeGreaterThan(result.selection.final_marginal_gains.b);
  });

  it("clamps embedding novelty so anti-correlated chunks are not over-rewarded", () => {
    const first = chunk("first", "First academic evidence.", "academic", 0.9);
    const second = chunk("second", "Second academic evidence.", "academic", 0.8);
    first._internal.embedding = [1, 0];
    second._internal.embedding = [-1, 0];

    const result = assembleFinalChunks(
      [first, second],
      {
        core_intent: "novelty clamp",
        query_type: ["multi-hop"],
        entities: [],
        temporal_constraints: null,
        required_source_types: []
      },
      120
    );

    expect(result.selection.selected_chunk_ids).toEqual(["first", "second"]);
    expect(result.selection.final_marginal_gains.second).toBeLessThanOrEqual(0.5991);
  });
});
