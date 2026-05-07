import { runComparison } from "@agent-search/eval";
import { makeMockRawItems, runPipeline } from "@agent-search/core";
import type { QualityMode } from "@agent-search/shared";
import { createCliLLMProvider, createCliProviderForModel, getCliEnv } from "./env.js";

const qualityMode = parseQualityMode(process.argv.slice(2));
const providerOverride = parseProvider(process.argv.slice(2));
if (providerOverride) {
  process.env.LLM_PROVIDER = providerOverride;
}
const env = getCliEnv();
const llmProvider = createCliLLMProvider();
const mockMode = env.llmProvider === "mock" || !llmProvider;

const result = await runComparison({
  runEngine: async (question) =>
    runPipeline(
      { query: question.question, token_budget: env.tokenBudget, quality_mode: qualityMode },
      {
        mockRawItems: mockMode ? makeMockRawItems(question.question) : undefined,
        llmProvider,
        stageModels: env.stageModels,
        reliabilityDbPath: env.reliabilityDbPath,
        llmTimeoutMs: env.llmTimeoutMs,
        apiKeys: env.apiKeys,
        secUserAgent: env.secUserAgent
      }
    ),
  synthesisProvider: createCliProviderForModel(env.stageModels.synthesis),
  adjudicatorProvider: createCliProviderForModel(env.stageModels.adjudicator),
  llmTimeoutMs: env.llmTimeoutMs
});

console.log(JSON.stringify(result, null, 2));

function parseQualityMode(args: string[]): QualityMode {
  if (args.includes("--quality") || args.includes("--quality=quality")) {
    return "quality";
  }
  return "fast";
}

function parseProvider(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length);
}
