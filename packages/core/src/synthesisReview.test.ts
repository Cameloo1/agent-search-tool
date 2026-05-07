import { describe, expect, it } from "vitest";
import { createMockLLMProvider } from "@agent-search/llm";
import type { EvidenceHealth, GapAnalysis, NormalizedChunk } from "@agent-search/shared";
import { reviewSynthesizedAnswer } from "./synthesisReview.js";

describe("synthesis review", () => {
  it("normalizes common reviewer schema aliases and string arrays", async () => {
    const provider = createMockLLMProvider([{
      coverage_status: "complete",
      final_answer: "Reviewed answer [chunk-1].",
      addressed_questions: "main question",
      remaining_gaps: "",
      unsupported_or_weak_claims: "weak unsourced macro claim",
      source_backed_claims: "source backed claim",
      model_prior_notes: "general reasoning note",
      keyword_context_warnings: "",
      cited_chunk_ids: "chunk-1"
    }]);

    const result = await reviewSynthesizedAnswer(
      {
        query: "How should I use LLMs for AppSec?",
        draftAnswer: "Draft answer.",
        chunks: [chunk("chunk-1")],
        evidenceHealth: evidenceHealth,
        gapAnalysis
      },
      provider
    );

    expect(result.warnings).toHaveLength(0);
    expect(result.review.coverage_status).toBe("answered");
    expect(result.review.addressed_questions).toEqual(["main question"]);
    expect(result.review.cited_chunk_ids).toEqual(["chunk-1"]);
    expect(result.structuredLlmCalls[0]?.ok).toBe(true);
  });

  it("uses a compact reviewer prompt instead of full chunk bodies", async () => {
    const longContent = "FULL_BODY_SENTINEL ".repeat(120);
    const provider = createMockLLMProvider([{
      final_answer: "Reviewed answer [chunk-1].",
      coverage_status: "answered",
      cited_chunk_ids: ["chunk-1"]
    }]);

    await reviewSynthesizedAnswer(
      {
        query: "How should I use LLMs for AppSec?",
        draftAnswer: "Draft answer.",
        chunks: [{ ...chunk("chunk-1"), content: longContent }],
        evidenceHealth,
        gapAnalysis
      },
      provider
    );

    const prompt = provider.calls[0]?.prompt ?? "";
    expect(prompt.length).toBeLessThan(7000);
    expect(prompt).not.toContain(longContent);
    expect(prompt).toContain("content_preview");
  });

  it("preserves the draft answer when reviewer omits final_answer", async () => {
    const provider = createMockLLMProvider([{
      coverage_status: "answered",
      addressed_questions: ["main question"],
      cited_chunk_ids: ["chunk-1"]
    }]);

    const result = await reviewSynthesizedAnswer(
      {
        query: "How should I use LLMs for AppSec?",
        draftAnswer: "Draft answer to preserve.",
        chunks: [chunk("chunk-1")],
        evidenceHealth,
        gapAnalysis
      },
      provider,
      { maxAttempts: 1, timeoutMs: 12_000, reasoningEnabled: true }
    );

    expect(result.review.final_answer).toBe("Draft answer to preserve.");
    expect(result.warnings).toHaveLength(0);
    expect(result.structuredLlmCalls[0]?.reasoning_enabled).toBe(true);
  });
});

const evidenceHealth: EvidenceHealth = {
  status: "adequate",
  evidence_quality_score: 70,
  evidence_coverage_score: 70,
  components: {
    relevance_confidence: 75,
    source_authority: 75,
    coverage_diversity: 65,
    freshness_failure: 60
  },
  reasons: [],
  warnings: [],
  details: {
    selected_chunk_count: 1,
    selected_claim_count: 1,
    distinct_source_count: 1,
    distinct_source_type_count: 1,
    primary_source_count: 1,
    failed_important_source_count: 0,
    failed_source_count: 0,
    degraded_extraction_count: 0,
    metadata_only_count: 0,
    failed_extraction_count: 0,
    average_relevance: 0.8,
    average_confidence: 0.8,
    average_source_weight: 0.8,
    average_freshness: 0.8,
    non_redundancy: 1,
    matched_required_source_types: ["primary-document"],
    missing_required_source_types: [],
    failed_important_sources: []
  }
};

const gapAnalysis: GapAnalysis = {
  status: "no_retry",
  should_retry: false,
  should_synthesize_cautiously: false,
  missing_facets: [],
  source_type_gaps: [],
  hard_source_type_gaps: [],
  soft_source_type_gaps: [],
  bad_context_reasons: [],
  keyword_only_chunk_ids: [],
  important_failed_sources: [],
  recommended_sub_queries: [],
  reasons: []
};

function chunk(id: string): NormalizedChunk {
  return {
    id,
    content: "OWASP ASVS authorization verification supports pre-production security release gates.",
    metadata: {
      url: `https://example.com/${id}`,
      source_name: "official_docs",
      source_type: "other",
      title: "OWASP ASVS",
      publish_date: null,
      author: null,
      confidence_score: 0.8,
      summary: null,
      claim_graph: [{ claim: "OWASP ASVS supports verification requirements.", claim_type: "asserted", supporting_text_offset: [0, 56] }],
      epistemic_stance: "primary_source",
      surprise_score: 0.4
    },
    _internal: {
      relevance_to_query: 0.8,
      source_weight: 0.8,
      freshness_fitness: 0.7,
      embedding: []
    }
  };
}
