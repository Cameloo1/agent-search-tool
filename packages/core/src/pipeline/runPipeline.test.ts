import { afterEach, describe, expect, it } from "vitest";
import { PipelineResponseSchema } from "@agent-search/shared";
import { makeMockRawItems, runPipeline, selectDegradedHighAuthorityRawItems } from "./runPipeline.js";
import { clearStage6ScoringCache } from "../stage6Score.js";

describe("runPipeline", () => {
  afterEach(() => {
    clearStage6ScoringCache();
  });

  it("runs an end-to-end mock pipeline and returns a valid response", async () => {
    const response = await runPipeline(
      { query: "How can I build a deduplication pipeline?", token_budget: 800 },
      { mockRawItems: makeMockRawItems("deduplication pipeline") }
    );

    expect(() => PipelineResponseSchema.parse(response)).not.toThrow();
    expect(response.trace.counts.raw_items).toBe(3);
    expect(response.trace.counts.selected_chunks).toBeGreaterThan(0);
    expect(response.chunks.length).toBeGreaterThan(0);
    expect(response.evidence_health?.status).toBeTruthy();
    expect(response.trace.evidence_health?.status).toBe(response.evidence_health?.status);
    expect(response.trace.retrieval_rounds.length).toBeGreaterThanOrEqual(1);
    expect(response.trace.gap_analysis?.status).toBeTruthy();
    expect(response.trace.cost_summary?.pricing_source).toBe("mock_zero");
    expect(response.trace.cost_summary?.line_items.length).toBeGreaterThan(0);
  });

  it("defaults answer synthesis on in quality mode", async () => {
    const response = await runPipeline(
      { query: "How can I build a deduplication pipeline?", token_budget: 800, quality_mode: "quality" },
      { mockRawItems: makeMockRawItems("deduplication pipeline") }
    );

    expect(response.synthesized_answer).not.toMatch(/^Synthesized from/i);
    expect(response.synthesized_answer).toContain("[");
  });

  it("defaults answer synthesis on and records balanced model usage in balanced mode", async () => {
    const response = await runPipeline(
      { query: "How can I build a deduplication pipeline?", token_budget: 800, quality_mode: "balanced" },
      { mockRawItems: makeMockRawItems("deduplication pipeline") }
    );

    expect(response.synthesized_answer).not.toMatch(/^Synthesized from/i);
    expect(response.synthesized_answer).toContain("[");
    expect(response.trace.extraction?.document_count).toBeGreaterThan(0);
    expect(response.trace.model_usage.strategy.model).toBe("~openai/gpt-mini-latest");
    expect(response.trace.model_usage.strategy.quality_mode).toBe("balanced");
    expect(response.trace.model_usage.strategy.escalated).toBe(false);
    expect(response.trace.model_usage.scoring.model).toBe("~google/gemini-flash-latest");
    expect(response.trace.model_usage.synthesis.model).toBe("openai/gpt-5.5");
    const reasoningByStage = new Map(response.trace.structured_llm_calls.map((call) => [call.stage, call.reasoning_enabled]));
    expect(reasoningByStage.get("intent")).toBe(false);
    expect(reasoningByStage.get("strategy")).toBe(false);
    expect(reasoningByStage.get("scoring")).toBe(false);
    expect(reasoningByStage.get("synthesis")).toBe(true);
    expect(response.trace.pre_rank[0]?.selected_for_llm_count).toBeLessThanOrEqual(12);
  });

  it("keeps reasoning enabled in quality mode", async () => {
    const response = await runPipeline(
      { query: "How can I build a deduplication pipeline?", token_budget: 800, quality_mode: "quality" },
      { mockRawItems: makeMockRawItems("deduplication pipeline") }
    );

    expect(response.trace.structured_llm_calls.some((call) => call.reasoning_enabled === true)).toBe(true);
  });

  it("selects degraded high-authority evidence for deepen-existing-source repair before broad retrieval", () => {
    const rawItem = {
      ...makeMockRawItems("official evidence")[0]!,
      id: "official-raw",
      source: "official_docs" as const,
      source_type: "government" as const,
      url: "https://example.gov/report",
      metadata: {
        extraction: {
          canonical_url: "https://example.gov/report",
          document_type: "html",
          retrieval_method: "metadata",
          extraction_method: "metadata_only",
          extraction_status: "metadata_only",
          extraction_confidence: 0.1,
          content_coverage: 0,
          section_path: [],
          attempts: []
        }
      }
    };
    const chunk = {
      ...makeMockRawItems("official evidence")[0]!,
      id: "chunk-1",
      content: "Official evidence",
      metadata: {
        url: "https://example.gov/report",
        source_name: "official_docs" as const,
        source_type: "government" as const,
        title: "Official report",
        publish_date: null,
        author: null,
        confidence_score: 0.1,
        summary: null,
        claim_graph: [],
        epistemic_stance: "primary_source" as const,
        surprise_score: 0,
        extraction: rawItem.metadata.extraction
      },
      _internal: {
        relevance_to_query: 0.5,
        source_weight: 0.9,
        freshness_fitness: 0.5,
        embedding: []
      }
    };

    expect(selectDegradedHighAuthorityRawItems([chunk], [rawItem], new Set()).map((item) => item.id)).toEqual(["official-raw"]);
    expect(selectDegradedHighAuthorityRawItems([chunk], [rawItem], new Set(["official-raw"]))).toHaveLength(0);
  });
});
