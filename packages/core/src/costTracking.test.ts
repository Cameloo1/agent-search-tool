import { describe, expect, it } from "vitest";
import { ModelCostLineItemSchema, type ModelCostLineItem } from "@agent-search/shared";
import { createCostTrackingProvider, summarizeModelCosts } from "./costTracking.js";
import { createTraceBuilder } from "./trace.js";

describe("cost tracking", () => {
  it("records provider usage metadata as a model cost line item", async () => {
    const trace = createTraceBuilder();
    trace.modelUsage.intent = {
      provider: "openrouter",
      model: "openai/gpt-5.4-mini",
      stage: "intent",
      quality_mode: "quality",
      escalated: false
    };
    const provider = createCostTrackingProvider(
      {
        name: "openrouter",
        async generateStructured() {
          return {
            output: "{\"ok\":true}",
            metadata: {
              provider: "openrouter",
              model: "openai/gpt-5.4-mini",
              generationId: "gen-1",
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
              costUsd: 0.012
            }
          };
        }
      },
      trace
    );

    await provider.generateStructured({
      task: "intent",
      schemaName: "IntentObject",
      stage: "intent",
      prompt: "Return JSON"
    });

    expect(trace.modelCostLineItems).toHaveLength(1);
    expect(trace.modelCostLineItems[0]).toMatchObject({
      stage: "intent",
      model: "openai/gpt-5.4-mini",
      quality_mode: "quality",
      total_cost_usd: 0.012,
      generation_id: "gen-1"
    });
  });

  it("uses provider-reported costs over catalog estimates", async () => {
    const lineItem = makeLineItem({
      total_cost_usd: 0.005,
      pricing_source: "provider_usage"
    });

    const summary = await summarizeModelCosts([lineItem], {
      pricingCatalog: { "openai/gpt-5.4-mini": { prompt: 1, completion: 1 } }
    });

    expect(summary.total_cost_usd).toBe(0.005);
    expect(summary.pricing_source).toBe("provider_usage");
    expect(summary.estimated).toBe(false);
  });

  it("estimates unavailable OpenRouter costs from catalog pricing", async () => {
    const lineItem = makeLineItem({
      total_cost_usd: null,
      pricing_source: "unavailable"
    });

    const summary = await summarizeModelCosts([lineItem], {
      pricingCatalog: { "openai/gpt-5.4-mini": { prompt: 0.000001, completion: 0.000002 } }
    });

    expect(summary.total_cost_usd).toBe(0.00014);
    expect(summary.pricing_source).toBe("catalog_estimate");
    expect(summary.estimated).toBe(true);
    expect(summary.line_items[0]?.pricing_source).toBe("catalog_estimate");
  });

  it("estimates Gemini 3.1 Flash Lite scoring costs from OpenRouter catalog pricing", async () => {
    const lineItem = makeLineItem({
      stage: "scoring",
      task: "stage6_quality_relevance_scorer",
      schema_name: "ChunkScoringResponse",
      model: "google/gemini-3.1-flash-lite",
      quality_mode: "balanced",
      total_cost_usd: null,
      pricing_source: "unavailable"
    });

    const summary = await summarizeModelCosts([lineItem], {
      pricingCatalog: {
        "google/gemini-3.1-flash-lite": {
          prompt: 0.00000025,
          completion: 0.0000015
        }
      }
    });

    expect(summary.total_cost_usd).toBe(0.000055);
    expect(summary.by_model["google/gemini-3.1-flash-lite"]?.total_cost_usd).toBe(0.000055);
    expect(summary.by_stage.scoring?.total_cost_usd).toBe(0.000055);
    expect(summary.pricing_source).toBe("catalog_estimate");
    expect(summary.line_items[0]?.input_cost_usd).toBe(0.000025);
    expect(summary.line_items[0]?.output_cost_usd).toBe(0.00003);
  });

  it("keeps unavailable line items visible when pricing is missing", async () => {
    const lineItem = makeLineItem({
      model: "openai/missing-model",
      total_cost_usd: null,
      pricing_source: "unavailable"
    });

    const summary = await summarizeModelCosts([lineItem], { pricingCatalog: {} });

    expect(summary.total_cost_usd).toBe(0);
    expect(summary.pricing_source).toBe("unavailable");
    expect(summary.warnings.join(" ")).toContain("openai/missing-model");
  });
});

function makeLineItem(overrides: Partial<ModelCostLineItem>) {
  return ModelCostLineItemSchema.parse({
    id: "intent:IntentObject:1",
    stage: "intent",
    task: "intent",
    schema_name: "IntentObject",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
    quality_mode: "quality",
    attempt: 1,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120
    },
    input_cost_usd: null,
    output_cost_usd: null,
    total_cost_usd: null,
    pricing_source: "unavailable",
    generation_id: "gen-1",
    duration_ms: 50,
    estimated: false,
    warnings: [],
    ...overrides
  });
}
