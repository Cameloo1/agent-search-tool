import { describe, expect, it } from "vitest";
import { createMockLLMProvider } from "@agent-search/llm";
import type { IntentObject, PipelineRequest } from "@agent-search/shared";
import { createBalancedStageModelConfig, createModelRouter, createStageModelConfig } from "./modelRouting.js";

const provider = createMockLLMProvider({});

describe("model routing", () => {
  it("uses fast stage models by default", () => {
    const request: PipelineRequest = { query: "How should I route this?", quality_mode: "fast" };
    const config = createStageModelConfig({
      default: "openai/gpt-5.4-mini",
      strategy: "openai/gpt-5.4-mini",
      adjudicator: "openai/gpt-5.5"
    });
    const router = createModelRouter(provider, request, config);

    const decision = router.providerFor("intent");

    expect(decision.model).toBe("openai/gpt-5.4-mini");
    expect(decision.escalated).toBe(false);
  });

  it("escalates source strategy and scoring in quality mode", () => {
    const request: PipelineRequest = { query: "Deep market structure question", quality_mode: "quality" };
    const config = createStageModelConfig({
      strategy: "openai/gpt-5.4-mini",
      scoring: "openai/gpt-5.4-mini",
      adjudicator: "openai/gpt-5.5"
    });
    const router = createModelRouter(provider, request, config);

    expect(router.providerFor("strategy").model).toBe("openai/gpt-5.5");
    expect(router.providerFor("strategy").escalated).toBe(true);
    expect(router.providerFor("scoring").model).toBe("openai/gpt-5.5");
  });

  it("uses balanced models without quality escalation", () => {
    const request: PipelineRequest = { query: "Use cheaper models well", quality_mode: "balanced" };
    const router = createModelRouter(
      provider,
      request,
      createStageModelConfig({
        strategy: "openai/gpt-5.4-mini",
        scoring: "openai/gpt-5.4-mini",
        synthesis: "openai/gpt-5.5",
        adjudicator: "openai/gpt-5.5"
      }),
      "openai/gpt-5.5",
      createBalancedStageModelConfig()
    );

    expect(router.providerFor("intent").model).toBe("~openai/gpt-mini-latest");
    expect(router.providerFor("strategy").model).toBe("~openai/gpt-mini-latest");
    expect(router.providerFor("strategy").escalated).toBe(false);
    expect(router.providerFor("scoring").model).toBe("~google/gemini-flash-latest");
    expect(router.providerFor("synthesis").model).toBe("openai/gpt-5.5");
  });

  it("keeps hard source-attribution strategy cheap in fast mode", () => {
    const request: PipelineRequest = { query: "Who said what and where?", quality_mode: "fast" };
    const intent: IntentObject = {
      core_intent: "source attribution",
      query_type: ["source-attribution"],
      entities: [],
      temporal_constraints: null,
      required_source_types: ["primary-document"]
    };
    const router = createModelRouter(
      provider,
      request,
      createStageModelConfig({ strategy: "openai/gpt-5.4-mini", adjudicator: "openai/gpt-5.5" })
    );

    const decision = router.providerFor("strategy", { intent });

    expect(decision.model).toBe("openai/gpt-5.4-mini");
    expect(decision.escalated).toBe(false);
  });
});
