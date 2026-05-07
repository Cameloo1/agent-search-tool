import { createAnthropicProvider, createModelBoundProvider, createOpenAIProvider, createOpenRouterProvider } from "@agent-search/llm";
import type { LLMProvider } from "@agent-search/shared";
import { getEnv } from "./env.js";

export function createConfiguredLLMProvider(): LLMProvider | undefined {
  const env = getEnv();
  if (env.llmProvider === "openai" && env.openaiApiKey) {
    return createOpenAIProvider({ apiKey: env.openaiApiKey, model: env.llmModel });
  }
  if (env.llmProvider === "openrouter" && env.openRouterApiKey) {
    return createOpenRouterProvider({
      apiKey: env.openRouterApiKey,
      model: env.llmModel,
      reasoningEnabled: true,
      appName: "agent-search-tool"
    });
  }
  if (env.llmProvider === "anthropic" && env.anthropicApiKey) {
    return createAnthropicProvider({ apiKey: env.anthropicApiKey, model: env.llmModel });
  }
  return undefined;
}

export function createConfiguredProviderForModel(model: string): LLMProvider | undefined {
  const base = createConfiguredLLMProvider();
  return base ? createModelBoundProvider(base, model) : undefined;
}
