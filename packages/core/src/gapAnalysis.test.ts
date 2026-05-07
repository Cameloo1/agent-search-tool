import { describe, expect, it } from "vitest";
import type { EvidenceHealth, IntentObject, NormalizedChunk } from "@agent-search/shared";
import { analyzeEvidenceGaps } from "./gapAnalysis.js";

describe("gap analysis", () => {
  it("triggers targeted repair for trading/news-speed questions with bad selected context", () => {
    const gap = analyzeEvidenceGaps({
      query: "How do institutions and banks get news updates fast to gain trading edge?",
      intent: {
        ...baseIntent,
        query_type: ["source-attribution", "adversarial"],
        required_source_types: ["primary-document", "government", "academic"]
      },
      selectedChunks: [chunk("bad", "About the Author", "About the author biography.", 0)],
      filteredChunks: [],
      sourceResults: {},
      evidenceHealth: health("insufficient", 0.05),
      roundIndex: 0,
      maxRepairRounds: 2
    });

    expect(gap.should_retry).toBe(true);
    expect(gap.recommended_sub_queries.some((query) => query.target_sources.includes("official_docs"))).toBe(true);
    expect(gap.reasons.join(" ")).toContain("near-zero");
  });

  it("does not loop when evidence is adequate and context is relevant", () => {
    const gap = analyzeEvidenceGaps({
      query: "How can I build a deduplication and submodular assembly pipeline?",
      intent: baseIntent,
      selectedChunks: [
        chunk(
          "good",
          "Submodular pipeline",
          "Claim-level duplication, information-theoretic KL and Jensen divergence, submodular greedy coverage, and Bayesian truth discovery source reliability evidence.",
          0.8
        )
      ],
      filteredChunks: [],
      sourceResults: {},
      evidenceHealth: health("adequate", 0.8),
      roundIndex: 0,
      maxRepairRounds: 2
    });

    expect(gap.should_retry).toBe(false);
    expect(gap.status).toBe("no_retry");
  });

  it("uses RRF/cross-encoder facets instead of internal architecture facets for reranking questions", () => {
    const gap = analyzeEvidenceGaps({
      query:
        "What are the trade-offs between Reciprocal Rank Fusion and learned cross-encoder reranking in hybrid retrieval pipelines, and which open-source RAG implementations have published benchmarks comparing them?",
      intent: {
        ...baseIntent,
        query_type: ["multi-hop", "academic", "source-attribution"],
        required_source_types: ["academic", "code"]
      },
      selectedChunks: [
        chunk(
          "rrf-cross",
          "RRF and cross-encoder RAG benchmark",
          "Reciprocal Rank Fusion (RRF) combines hybrid retrieval rankings with low latency, while learned cross-encoder reranking can improve precision at higher compute cost. Open-source RAG benchmark evidence appears in GitHub-linked implementations and published benchmark papers.",
          0.82
        )
      ],
      filteredChunks: [],
      sourceResults: {},
      evidenceHealth: health("adequate", 0.82, {
        matched: ["academic", "code"],
        missing: []
      }),
      roundIndex: 0,
      maxRepairRounds: 2
    });

    expect(gap.missing_facets).not.toContain("claim-level duplication");
    expect(gap.missing_facets).not.toContain("submodular selection");
    expect(gap.missing_facets).not.toContain("Bayesian reliability");
    expect(gap.should_retry).toBe(false);
    expect(gap.status).toBe("no_retry");
  });

  it("treats missing AppSec code and encyclopedic source types as soft gaps when official evidence is adequate", () => {
    const gap = analyzeEvidenceGaps({
      query: "How to use LLMs for AppSec and pre-production testing the correct way?",
      intent: {
        ...baseIntent,
        query_type: ["source-attribution", "adversarial"],
        required_source_types: ["academic", "primary-document", "code", "encyclopedic"]
      },
      selectedChunks: [
        {
          ...chunk(
            "owasp",
            "OWASP ASVS",
            "OWASP ASVS authorization verification and release gate evidence for appsec testing.",
            0.82
          ),
          metadata: {
            ...chunk("owasp", "OWASP ASVS", "OWASP ASVS authorization verification.", 0.82).metadata,
            source_name: "official_docs",
            source_type: "other",
            epistemic_stance: "primary_source"
          }
        }
      ],
      filteredChunks: [],
      sourceResults: {},
      evidenceHealth: health("adequate", 0.82, {
        matched: ["academic", "primary-document"],
        missing: ["code", "encyclopedic"],
        primarySourceCount: 1,
        distinctSourceCount: 2
      }),
      roundIndex: 0,
      maxRepairRounds: 4
    });

    expect(gap.should_retry).toBe(false);
    expect(gap.status).toBe("no_retry");
    expect(gap.stop_reason).toBe("adequate_with_soft_gaps");
    expect(gap.soft_source_type_gaps).toEqual(["code", "encyclopedic"]);
    expect(gap.hard_source_type_gaps).toHaveLength(0);
  });

  it("keeps missing government evidence as a hard gap for fresh source-attribution questions", () => {
    const gap = analyzeEvidenceGaps({
      query: "When will oil prices come down according to official forecasts?",
      intent: {
        ...baseIntent,
        query_type: ["fresh-fact", "source-attribution"],
        required_source_types: ["government", "academic"]
      },
      selectedChunks: [chunk("paper", "Oil price paper", "Academic evidence discusses crude oil supply demand forecast mechanisms.", 0.76)],
      filteredChunks: [],
      sourceResults: {},
      evidenceHealth: health("adequate", 0.76, {
        matched: ["academic"],
        missing: ["government"]
      }),
      roundIndex: 0,
      maxRepairRounds: 4
    });

    expect(gap.should_retry).toBe(true);
    expect(gap.hard_source_type_gaps).toEqual(["government"]);
    expect(gap.recommended_sub_queries.some((query) => query.target_sources.includes("data_gov"))).toBe(true);
  });
});

const baseIntent: IntentObject = {
  core_intent: "answer",
  query_type: ["multi-hop"],
  entities: [],
  temporal_constraints: null,
  required_source_types: []
};

function health(
  status: EvidenceHealth["status"],
  relevance: number,
  overrides: {
    matched?: EvidenceHealth["details"]["matched_required_source_types"];
    missing?: EvidenceHealth["details"]["missing_required_source_types"];
    primarySourceCount?: number;
    distinctSourceCount?: number;
  } = {}
): EvidenceHealth {
  return {
    status,
    evidence_quality_score: status === "adequate" ? 70 : 20,
    evidence_coverage_score: status === "adequate" ? 70 : 20,
    components: {
      relevance_confidence: relevance * 100,
      source_authority: 60,
      coverage_diversity: 50,
      freshness_failure: 50
    },
    reasons: [],
    warnings: [],
    details: {
      selected_chunk_count: 1,
      selected_claim_count: 1,
      distinct_source_count: overrides.distinctSourceCount ?? 1,
      distinct_source_type_count: 1,
      primary_source_count: overrides.primarySourceCount ?? 0,
      failed_important_source_count: 0,
      failed_source_count: 0,
      degraded_extraction_count: 0,
      metadata_only_count: 0,
      failed_extraction_count: 0,
      average_relevance: relevance,
      average_confidence: 0.7,
      average_source_weight: 0.7,
      average_freshness: 0.7,
      non_redundancy: 1,
      matched_required_source_types: overrides.matched ?? [],
      missing_required_source_types: overrides.missing ?? [],
      failed_important_sources: []
    }
  };
}

function chunk(id: string, title: string, content: string, relevance: number): NormalizedChunk {
  return {
    id,
    content,
    metadata: {
      url: `https://example.com/${id}`,
      source_name: "crossref",
      source_type: "academic",
      title,
      publish_date: null,
      author: null,
      confidence_score: 0.7,
      summary: null,
      claim_graph: [{ claim: content, claim_type: "asserted", supporting_text_offset: [0, content.length] }],
      epistemic_stance: "secondary_analysis",
      surprise_score: 0.5
    },
    _internal: {
      relevance_to_query: relevance,
      source_weight: 0.8,
      freshness_fitness: 0.7,
      embedding: []
    }
  };
}
