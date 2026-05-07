import { DEFAULTS, DEFAULT_BALANCED_STAGE_MODELS, DEFAULT_STAGE_MODELS, type LLMStageKey } from "@agent-search/shared";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

let envLoaded = false;
let envDirectory: string | undefined;

function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const path = findEnvPath();
  if (!path) return;
  envDirectory = dirname(path);
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
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

export function getEnv() {
  loadEnvFile();
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3001),
    llmProvider: process.env.LLM_PROVIDER ?? "mock",
    llmModel: process.env.LLM_MODEL ?? process.env.LLM_MODEL_DEFAULT ?? "openai/gpt-5.4-mini",
    llmModels: readStageModels("LLM_MODEL", DEFAULT_STAGE_MODELS, true),
    balancedLlmModels: readStageModels("LLM_MODEL_BALANCED", DEFAULT_BALANCED_STAGE_MODELS, false),
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    providerSearchOpenAIModel: process.env.PROVIDER_SEARCH_OPENAI_MODEL ?? "gpt-5.4-mini",
    providerSearchClaudeModel: process.env.PROVIDER_SEARCH_CLAUDE_MODEL ?? "claude-sonnet-4-5",
    providerSearchGeminiModel: process.env.PROVIDER_SEARCH_GEMINI_MODEL ?? "gemini-2.5-flash",
    llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 10_000),
    sourceTimeoutMs: Number(process.env.SOURCE_TIMEOUT_MS ?? DEFAULTS.sourceTimeoutMs),
    maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? DEFAULTS.maxConcurrency),
    maxRepairRounds: Number(process.env.MAX_REPAIR_ROUNDS ?? DEFAULTS.maxRepairRounds),
    repairTimeBudgetMs: Number(process.env.REPAIR_TIME_BUDGET_MS ?? DEFAULTS.repairTimeBudgetMs),
    prerankMaxLlmChunks: Number(process.env.PRERANK_MAX_LLM_CHUNKS ?? DEFAULTS.prerankMaxLlmChunks),
    stage6ScoringConcurrency: Number(process.env.STAGE6_SCORING_CONCURRENCY ?? DEFAULTS.stage6ScoringConcurrency),
    synthesisReviewTimeoutMs: Number(process.env.SYNTHESIS_REVIEW_TIMEOUT_MS ?? DEFAULTS.synthesisReviewTimeoutMs),
    openRouterPricingCacheTtlMs: Number(process.env.OPENROUTER_PRICING_CACHE_TTL_MS ?? 86_400_000),
    dedupSimilarityThreshold: Number(process.env.DEDUP_SIMILARITY_THRESHOLD ?? DEFAULTS.dedupSimilarityThreshold),
    scoringThreshold: Number(process.env.SCORING_THRESHOLD ?? DEFAULTS.scoringThreshold),
    coreApiKey: readOptionalEnv("CORE_API_KEY"),
    githubToken: readOptionalEnv("GITHUB_TOKEN"),
    semanticScholarApiKey: readOptionalEnv("SEMANTIC_SCHOLAR_API_KEY") ?? readOptionalEnv("S2_API_KEY"),
    secUserAgent: readOptionalEnv("SEC_USER_AGENT"),
    reliabilityDbPath: resolveEnvRelative(process.env.RELIABILITY_DB_PATH ?? "data/source-reliability.sqlite"),
    enableDebugInternals: process.env.ENABLE_DEBUG_INTERNALS === "1"
  };
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function readStageModels(
  prefix: "LLM_MODEL" | "LLM_MODEL_BALANCED",
  defaults: Record<LLMStageKey, string>,
  allowGlobalFallback: boolean
): Record<LLMStageKey, string> {
  return {
    default: readStageModel(prefix, "DEFAULT", defaults, allowGlobalFallback),
    intent: readStageModel(prefix, "INTENT", defaults, allowGlobalFallback),
    strategy: readStageModel(prefix, "STRATEGY", defaults, allowGlobalFallback),
    scoring: readStageModel(prefix, "SCORING", defaults, allowGlobalFallback),
    synthesis: readStageModel(prefix, "SYNTHESIS", defaults, allowGlobalFallback),
    adjudicator: readStageModel(prefix, "ADJUDICATOR", defaults, allowGlobalFallback)
  };
}

function readStageModel(
  prefix: "LLM_MODEL" | "LLM_MODEL_BALANCED",
  stage: "DEFAULT" | "INTENT" | "STRATEGY" | "SCORING" | "SYNTHESIS" | "ADJUDICATOR",
  defaults: Record<LLMStageKey, string>,
  allowGlobalFallback: boolean
): string {
  const stageKey = stage.toLowerCase() as LLMStageKey;
  const direct = process.env[`${prefix}_${stage}`];
  if (direct) return direct;
  if (!allowGlobalFallback) {
    if (stage !== "DEFAULT" && process.env[`${prefix}_DEFAULT`]) {
      return process.env[`${prefix}_DEFAULT`] as string;
    }
    return defaults[stageKey];
  }

  if (stage === "DEFAULT" && process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (["INTENT", "STRATEGY", "SCORING"].includes(stage) && process.env.LLM_MODEL_DEFAULT) {
    return process.env.LLM_MODEL_DEFAULT;
  }

  return defaults[stageKey];
}

function resolveEnvRelative(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }

  return resolve(envDirectory ?? process.cwd(), path);
}
