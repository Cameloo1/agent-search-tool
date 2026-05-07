import { describe, expect, it } from "vitest";
import type { Embedder, LLMProvider, RawItem } from "@agent-search/shared";
import { runPipeline } from "./runPipeline.js";

describe("pipeline pre-ranking", () => {
  it("limits Stage 6 scoring to the pre-ranked chunk cap and records diagnostics", async () => {
    const scoredBatchSizes: number[] = [];
    const provider: LLMProvider = {
      name: "test-provider",
      async generateStructured(input) {
        if (input.schemaName === "IntentObject") {
          return {
            core_intent: "Find official and academic evidence",
            query_type: ["source-attribution"],
            entities: [],
            temporal_constraints: null,
            required_source_types: ["government", "academic"]
          };
        }
        if (input.schemaName === "QueryStrategyResponse") {
          return {
            sub_queries: [
              {
                sub_query: "official academic evidence",
                target_sources: ["official_docs", "openalex"],
                retrieval_intent: "corroborating",
                max_results: 5
              }
            ]
          };
        }
        if (input.schemaName === "ChunkScoringResponse") {
          const chunkIds = Array.isArray(input.metadata?.chunkIds) ? input.metadata.chunkIds.map(String) : [];
          scoredBatchSizes.push(chunkIds.length);
          return {
            scores: chunkIds.map((chunkId) => ({
              chunk_id: chunkId,
              relevance_to_query: 0.8,
              confidence_score: 0.8,
              freshness_fitness: 0.8,
              surprise_score: 0.5,
              claim_graph: [{ claim: `${chunkId} claim`, claim_type: "asserted", supporting_text_offset: [0, 20] }],
              epistemic_stance: "secondary_analysis"
            }))
          };
        }
        return {};
      }
    };

    const response = await runPipeline(
      {
        query: "official academic evidence",
        quality_mode: "fast",
        synthesize_answer: false,
        token_budget: 800
      },
      {
        llmProvider: provider,
        mockRawItems: rawItems(24),
        embedder: mockEmbedder,
        prerankMaxLlmChunks: 5,
        maxRepairRounds: 0
      }
    );

    expect(scoredBatchSizes.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(5);
    expect(response.trace.pre_rank[0]?.selected_for_llm_count).toBeLessThanOrEqual(5);
    expect(response.trace.pre_rank[0]?.input_chunk_count).toBeGreaterThan(5);
  });
});

const mockEmbedder: Embedder = {
  name: "mock",
  async embed(texts) {
    return texts.map((text, index) => [text.length / 1000, index / 100]);
  }
};

function rawItems(count: number): RawItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `raw:${index}`,
    source: index % 2 === 0 ? "official_docs" : "openalex",
    source_type: index % 2 === 0 ? "government" : "academic",
    url: `https://example.com/evidence/${index}`,
    title: `Evidence ${index}`,
    author: null,
    publish_date: new Date().toISOString(),
    text: `Official academic evidence item ${index}. It discusses source attribution, public evidence, and market infrastructure.`,
    summary: null,
    metadata: {}
  }));
}
