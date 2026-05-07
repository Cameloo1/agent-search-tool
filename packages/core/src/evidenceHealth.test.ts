import { describe, expect, it } from "vitest";
import type { IntentObject, NormalizedChunk, Trace } from "@agent-search/shared";
import { computeEvidenceHealth } from "./evidenceHealth.js";

function chunk(
  id: string,
  sourceName: NormalizedChunk["metadata"]["source_name"],
  sourceType: NormalizedChunk["metadata"]["source_type"],
  stance: NormalizedChunk["metadata"]["epistemic_stance"],
  score = 0.94,
  claims = 2
): NormalizedChunk {
  const claimGraph = Array.from({ length: claims }, (_, index) => ({
    claim: `${id} supported claim ${index + 1}`,
    claim_type: "asserted" as const,
    supporting_text_offset: [0, 40] as [number, number]
  }));

  return {
    id,
    content: `${id} evidence content with primary details and traceable support.`,
    metadata: {
      url: `https://example.com/${id}`,
      source_name: sourceName,
      source_type: sourceType,
      title: id,
      publish_date: "2026-01-01T00:00:00.000Z",
      author: "Test Source",
      confidence_score: score,
      summary: null,
      claim_graph: claimGraph,
      epistemic_stance: stance,
      surprise_score: 0.7
    },
    _internal: {
      relevance_to_query: score,
      source_weight: sourceType === "government" || sourceType === "filing" ? 0.95 : sourceType === "academic" ? 0.86 : 0.72,
      freshness_fitness: score,
      embedding: []
    }
  };
}

const sourceResults: Trace["source_results"] = {
  data_gov: { queried: 1, ok: 1, failed: 0, timing_ms: 12, errors: [] },
  openalex: { queried: 1, ok: 1, failed: 0, timing_ms: 15, errors: [] },
  wikipedia: { queried: 1, ok: 1, failed: 0, timing_ms: 8, errors: [] }
};

const deduplication: Trace["deduplication"] = { clusters: [] };

describe("evidence health", () => {
  it("labels high-relevance diverse evidence as strong", () => {
    const intent: IntentObject = {
      core_intent: "Explain an official policy question",
      query_type: ["fresh-fact", "source-attribution"],
      entities: [],
      temporal_constraints: "current",
      required_source_types: ["government", "academic"]
    };

    const health = computeEvidenceHealth({
      chunks: [
        chunk("official", "data_gov", "government", "primary_source"),
        chunk("paper", "openalex", "academic", "secondary_analysis"),
        chunk("background", "wikipedia", "encyclopedic", "tertiary_summary")
      ],
      intent,
      sourceResults,
      deduplication
    });

    expect(health.status).toBe("strong");
    expect(health.evidence_quality_score).toBeGreaterThanOrEqual(80);
    expect(health.evidence_coverage_score).toBeGreaterThanOrEqual(80);
  });

  it("marks zero selected chunks as insufficient with explicit reasons", () => {
    const intent: IntentObject = {
      core_intent: "Find official data",
      query_type: ["fresh-fact"],
      entities: [],
      temporal_constraints: "current",
      required_source_types: ["government"]
    };

    const health = computeEvidenceHealth({
      chunks: [],
      intent,
      sourceResults: {
        data_gov: {
          queried: 1,
          ok: 0,
          failed: 1,
          timing_ms: 50,
          errors: [{ code: "TIMEOUT", message: "timed out", retryable: true }]
        }
      },
      deduplication
    });

    expect(health.status).toBe("insufficient");
    expect(health.evidence_quality_score).toBe(0);
    expect(health.reasons[0]).toMatch(/No selected evidence chunks/);
  });

  it("penalizes missing primary evidence for attribution-heavy intents", () => {
    const intent: IntentObject = {
      core_intent: "Verify a contested fact",
      query_type: ["source-attribution", "adversarial"],
      entities: [],
      temporal_constraints: null,
      required_source_types: ["primary-document"]
    };

    const health = computeEvidenceHealth({
      chunks: [chunk("summary", "wikipedia", "encyclopedic", "tertiary_summary", 0.9, 3)],
      intent,
      sourceResults,
      deduplication
    });

    expect(health.components.source_authority).toBeLessThan(60);
    expect(health.details.primary_source_count).toBe(0);
    expect(health.details.missing_required_source_types).toContain("primary-document");
  });

  it("lowers quality for important source failures but keeps unrelated failures as warnings", () => {
    const intent: IntentObject = {
      core_intent: "Explain current official data",
      query_type: ["fresh-fact"],
      entities: [],
      temporal_constraints: "current",
      required_source_types: ["government"]
    };
    const chunks = [chunk("official", "data_gov", "government", "primary_source")];

    const clean = computeEvidenceHealth({ chunks, intent, sourceResults, deduplication });
    const withImportantFailure = computeEvidenceHealth({
      chunks,
      intent,
      sourceResults: {
        ...sourceResults,
        data_gov: {
          queried: 1,
          ok: 0,
          failed: 1,
          timing_ms: 100,
          errors: [{ code: "TIMEOUT", message: "timed out", retryable: true }]
        },
        hacker_news: {
          queried: 1,
          ok: 0,
          failed: 1,
          timing_ms: 20,
          errors: [{ code: "TIMEOUT", message: "timed out", retryable: true }]
        }
      },
      deduplication
    });

    expect(withImportantFailure.evidence_quality_score).toBeLessThan(clean.evidence_quality_score);
    expect(withImportantFailure.warnings.join(" ")).toContain("data_gov");
  });
});
