import { createAnthropicProvider, createModelBoundProvider, createOpenAIProvider, createOpenRouterProvider } from "@agent-search/llm";
import {
  DEFAULTS,
  DEFAULT_BALANCED_STAGE_MODELS,
  DEFAULT_STAGE_MODELS,
  type LLMProvider,
  type LLMStageKey
} from "@agent-search/shared";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

let envLoaded = false;
let envDirectory: string | undefined;

export function getCliEnv() {
  loadEnvFile();
  const stageModels = {
    default: readModel("LLM_MODEL", "DEFAULT", DEFAULT_STAGE_MODELS, true),
    intent: readModel("LLM_MODEL", "INTENT", DEFAULT_STAGE_MODELS, true),
    strategy: readModel("LLM_MODEL", "STRATEGY", DEFAULT_STAGE_MODELS, true),
    scoring: readModel("LLM_MODEL", "SCORING", DEFAULT_STAGE_MODELS, true),
    synthesis: readModel("LLM_MODEL", "SYNTHESIS", DEFAULT_STAGE_MODELS, true),
    adjudicator: readModel("LLM_MODEL", "ADJUDICATOR", DEFAULT_STAGE_MODELS, true)
  } satisfies Record<LLMStageKey, string>;
  const balancedStageModels = {
    default: readModel("LLM_MODEL_BALANCED", "DEFAULT", DEFAULT_BALANCED_STAGE_MODELS, false),
    intent: readModel("LLM_MODEL_BALANCED", "INTENT", DEFAULT_BALANCED_STAGE_MODELS, false),
    strategy: readModel("LLM_MODEL_BALANCED", "STRATEGY", DEFAULT_BALANCED_STAGE_MODELS, false),
    scoring: readModel("LLM_MODEL_BALANCED", "SCORING", DEFAULT_BALANCED_STAGE_MODELS, false),
    synthesis: readModel("LLM_MODEL_BALANCED", "SYNTHESIS", DEFAULT_BALANCED_STAGE_MODELS, false),
    adjudicator: readModel("LLM_MODEL_BALANCED", "ADJUDICATOR", DEFAULT_BALANCED_STAGE_MODELS, false)
  } satisfies Record<LLMStageKey, string>;

  return {
    llmProvider: process.env.LLM_PROVIDER ?? "mock",
    llmModel: process.env.LLM_MODEL ?? stageModels.default,
    stageModels,
    balancedStageModels,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    apiKeys: {
      core: readOptionalEnv("CORE_API_KEY"),
      github: readOptionalEnv("GITHUB_TOKEN"),
      semanticScholar: readOptionalEnv("SEMANTIC_SCHOLAR_API_KEY") ?? readOptionalEnv("S2_API_KEY")
    },
    secUserAgent: readOptionalEnv("SEC_USER_AGENT"),
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 10_000),
    tokenBudget: Number(process.env.DEFAULT_TOKEN_BUDGET ?? DEFAULTS.tokenBudget),
    reliabilityDbPath: resolveEnvRelative(process.env.RELIABILITY_DB_PATH ?? "data/source-reliability.sqlite")
  };
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

export function createCliLLMProvider(): LLMProvider | undefined {
  const env = getCliEnv();
  if (env.llmProvider === "openrouter" && env.openRouterApiKey) {
    return createOpenRouterProvider({
      apiKey: env.openRouterApiKey,
      model: env.llmModel,
      reasoningEnabled: true,
      appName: "agent-search-tool-cli"
    });
  }
  if (env.llmProvider === "openai" && env.openaiApiKey) {
    return createOpenAIProvider({ apiKey: env.openaiApiKey, model: env.llmModel });
  }
  if (env.llmProvider === "anthropic" && env.anthropicApiKey) {
    return createAnthropicProvider({ apiKey: env.anthropicApiKey, model: env.llmModel });
  }
  return undefined;
}

export function createCliProviderForModel(model: string): LLMProvider | undefined {
  const provider = createCliLLMProvider();
  return provider ? createModelBoundProvider(provider, model) : undefined;
}

function readModel(
  prefix: "LLM_MODEL" | "LLM_MODEL_BALANCED",
  stage: "DEFAULT" | "INTENT" | "STRATEGY" | "SCORING" | "SYNTHESIS" | "ADJUDICATOR",
  defaults: Record<LLMStageKey, string>,
  allowGlobalFallback: boolean
): string {
  const key = `${prefix}_${stage}`;
  const stageKey = stage.toLowerCase() as LLMStageKey;
  const direct = process.env[key];
  if (direct) return direct;
  if (!allowGlobalFallback) {
    if (stage !== "DEFAULT" && process.env[`${prefix}_DEFAULT`]) {
      return process.env[`${prefix}_DEFAULT`] as string;
    }
    return defaults[stageKey];
  }
  return process.env.LLM_MODEL ?? defaults[stageKey];
}

function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const path = findEnvPath();
  if (!path) return;
  envDirectory = dirname(path);
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveEnvRelative(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }

  return resolve(envDirectory ?? process.cwd(), path);
}

function findEnvPath(): string | undefined {
  let directory = process.cwd();
  while (true) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
