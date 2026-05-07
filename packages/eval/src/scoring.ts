import { EvaluationResultSchema } from "@agent-search/shared";
import type { AtomicFact, EvaluationResult, RequiredSource, ScoreStatus } from "@agent-search/shared";
import { LOCKED_GOLD_QUESTION_IDS, validateGoldArtifact } from "./gold.js";
import type {
  BlockedEvaluationOptions,
  CitedSource,
  GoldArtifact,
  GoldLoadResult,
  GoldValidationResult,
  ScoreAgainstGoldInput
} from "./types.js";

const PRIMARY_SOURCE_TYPES = new Set(["filing", "government", "medical", "code"]);
const PRIMARY_SOURCE_NAMES = new Set(["sec_edgar", "data_gov", "github", "pubmed"]);

export function scoreAgainstGold(input: ScoreAgainstGoldInput): EvaluationResult {
  const questionId = input.questionId?.trim() || "";
  const tokenCount = Math.max(0, Math.floor(input.tokenCount ?? 0));
  const timeToResultMs = Math.max(0, Math.floor(input.timeToResultMs ?? 0));

  if (!questionId || !LOCKED_GOLD_QUESTION_IDS.includes(questionId as (typeof LOCKED_GOLD_QUESTION_IDS)[number])) {
    return blockedEvaluation({
      engineName: input.engineName,
      questionId: questionId || "custom",
      scoreStatus: "scoring_unavailable",
      tokenCount,
      timeToResultMs,
      notes: ["Custom or unlocked question id; gold scoring is unavailable.", ...(input.notes ?? [])]
    });
  }

  const gold = normalizeGoldInput(input.gold);
  if (gold.status === "missing") {
    return blockedEvaluation({
      engineName: input.engineName,
      questionId,
      scoreStatus: "blocked_missing_gold",
      tokenCount,
      timeToResultMs,
      notes: [...gold.errors, ...(input.notes ?? [])]
    });
  }

  if (gold.status === "invalid" || !gold.artifact) {
    return blockedEvaluation({
      engineName: input.engineName,
      questionId,
      scoreStatus: "blocked_invalid_gold",
      tokenCount,
      timeToResultMs,
      notes: [...gold.errors, ...(input.notes ?? [])]
    });
  }

  const answerGold = gold.artifact.answers.find((answer) => answer.question_id === questionId);
  if (!answerGold) {
    return blockedEvaluation({
      engineName: input.engineName,
      questionId,
      scoreStatus: "scoring_unavailable",
      tokenCount,
      timeToResultMs,
      notes: [`Validated gold artifact does not contain ${questionId}.`, ...(input.notes ?? [])]
    });
  }

  const answerText = input.finalAnswer ?? "";
  const sources = input.sourcesCited ?? [];
  const factHits = answerGold.must_hit_atomic_facts.filter((fact) => atomicFactHit(fact, answerText));
  const requiredSourceHits = answerGold.required_source_types.filter((source) => requiredSourceHit(source, sources));
  const unsourcedClaims = extractUnsourcedClaims(answerText, sources);
  const penaltyFlags = answerGold.penalize_if
    .filter((penalty) => penaltyTriggered(penalty, answerText))
    .map((penalty) => `penalty:${penalty}`);
  const hallucinationFlags = [...penaltyFlags];

  if (sources.length === 0 && unsourcedClaims.length > 0) {
    hallucinationFlags.push("answer_contains_claims_without_cited_sources");
  }

  const primarySourceCount = countPrimarySources(sources);
  const notes = [
    `fact_coverage=${factHits.length}/${answerGold.must_hit_atomic_facts.length}`,
    `required_source_type_coverage=${requiredSourceHits.length}/${answerGold.required_source_types.length}`,
    `primary_source_count=${primarySourceCount}`,
    `token_count=${tokenCount}`,
    ...(input.notes ?? [])
  ];

  return EvaluationResultSchema.parse({
    engine_name: input.engineName,
    question_id: questionId,
    score_status: "scored",
    facts_hit: factHits.length,
    facts_total: answerGold.must_hit_atomic_facts.length,
    required_source_types_hit: requiredSourceHits.length,
    required_source_types_total: answerGold.required_source_types.length,
    primary_source_count: primarySourceCount,
    hallucination_flags: hallucinationFlags,
    unsourced_claims: unsourcedClaims,
    token_count: tokenCount,
    time_to_result_ms: timeToResultMs,
    notes
  });
}

export function blockedEvaluation(options: BlockedEvaluationOptions): EvaluationResult {
  const status: ScoreStatus = options.scoreStatus;
  return EvaluationResultSchema.parse({
    engine_name: options.engineName,
    question_id: options.questionId,
    score_status: status,
    facts_hit: 0,
    facts_total: 0,
    required_source_types_hit: 0,
    required_source_types_total: 0,
    primary_source_count: 0,
    hallucination_flags: [],
    unsourced_claims: [],
    token_count: Math.max(0, Math.floor(options.tokenCount ?? 0)),
    time_to_result_ms: Math.max(0, Math.floor(options.timeToResultMs ?? 0)),
    notes: options.notes ?? []
  });
}

function normalizeGoldInput(
  gold: ScoreAgainstGoldInput["gold"]
): GoldLoadResult | (GoldValidationResult & { path?: string }) {
  if (!gold) {
    return {
      status: "missing",
      path: "",
      errors: ["Gold artifact was not provided."],
      warnings: []
    };
  }

  if ("status" in gold) {
    return gold as GoldLoadResult | GoldValidationResult;
  }

  return validateGoldArtifact(gold as GoldArtifact);
}

function atomicFactHit(fact: AtomicFact, answerText: string): boolean {
  const normalizedAnswer = normalizeText(answerText);
  const keywordHits = fact.keywords.filter((keyword) => normalizedAnswer.includes(normalizeText(keyword))).length;

  if (fact.keywords.length > 0) {
    const requiredHits = fact.keywords.length <= 2 ? fact.keywords.length : Math.ceil(fact.keywords.length * 0.75);
    if (keywordHits >= requiredHits) return true;
  }

  const factTokens = meaningfulTokens(fact.text);
  if (factTokens.length === 0) return false;

  const answerTokens = new Set(meaningfulTokens(answerText));
  const hits = factTokens.filter((token) => answerTokens.has(token)).length;
  return hits >= Math.max(3, Math.ceil(factTokens.length * 0.55));
}

function requiredSourceHit(required: RequiredSource, sources: CitedSource[]): boolean {
  if (required.type === "primary-document") {
    return sources.some(isPrimarySource);
  }

  if (required.type === "news") {
    return sources.some((source) => sourceMentionsNews(source));
  }

  return sources.some((source) => source.source_type === required.type);
}

function countPrimarySources(sources: CitedSource[]): number {
  const uniqueKeys = new Set<string>();
  for (const source of sources) {
    if (!isPrimarySource(source)) continue;
    uniqueKeys.add(source.url ?? `${source.source_name ?? "unknown"}:${source.title ?? ""}`);
  }
  return uniqueKeys.size;
}

function isPrimarySource(source: CitedSource): boolean {
  return (
    source.provenance === "primary" ||
    (source.source_type ? PRIMARY_SOURCE_TYPES.has(source.source_type) : false) ||
    (source.source_name ? PRIMARY_SOURCE_NAMES.has(source.source_name) : false)
  );
}

function sourceMentionsNews(source: CitedSource): boolean {
  const haystack = normalizeText([source.source_name, source.title, source.url].filter(Boolean).join(" "));
  return ["news", "reuters", "bloomberg", "apnews", "associated press", "nyt", "wsj"].some((needle) =>
    haystack.includes(normalizeText(needle))
  );
}

function penaltyTriggered(penalty: string, answerText: string): boolean {
  const normalizedPenalty = normalizeText(penalty);
  if (!normalizedPenalty) return false;

  const normalizedAnswer = normalizeText(answerText);
  if (normalizedAnswer.includes(normalizedPenalty)) return true;

  const penaltyTokens = meaningfulTokens(penalty);
  if (penaltyTokens.length < 3) return false;
  const answerTokens = new Set(meaningfulTokens(answerText));
  const hits = penaltyTokens.filter((token) => answerTokens.has(token)).length;
  return hits >= Math.ceil(penaltyTokens.length * 0.8);
}

function extractUnsourcedClaims(answerText: string, sources: CitedSource[]): string[] {
  if (sources.length > 0) return [];

  return splitSentences(answerText)
    .filter((sentence) => isClaimLike(sentence))
    .slice(0, 5);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isClaimLike(sentence: string): boolean {
  if (sentence.length < 35) return false;
  return (
    /\d/.test(sentence) ||
    /\b(because|caused|causes|reported|found|increased|decreased|shows|therefore|outperform|beats|proves)\b/i.test(
      sentence
    )
  );
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "was",
    "were",
    "with"
  ]);

  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 2 && !stopwords.has(token));
}
