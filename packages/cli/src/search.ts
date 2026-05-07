import { makeMockRawItems, runPipeline } from "@agent-search/core";
import type { QualityMode } from "@agent-search/shared";
import { createCliLLMProvider, getCliEnv } from "./env.js";

const args = parseArgs(process.argv.slice(2));
if (args.provider) {
  process.env.LLM_PROVIDER = args.provider;
}
const query = args.query;

if (!query) {
  console.error('Usage: pnpm cli:search -- --quality=fast|balanced|quality "your query"');
  process.exit(1);
}

const env = getCliEnv();
const llmProvider = createCliLLMProvider();
const mockMode = env.llmProvider === "mock" || !llmProvider;
const response = await runPipeline(
  {
    query,
    token_budget: args.tokenBudget ?? env.tokenBudget,
    quality_mode: args.qualityMode,
    debug: args.debug
  },
  {
    mockRawItems: mockMode ? makeMockRawItems(query) : undefined,
    llmProvider,
    stageModels: env.stageModels,
    balancedStageModels: env.balancedStageModels,
    reliabilityDbPath: env.reliabilityDbPath,
    llmTimeoutMs: env.llmTimeoutMs,
    apiKeys: env.apiKeys,
    secUserAgent: env.secUserAgent
  }
);

console.log(JSON.stringify(response, null, 2));

function parseArgs(rawArgs: string[]): {
  query: string;
  qualityMode: QualityMode;
  tokenBudget?: number;
  debug?: boolean;
  provider?: string;
} {
  const queryParts: string[] = [];
  let qualityMode: QualityMode = "fast";
  let tokenBudget: number | undefined;
  let debug = false;
  let provider: string | undefined;

  for (const arg of rawArgs) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--quality" || arg === "--quality=quality") {
      qualityMode = "quality";
      continue;
    }
    if (arg === "--balanced" || arg === "--quality=balanced") {
      qualityMode = "balanced";
      continue;
    }
    if (arg === "--fast" || arg === "--quality=fast") {
      qualityMode = "fast";
      continue;
    }
    if (arg.startsWith("--token-budget=")) {
      tokenBudget = Number(arg.slice("--token-budget=".length));
      continue;
    }
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
      continue;
    }
    queryParts.push(arg);
  }

  return {
    query: queryParts.join(" ").trim(),
    qualityMode,
    tokenBudget: Number.isFinite(tokenBudget) ? tokenBudget : undefined,
    debug,
    provider
  };
}
