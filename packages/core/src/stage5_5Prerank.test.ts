import { describe, expect, it } from "vitest";
import type { IntentObject, NormalizedChunk } from "@agent-search/shared";
import { preRankChunks } from "./stage5_5Prerank.js";

describe("stage 5.5 pre-ranker", () => {
  it("deduplicates exact canonical URL matches before LLM scoring", () => {
    const result = preRankChunks(
      [
        chunk("a", "https://example.com/report?utm=1", "official SEC direct feed co-location evidence", "government", "official_docs"),
        chunk("b", "https://example.com/report#section", "official SEC direct feed co-location evidence", "government", "official_docs"),
        chunk("c", "https://example.com/other", "macro release calendar evidence", "government", "data_gov")
      ],
      "SEC direct feeds co-location macro release calendar",
      intent,
      { maxLlmChunks: 10, roundIndex: 0, broadeningLevel: 0 }
    );

    expect(result.diagnostics.duplicate_group_count).toBe(1);
    expect(result.diagnostics.duplicate_rejected_count).toBe(1);
    expect(result.chunks.map((item) => item.id)).not.toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("preserves required source type coverage inside the LLM cap", () => {
    const result = preRankChunks(
      [
        chunk("government", "https://example.com/gov", "official government evidence", "government", "official_docs"),
        chunk("academic", "https://example.com/paper", "academic literature evidence", "academic", "openalex"),
        chunk("forum", "https://example.com/forum", "discussion only", "forum", "stack_exchange")
      ],
      "official academic evidence",
      { ...intent, required_source_types: ["government", "academic"] },
      { maxLlmChunks: 2, roundIndex: 1, broadeningLevel: 1, unavailableSourcesSkipped: ["sec_edgar"] }
    );

    expect(result.chunks.map((item) => item.id).sort()).toEqual(["academic", "government"]);
    expect(result.diagnostics.selected_for_llm_count).toBe(2);
    expect(result.diagnostics.unavailable_sources_skipped).toEqual(["sec_edgar"]);
  });
});

const intent: IntentObject = {
  core_intent: "market news speed",
  query_type: ["source-attribution", "adversarial"],
  entities: [],
  temporal_constraints: null,
  required_source_types: ["government"]
};

function chunk(
  id: string,
  url: string,
  content: string,
  sourceType: NormalizedChunk["metadata"]["source_type"],
  sourceName: NormalizedChunk["metadata"]["source_name"]
): NormalizedChunk {
  return {
    id,
    content,
    metadata: {
      url,
      source_name: sourceName,
      source_type: sourceType,
      title: id,
      publish_date: new Date().toISOString(),
      author: null,
      confidence_score: 0.7,
      summary: null,
      claim_graph: [],
      epistemic_stance: sourceType === "government" ? "primary_source" : "secondary_analysis",
      surprise_score: 0.5
    },
    _internal: {
      relevance_to_query: 0.5,
      source_weight: 0.8,
      freshness_fitness: 0.8,
      embedding: []
    }
  };
}
