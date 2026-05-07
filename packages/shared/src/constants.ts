export const ALLOWED_SOURCE_NAMES = [
  "wikipedia",
  "arxiv",
  "semantic_scholar",
  "pubmed",
  "openalex",
  "core",
  "crossref",
  "stack_exchange",
  "hacker_news",
  "github",
  "wikidata",
  "sec_edgar",
  "data_gov",
  "official_docs"
] as const;

export const QUERY_TYPES = [
  "multi-hop",
  "fresh-fact",
  "source-attribution",
  "adversarial",
  "dedup-prone",
  "cultural",
  "academic"
] as const;

export const REQUIRED_SOURCE_TYPES = [
  "academic",
  "news",
  "primary-document",
  "encyclopedic",
  "forum",
  "code",
  "filing",
  "government",
  "medical"
] as const;

export const NORMALIZED_SOURCE_TYPES = [
  "academic",
  "encyclopedic",
  "filing",
  "forum",
  "code",
  "government",
  "medical",
  "structured_fact",
  "tech_discussion",
  "other"
] as const;

export const RETRIEVAL_INTENTS = [
  "primary_evidence",
  "corroborating",
  "contrarian",
  "definitional",
  "temporal"
] as const;

export const CLAIM_TYPES = ["asserted", "cited", "quoted", "disputed"] as const;

export const EPISTEMIC_STANCES = [
  "primary_source",
  "secondary_analysis",
  "tertiary_summary",
  "opinion",
  "speculation"
] as const;

export const OPPONENT_MODES = ["live", "imported", "manual", "missing"] as const;

export const SCORE_STATUSES = [
  "scored",
  "blocked_missing_gold",
  "blocked_invalid_gold",
  "scoring_unavailable"
] as const;

export const EVIDENCE_HEALTH_STATUSES = ["strong", "adequate", "weak", "insufficient"] as const;

export const SOURCE_ERROR_CATEGORIES = [
  "unavailable",
  "rate_limited",
  "query_invalid",
  "missing_config",
  "timeout",
  "unknown"
] as const;

export const QUALITY_MODES = ["fast", "balanced", "quality"] as const;

export const LLM_STAGE_KEYS = [
  "default",
  "intent",
  "strategy",
  "scoring",
  "synthesis",
  "adjudicator"
] as const;

export const DEFAULTS = {
  pipelineTimeoutMs: 45_000,
  sourceTimeoutMs: 8_000,
  maxConcurrency: 6,
  dedupSimilarityThreshold: 0.85,
  tokenBudget: 4_000,
  scoringThreshold: 0.2,
  maxRepairRounds: 4,
  repairTimeBudgetMs: 120_000,
  prerankMaxLlmChunks: 18,
  stage6ScoringConcurrency: 3,
  synthesisReviewTimeoutMs: 25_000
} as const;

export const DEFAULT_STAGE_MODELS: Record<(typeof LLM_STAGE_KEYS)[number], string> = {
  default: "openai/gpt-5.4-mini",
  intent: "openai/gpt-5.4-mini",
  strategy: "openai/gpt-5.4-mini",
  scoring: "openai/gpt-5.4-mini",
  synthesis: "openai/gpt-5.5",
  adjudicator: "openai/gpt-5.5"
};

export const DEFAULT_BALANCED_STAGE_MODELS: Record<(typeof LLM_STAGE_KEYS)[number], string> = {
  default: "~openai/gpt-mini-latest",
  intent: "~openai/gpt-mini-latest",
  strategy: "~openai/gpt-mini-latest",
  scoring: "google/gemini-3.1-flash-lite",
  synthesis: "openai/gpt-5.5",
  adjudicator: "openai/gpt-5.5"
};
