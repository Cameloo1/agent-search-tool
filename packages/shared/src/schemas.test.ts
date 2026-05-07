import { describe, expect, it } from "vitest";
import {
  CostSummarySchema,
  GapAnalysisSchema,
  IntentObjectSchema,
  PipelineRequestSchema,
  PreRankDiagnosticsSchema,
  SourcePluginManifestSchema,
  SubQuerySchema
} from "./schemas.js";

describe("shared schemas", () => {
  it("accepts valid intent objects", () => {
    const parsed = IntentObjectSchema.parse({
      core_intent: "Explain fiscal risk and AI productivity effects",
      query_type: ["multi-hop", "fresh-fact"],
      entities: ["CBO", "AI"],
      temporal_constraints: "current",
      required_source_types: ["government", "academic"]
    });

    expect(parsed.query_type).toContain("multi-hop");
  });

  it("accepts plugin-style target sources and rejects malformed ids", () => {
    const parsed = SubQuerySchema.parse({
      sub_query: "private benchmark evidence",
      target_sources: ["company_docs"],
      retrieval_intent: "primary_evidence",
      max_results: 3
    });
    expect(parsed.target_sources).toEqual(["company_docs"]);

    expect(() =>
      SubQuerySchema.parse({
        sub_query: "generic web search please",
        target_sources: ["Google Scholar"],
        retrieval_intent: "primary_evidence",
        max_results: 3
      })
    ).toThrow();
  });

  it("validates source plugin manifests", () => {
    const manifest = SourcePluginManifestSchema.parse({
      id: "company_docs",
      version: "0.1.0",
      entrypoint: "./companyDocs.ts",
      sources: [
        {
          id: "company_docs",
          label: "Company Docs",
          source_type: "other",
          description: "Internal research documents."
        }
      ],
      env: [{ name: "COMPANY_DOCS_TOKEN", required: true }],
      permissions: { network: ["docs.example.com"], filesystem: [] }
    });

    expect(manifest.sources[0]?.id).toBe("company_docs");
    expect(manifest.env[0]?.required).toBe(true);
  });

  it("validates pipeline request shape", () => {
    const parsed = PipelineRequestSchema.parse({
      query: "How do institutions get fast market news?",
      token_budget: 1200,
      quality_mode: "balanced",
      synthesize_answer: true,
      model_overrides: { strategy: "openai/gpt-5.5" },
      chat_history: [{ role: "user", content: "I trade macro" }]
    });

    expect(parsed.query).toContain("institutions");
    expect(parsed.quality_mode).toBe("balanced");
    expect(parsed.synthesize_answer).toBe(true);
    expect(parsed.model_overrides?.strategy).toBe("openai/gpt-5.5");
  });

  it("accepts official_docs and gap-analysis repair subqueries", () => {
    const subQuery = SubQuerySchema.parse({
      sub_query: "SEC market structure direct feeds",
      target_sources: ["official_docs"],
      retrieval_intent: "primary_evidence",
      max_results: 5
    });
    const gap = GapAnalysisSchema.parse({
      status: "retry_retrieval",
      should_retry: true,
      should_synthesize_cautiously: false,
      recommended_sub_queries: [subQuery],
      reasons: ["Missing direct-feed evidence."]
    });

    expect(gap.recommended_sub_queries[0]?.target_sources).toEqual(["official_docs"]);
  });

  it("accepts pre-rank diagnostics", () => {
    const diagnostics = PreRankDiagnosticsSchema.parse({
      round_index: 1,
      broadening_level: 1,
      input_chunk_count: 10,
      duplicate_group_count: 1,
      duplicate_rejected_count: 2,
      selected_for_llm_count: 6,
      rejected_count: 4,
      unavailable_sources_skipped: ["sec_edgar"],
      selected_candidates: [{ chunk_id: "a", local_score: 0.8, reasons: ["required_source_type"] }],
      rejected_candidates: [{ chunk_id: "b", local_score: 0.2, reasons: ["duplicate"] }],
      duplicate_groups: [{ id: "g1", representative_id: "a", member_ids: ["a", "b"], reason: "canonical_url" }]
    });

    expect(diagnostics.selected_for_llm_count).toBe(6);
    expect(diagnostics.unavailable_sources_skipped).toEqual(["sec_edgar"]);
  });

  it("accepts cost summaries with per-call model usage", () => {
    const summary = CostSummarySchema.parse({
      currency: "USD",
      total_cost_usd: 0.0012,
      total_prompt_tokens: 100,
      total_completion_tokens: 20,
      total_reasoning_tokens: 5,
      total_cached_tokens: 10,
      total_tokens: 120,
      estimated: false,
      pricing_source: "provider_usage",
      by_stage: {
        intent: {
          total_cost_usd: 0.0012,
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          line_item_count: 1,
          estimated: false
        }
      },
      by_model: {
        "openai/gpt-5.4-mini": {
          total_cost_usd: 0.0012,
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          line_item_count: 1,
          estimated: false
        }
      },
      line_items: [
        {
          id: "intent:IntentObject:1",
          stage: "intent",
          task: "stage1_intent_decomposer",
          schema_name: "IntentObject",
          provider: "openrouter",
          model: "openai/gpt-5.4-mini",
          quality_mode: "quality",
          attempt: 1,
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, reasoning_tokens: 5, cached_tokens: 10 },
          input_cost_usd: null,
          output_cost_usd: null,
          total_cost_usd: 0.0012,
          pricing_source: "provider_usage",
          generation_id: "gen-1",
          estimated: false
        }
      ]
    });

    expect(summary.line_items[0]?.usage.reasoning_tokens).toBe(5);
  });

  it("rejects invalid quality modes and unknown model override keys", () => {
    expect(() =>
      PipelineRequestSchema.parse({
        query: "How do institutions get fast market news?",
        quality_mode: "turbo",
        model_overrides: { strategy: "openai/gpt-5.5" }
      })
    ).toThrow();

    expect(() =>
      PipelineRequestSchema.parse({
        query: "How do institutions get fast market news?",
        model_overrides: { random: "openai/gpt-5.5" }
      })
    ).toThrow();
  });
});
