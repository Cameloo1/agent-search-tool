import { afterEach, describe, expect, it } from "vitest";
import { createMockLLMProvider } from "@agent-search/llm";
import type { IntentObject, NormalizedChunk } from "@agent-search/shared";
import { clearStage6ScoringCache, scoreChunks } from "./stage6Score.js";

describe("stage 6 scoring", () => {
  afterEach(() => {
    clearStage6ScoringCache();
  });

  it("uses visible fallback scoring without filtering every chunk when LLM output is invalid", async () => {
    const result = await scoreChunks(
      [chunk("a"), chunk("b")],
      { query: "claim level evidence deduplication token budget pipeline" },
      intent,
      createMockLLMProvider([{ scores: [{ chunk_id: "missing" }] }, { scores: [{ chunk_id: "missing" }] }]),
      { maxAttempts: 2, scoringThreshold: 0.2 }
    );

    expect(result.errors[0]?.code).toBe("LLM_SCHEMA_INVALID");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]?._internal.relevance_to_query).toBeGreaterThan(0.5);
  });

  it("does not rescue near-zero contextual matches when valid LLM scores are all below threshold", async () => {
    const result = await scoreChunks(
      [chunk("a"), chunk("b"), chunk("c"), chunk("d"), chunk("e")],
      { query: "oil prices supply demand forecast" },
      intent,
      createMockLLMProvider({
        scores: ["a", "b", "c", "d", "e"].map((chunkId) => ({
          chunk_id: chunkId,
          relevance_to_query: 0.1,
          confidence_score: 0.1,
          freshness_fitness: 0.1,
          surprise_score: 0.1,
          claim_graph: [{ claim: `${chunkId} weak claim`, claim_type: "asserted", supporting_text_offset: [0, 12] }],
          epistemic_stance: "secondary_analysis"
        }))
      }),
      { scoringThreshold: 0.9 }
    );

    expect(result.chunks).toHaveLength(0);
    expect(result.filteredOut).toHaveLength(5);
    expect(result.warnings.join(" ")).toContain("near-zero contextual relevance");
  });

  it("scores batches with bounded parallelism and records diagnostics deterministically", async () => {
    let active = 0;
    let maxActive = 0;
    const provider = createMockLLMProvider(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      const chunkIds = Array.isArray(input.metadata?.chunkIds) ? input.metadata.chunkIds.map(String) : [];
      return {
        scores: chunkIds.map((chunkId) => ({
          chunk_id: chunkId,
          relevance_to_query: 0.8,
          confidence_score: 0.8,
          freshness_fitness: 0.8,
          surprise_score: 0.5,
          claim_graph: [{ claim: `${chunkId} relevant claim`, claim_type: "asserted", supporting_text_offset: [0, 12] }],
          epistemic_stance: "secondary_analysis"
        }))
      };
    });

    const result = await scoreChunks(
      [chunk("a"), chunk("b"), chunk("c"), chunk("d")],
      { query: "claim level evidence deduplication token budget pipeline" },
      intent,
      provider,
      { batchSize: 1, scoringConcurrency: 2, scoringThreshold: 0.1 }
    );

    expect(maxActive).toBe(2);
    expect(provider.calls).toHaveLength(4);
    expect(result.chunks.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.diagnostics).toHaveLength(4);
    expect(result.diagnostics.every((diagnostic) => diagnostic.concurrency === 2)).toBe(true);
    expect(result.structuredLlmCalls).toHaveLength(4);
  });

  it("reuses cached scores for repeated chunk content", async () => {
    const provider = createMockLLMProvider(async (input) => {
      const chunkIds = Array.isArray(input.metadata?.chunkIds) ? input.metadata.chunkIds.map(String) : [];
      return {
        scores: chunkIds.map((chunkId) => ({
          chunk_id: chunkId,
          relevance_to_query: 0.8,
          confidence_score: 0.8,
          freshness_fitness: 0.8,
          surprise_score: 0.5,
          claim_graph: [{ claim: `${chunkId} cached claim`, claim_type: "asserted", supporting_text_offset: [0, 12] }],
          epistemic_stance: "secondary_analysis"
        }))
      };
    });

    await scoreChunks([chunk("cache-a")], { query: "claim level evidence deduplication token budget pipeline" }, intent, provider, {
      scoringThreshold: 0.1
    });
    const repeated = await scoreChunks([chunk("cache-a")], { query: "claim level evidence deduplication token budget pipeline" }, intent, provider, {
      scoringThreshold: 0.1
    });

    expect(provider.calls).toHaveLength(1);
    expect(repeated.diagnostics[0]?.cache_hit_count).toBe(1);
    expect(repeated.structuredLlmCalls).toHaveLength(0);
  });

  it("caps metadata-only extraction so it cannot support detailed claims", async () => {
    const result = await scoreChunks(
      [
        chunk("metadata-only", {
          extraction_status: "metadata_only",
          extraction_confidence: 0.1,
          content_coverage: 0
        })
      ],
      { query: "claim level evidence deduplication token budget pipeline" },
      intent,
      createMockLLMProvider({
        scores: [
          {
            chunk_id: "metadata-only",
            relevance_to_query: 1,
            confidence_score: 1,
            freshness_fitness: 1,
            surprise_score: 0.5,
            claim_graph: [{ claim: "Unsupported detailed claim.", claim_type: "asserted", supporting_text_offset: [0, 12] }],
            epistemic_stance: "secondary_analysis"
          }
        ]
      }),
      { scoringThreshold: 0.01 }
    );

    const scored = result.chunks[0] ?? result.filteredOut[0];
    expect(scored?.metadata.confidence_score).toBeLessThanOrEqual(0.15);
    expect(scored?.metadata.claim_graph).toHaveLength(0);
    expect(scored?._internal.relevance_to_query).toBeLessThanOrEqual(0.12);
  });
});

const intent: IntentObject = {
  core_intent: "Build a deduplication pipeline",
  query_type: ["dedup-prone", "source-attribution"],
  entities: [],
  temporal_constraints: null,
  required_source_types: ["academic", "code"]
};

function chunk(
  id: string,
  extraction?: {
    extraction_status: NonNullable<NormalizedChunk["metadata"]["extraction"]>["extraction_status"];
    extraction_confidence: number;
    content_coverage: number;
  }
): NormalizedChunk {
  return {
    id,
    content: "Claim level evidence helps a deduplication pipeline assemble token budgeted retrieval context.",
    metadata: {
      url: `https://example.com/${id}`,
      source_name: "openalex",
      source_type: "academic",
      title: id,
      publish_date: null,
      author: null,
      confidence_score: 0.5,
      summary: null,
      claim_graph: [],
      epistemic_stance: "secondary_analysis",
      surprise_score: 0.5,
      extraction: extraction
        ? {
            canonical_url: `https://example.com/${id}`,
            document_type: "html",
            retrieval_method: "metadata",
            extraction_method: "metadata_only",
            extraction_status: extraction.extraction_status,
            extraction_confidence: extraction.extraction_confidence,
            content_coverage: extraction.content_coverage,
            section_path: [],
            attempts: []
          }
        : undefined
    },
    _internal: {
      relevance_to_query: 0.5,
      source_weight: 0.78,
      freshness_fitness: 0.5,
      embedding: []
    }
  };
}
