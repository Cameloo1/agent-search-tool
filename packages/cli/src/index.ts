import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { makeMockRawItems } from "@agent-search/core";
import type { QualityMode } from "@agent-search/shared";
import { createCliLLMProvider, getCliEnv } from "./env.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const command = args[0] ?? "help";

if (command === "search") {
  const parsed = parseSearchArgs(args.slice(1));
  if (!parsed.query) {
    usage(1);
  }
  const suite = createCliSuite(parsed);
  const result = await suite.tools[0]?.execute({
    query: parsed.query,
    quality_mode: parsed.qualityMode,
    token_budget: parsed.tokenBudget,
    debug: parsed.debug
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "plugins") {
  const subcommand = args[1] ?? "list";
  const suite = createCliSuite({});
  const toolName =
    subcommand === "doctor" || subcommand === "validate"
      ? "agent_search_plugin_doctor"
      : subcommand === "list"
        ? "agent_search_sources"
        : undefined;
  if (!toolName) usage(1);
  const result = await suite.tools.find((tool) => tool.name === toolName)?.execute({});
  console.log(JSON.stringify(result, null, 2));
} else {
  usage(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
}

function createCliSuite(args: Partial<ReturnType<typeof parseSearchArgs>>) {
  const env = getCliEnv();
  const llmProvider = createCliLLMProvider();
  return createAgentSearchToolSuite({
    llmProvider,
    defaultRequest: {
      quality_mode: args.qualityMode ?? "balanced",
      token_budget: args.tokenBudget ?? env.tokenBudget,
      debug: args.debug
    },
    credentials: env.apiKeys,
    pipelineOptions: {
      mockRawItems: env.llmProvider === "mock" || !llmProvider ? makeMockRawItems(args.query ?? "agent search") : undefined,
      stageModels: env.stageModels,
      balancedStageModels: env.balancedStageModels,
      reliabilityDbPath: env.reliabilityDbPath,
      llmTimeoutMs: env.llmTimeoutMs,
      secUserAgent: env.secUserAgent
    }
  });
}

function parseSearchArgs(rawArgs: string[]): {
  query: string;
  qualityMode: QualityMode;
  tokenBudget?: number;
  debug?: boolean;
} {
  const queryParts: string[] = [];
  let qualityMode: QualityMode = "balanced";
  let tokenBudget: number | undefined;
  let debug = false;

  for (const arg of rawArgs) {
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
    queryParts.push(arg);
  }

  return {
    query: queryParts.join(" ").trim(),
    qualityMode,
    tokenBudget: Number.isFinite(tokenBudget) ? tokenBudget : undefined,
    debug
  };
}

function usage(exitCode: number): never {
  console.error(`Usage:
  agent-search search [--quality=fast|balanced|quality] [--token-budget=4000] "query"
  agent-search plugins list
  agent-search plugins doctor
  agent-search plugins validate`);
  process.exit(exitCode);
}
