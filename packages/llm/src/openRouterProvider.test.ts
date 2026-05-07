import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterProvider } from "./httpProviders.js";

describe("OpenRouter provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends stage-selected model and reasoning instructions", async () => {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: "gen-123",
            model: "openai/gpt-5.5",
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
              cost: 0.00042,
              completion_tokens_details: { reasoning_tokens: 2 },
              prompt_tokens_details: { cached_tokens: 3 }
            },
            choices: [{ message: { content: "{\"answer\":\"ok\"}", reasoning_details: [{ type: "trace" }] } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const provider = createOpenRouterProvider({ apiKey: "test-key", model: "openai/gpt-5.4-mini" });
    const output = await provider.generateStructured({
      task: "smoke",
      schemaName: "Smoke",
      stage: "strategy",
      model: "openai/gpt-5.5",
      prompt: "Return JSON."
    });

    expect(output).toMatchObject({
      output: "{\"answer\":\"ok\"}",
      metadata: {
        provider: "openrouter",
        model: "openai/gpt-5.5",
        generationId: "gen-123",
        costUsd: 0.00042
      }
    });
    expect((output as any).metadata.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      reasoning_tokens: 2,
      cached_tokens: 3
    });
    expect(body.model).toBe("openai/gpt-5.5");
    expect(body.reasoning).toEqual({ enabled: true });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
  });

  it("preserves reasoning details for structured retry calls", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"answer\":\"ok\"}", reasoning_details: [{ type: "trace" }] } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const provider = createOpenRouterProvider({ apiKey: "test-key", model: "openai/gpt-5.4-mini" });
    const input = {
      task: "smoke",
      schemaName: "Smoke",
      stage: "strategy" as const,
      prompt: "Return JSON."
    };

    await provider.generateStructured(input);
    await provider.generateStructured({
      ...input,
      metadata: { structuredRetryAttempt: 2 }
    });

    expect(bodies[1].messages.some((message: any) => message.role === "assistant" && message.reasoning_details)).toBe(true);
  });

  it("can disable provider reasoning per structured call", async () => {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"answer\":\"ok\"}" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const provider = createOpenRouterProvider({ apiKey: "test-key", model: "openai/gpt-5.4-mini", reasoningEnabled: true });
    await provider.generateStructured({
      task: "smoke",
      schemaName: "Smoke",
      stage: "strategy",
      prompt: "Return JSON.",
      reasoningEnabled: false
    });

    expect(body.reasoning).toEqual({ enabled: false });
  });
});
