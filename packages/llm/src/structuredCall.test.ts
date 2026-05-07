import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockLLMProvider } from "./mockProvider.js";
import { structuredCall } from "./structuredCall.js";

const ExampleSchema = z.object({
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const input = {
  task: "example",
  prompt: "Return an answer",
  schemaName: "Example"
};

describe("structuredCall", () => {
  it("validates structured output from a mock provider", async () => {
    const provider = createMockLLMProvider([{ answer: "ok", confidence: 0.8 }]);

    const result = await structuredCall(provider, { ...input, reasoningEnabled: false }, ExampleSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answer).toBe("ok");
      expect(result.attempts).toBe(1);
      expect(result.attemptDiagnostics[0]?.reasoning_enabled).toBe(false);
    }
  });

  it("retries invalid output and repairs with schema feedback", async () => {
    const provider = createMockLLMProvider([
      { answer: "", confidence: 2 },
      { answer: "fixed", confidence: 0.7 }
    ]);

    const result = await structuredCall(provider, input, ExampleSchema, { maxAttempts: 3 });

    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.prompt).toContain("failed validation");
    if (result.ok) {
      expect(result.value.answer).toBe("fixed");
    }
  });

  it("parses fenced JSON strings", async () => {
    const provider = createMockLLMProvider(['```json\n{"answer":"json","confidence":0.5}\n```']);

    const result = await structuredCall(provider, input, ExampleSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answer).toBe("json");
    }
  });

  it("unwraps provider responses while preserving usage metadata", async () => {
    const provider = createMockLLMProvider([
      {
        output: "{\"answer\":\"ok\",\"confidence\":0.9}",
        metadata: {
          provider: "openrouter",
          model: "openai/gpt-5.4-mini",
          generationId: "gen-test",
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          costUsd: 0.001
        }
      }
    ]);

    const result = await structuredCall(provider, input, ExampleSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.answer).toBe("ok");
      expect(result.metadata[0]?.generationId).toBe("gen-test");
      expect(result.metadata[0]?.usage?.total_tokens).toBe(17);
    }
  });

  it("returns a failed result after bounded invalid attempts", async () => {
    const provider = createMockLLMProvider([{ answer: "", confidence: 2 }, { answer: "", confidence: 3 }]);

    const result = await structuredCall(provider, input, ExampleSchema, { maxAttempts: 2 });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.errors).toHaveLength(2);
  });

  it("aborts provider work when a structured call times out", async () => {
    let abortObserved = false;
    const provider = createMockLLMProvider(
      (callInput) =>
        new Promise((_resolve, reject) => {
          callInput.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(callInput.signal?.reason ?? new Error("aborted"));
          });
        })
    );

    const result = await structuredCall(provider, input, ExampleSchema, { maxAttempts: 1, timeoutMs: 5 });

    expect(result.ok).toBe(false);
    expect(abortObserved).toBe(true);
    expect(result.attemptDiagnostics[0]?.timeout).toBe(true);
  });
});
