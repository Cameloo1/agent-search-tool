import { describe, expect, it } from "vitest";
import { createMockLLMProvider } from "@agent-search/llm";
import type { NormalizedChunk } from "@agent-search/shared";
import { synthesizeSelectedAnswer } from "./answerSynthesis.js";

describe("answer synthesis", () => {
  it("falls back to a prose answer with inline citations after provider schema failure", async () => {
    const provider = createMockLLMProvider(() => {
      throw new Error("Reasoning is mandatory for this endpoint and cannot be disabled");
    });

    const result = await synthesizeSelectedAnswer(
      { query: "What should the pipeline do?", chunks: [chunk("chunk-a"), chunk("chunk-b")] },
      provider,
      { maxAttempts: 1, timeoutMs: 100 }
    );

    expect(result.synthesized_answer).not.toMatch(/^Synthesized from/i);
    expect(result.synthesized_answer).toContain("[chunk-a]");
    expect(result.synthesized_answer).toContain("[chunk-b]");
    expect(result.synthesized_answer).not.toMatch(/\n\s*1\.\s/);
  });

  it("rejects inventory-shaped model answers even when schema-valid", async () => {
    const provider = createMockLLMProvider([{
      final_answer: "Synthesized from 2 selected evidence chunks:\n\n1. Source: finding\n\n2. Source: finding",
      cited_chunk_ids: ["chunk-a"],
      caveats: []
    }]);

    const result = await synthesizeSelectedAnswer(
      { query: "What should the pipeline do?", chunks: [chunk("chunk-a"), chunk("chunk-b")] },
      provider,
      { maxAttempts: 1 }
    );

    expect(result.synthesized_answer).not.toMatch(/^Synthesized from/i);
    expect(result.warnings.join(" ")).toContain("inventory-shaped answer");
  });

  it("answers comparative trade-off queries directly in deterministic fallback", async () => {
    const provider = createMockLLMProvider(() => {
      throw new Error("Reasoning is mandatory for this endpoint and cannot be disabled");
    });

    const result = await synthesizeSelectedAnswer(
      {
        query: "What are the trade-offs between Reciprocal Rank Fusion and learned cross-encoder reranking in hybrid retrieval pipelines, and which open-source RAG implementations have published benchmarks comparing them?",
        chunks: [
          chunk("rrf", {
            title: "Hybrid Retrieval Comparing Rank Fusion",
            claim: "RRF achieved the best relevance against dense-only and sparse-only baselines."
          }),
          chunk("cross", {
            title: "Scaling Laws for Cross-Encoder Reranking",
            claim: "Cross-encoder reranking quality scales with model size and training exposure."
          }),
          chunk("trec", {
            title: "DS@GT at TREC TOT 2025: Fusion Retrieval and Learned Reranking",
            claim: "A two-stage system combines fusion retrieval with a learned reranker."
          })
        ]
      },
      provider,
      { maxAttempts: 1, timeoutMs: 100 }
    );

    expect(result.synthesized_answer).toContain("RRF is the simpler");
    expect(result.synthesized_answer).toContain("Learned cross-encoder reranking");
    expect(result.synthesized_answer).toContain("does not retain repository/code evidence");
    expect(result.synthesized_answer).toContain("[rrf]");
    expect(result.synthesized_answer).toContain("[cross]");
    expect(result.synthesized_answer).not.toContain("The selected evidence supports this answer");
  });
});

function chunk(id: string, overrides: { title?: string; claim?: string } = {}): NormalizedChunk {
  return {
    id,
    content: `${overrides.claim ?? `${id} says the pipeline should answer directly with cited evidence and preserve caveats.`}`,
    metadata: {
      url: `https://example.com/${id}`,
      source_name: "official_docs",
      source_type: "government",
      title: overrides.title ?? id,
      publish_date: null,
      author: null,
      confidence_score: 0.8,
      summary: null,
      claim_graph: [
        {
          claim: overrides.claim ?? `${id} supports direct cited answers.`,
          claim_type: "asserted",
          supporting_text_offset: [0, 40]
        }
      ],
      epistemic_stance: "primary_source",
      surprise_score: 0.4
    },
    _internal: {
      relevance_to_query: 0.8,
      source_weight: 0.86,
      freshness_fitness: 0.7,
      embedding: []
    }
  };
}
