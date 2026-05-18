import {
  EvaluationResultSchema,
  type CitedSource,
  type EvaluationResult,
  type GoldAnswer,
  type RequiredSource,
  type ScoreStatus
} from "@agent-search/shared";
export type ScoredSource = CitedSource;

export interface ScoreInput {
  engineName: string;
  questionId: string;
  finalAnswer: string;
  sources: ScoredSource[];
  tokenCount: number;
  timeToResultMs: number;
  gold?: GoldAnswer;
  scoreStatus?: ScoreStatus;
}

const PRIMARY_SOURCE_TYPES = new Set(["filing", "government", "medical", "code", "structured_fact"]);
const PRIMARY_SOURCE_NAMES = new Set(["sec_edgar", "data_gov", "github", "pubmed", "official_docs"]);
const ACADEMIC_SOURCE_NAMES = new Set(["arxiv", "semantic_scholar", "openalex", "crossref", "core"]);
const GOVERNMENT_SOURCE_NAMES = new Set(["sec_edgar", "data_gov", "official_docs"]);
const ENCYCLOPEDIC_SOURCE_NAMES = new Set(["wikipedia", "wikidata"]);
const FORUM_SOURCE_NAMES = new Set(["stack_exchange", "hacker_news"]);

const DESCRIPTOR_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "data",
  "doc",
  "docs",
  "document",
  "documents",
  "for",
  "from",
  "guidance",
  "if",
  "in",
  "include",
  "includes",
  "or",
  "official",
  "on",
  "source",
  "sources",
  "specific",
  "the",
  "to",
  "type",
  "when",
  "with"
]);

const DESCRIPTOR_ALIAS_GROUPS = [
  ["cbo", "congressional budget office"],
  ["treasury", "fiscal data", "fiscaldata"],
  ["fred", "federal reserve economic data"],
  ["iea", "international energy agency"],
  ["federal reserve", "fed"],
  ["owasp", "asvs"],
  ["nist", "ssdf"],
  ["cisa"],
  ["bls", "bureau of labor statistics"],
  ["sec", "securities and exchange commission"],
  ["edgar"],
  ["exchange", "nyse", "nasdaq", "cboe"],
  ["pubmed"],
  ["github"]
];

export function scoreAgainstGold(input: ScoreInput): EvaluationResult {
  if (!input.finalAnswer.trim()) {
    return EvaluationResultSchema.parse({
      engine_name: input.engineName,
      question_id: input.questionId,
      score_status: "scoring_unavailable",
      facts_hit: 0,
      facts_total: input.gold?.must_hit_atomic_facts.length ?? 0,
      required_source_types_hit: 0,
      required_source_types_total: input.gold?.required_source_types.length ?? 0,
      primary_source_count: countPrimarySources(input.sources),
      hallucination_flags: [],
      unsourced_claims: [],
      token_count: input.tokenCount,
      time_to_result_ms: input.timeToResultMs,
      notes: ["No answer was available to score."]
    });
  }

  if (!input.gold) {
    return EvaluationResultSchema.parse({
      engine_name: input.engineName,
      question_id: input.questionId,
      score_status: input.scoreStatus ?? "blocked_missing_gold",
      facts_hit: 0,
      facts_total: 0,
      required_source_types_hit: 0,
      required_source_types_total: 0,
      primary_source_count: countPrimarySources(input.sources),
      hallucination_flags: [],
      unsourced_claims: [],
      token_count: input.tokenCount,
      time_to_result_ms: input.timeToResultMs,
      notes: ["Gold artifact unavailable or invalid; comparison is not a valid benchmark score."]
    });
  }

  const answerText = normalize(input.finalAnswer);
  const factsHit = input.gold.must_hit_atomic_facts.filter((fact) => factHit(answerText, fact.text, fact.keywords)).length;
  const requiredHit = countRequiredSourceHits(input.gold.required_source_types, input.sources);
  const penalties = input.gold.penalize_if.filter((penalty) => penaltyTriggered(answerText, penalty));

  return EvaluationResultSchema.parse({
    engine_name: input.engineName,
    question_id: input.questionId,
    score_status: "scored",
    facts_hit: factsHit,
    facts_total: input.gold.must_hit_atomic_facts.length,
    required_source_types_hit: requiredHit,
    required_source_types_total: input.gold.required_source_types.length,
    primary_source_count: countPrimarySources(input.sources),
    hallucination_flags: penalties,
    unsourced_claims: inferUnsourcedClaims(input.finalAnswer, input.sources),
    token_count: input.tokenCount,
    time_to_result_ms: input.timeToResultMs,
    notes: [
      "Strict deterministic gold precheck; facts require concept coverage and required sources require distinct descriptor-matched citations.",
      "Human audit remains authoritative for benchmark publication."
    ]
  });
}

function factHit(answer: string, factText: string, keywords: string[]): boolean {
  const terms = keywords.map(normalize).filter(Boolean);
  if (terms.length > 0) {
    const hits = terms.filter((term) => normalizedIncludes(answer, term)).length;
    return hits >= requiredKeywordHits(factText, terms.length);
  }

  const factTokens = meaningfulTokens(factText);
  if (factTokens.length === 0) return false;
  const answerTokens = new Set(meaningfulTokens(answer));
  const hits = factTokens.filter((token) => answerTokens.has(token)).length;
  return hits >= Math.max(3, Math.ceil(factTokens.length * 0.6));
}

function requiredKeywordHits(factText: string, count: number): number {
  if (count <= 2) return count;
  if (/\bor\b|\/|\bequivalent\b/i.test(factText)) return Math.ceil(count * 0.5);
  return Math.ceil(count * 0.75);
}

function penaltyTriggered(answer: string, penalty: string): boolean {
  const lower = normalize(penalty);
  if (lower.includes("automatically") && lower.includes("hyperinflation")) return /automatic.*hyperinflation|hyperinflation.*automatic/.test(answer);
  if (lower.includes("llm scan as enough")) return /llm.*(enough|sufficient)|scan.*enough/.test(answer);
  if (lower.includes("insider news")) return /insider news|inside information/.test(answer);
  if (lower.includes("consensus as truth")) return /consensus.*truth/.test(answer);
  return false;
}

function countPrimarySources(sources: ScoredSource[]): number {
  return new Set(sources.filter(isPrimarySource).map(sourceKey)).size;
}

function countRequiredSourceHits(requiredSources: GoldAnswer["required_source_types"], sources: ScoredSource[]): number {
  const used = new Set<string>();
  let hits = 0;

  for (const required of requiredSources) {
    const match = sources.find((source) => {
      const key = sourceKey(source);
      return !used.has(key) && sourceSatisfiesRequiredSource(required, source);
    });

    if (match) {
      used.add(sourceKey(match));
      hits += 1;
    }
  }

  return hits;
}

function sourceSatisfiesRequiredSource(required: RequiredSource, source: ScoredSource): boolean {
  return sourceTypeCompatible(required.type, source) && sourceMatchesDescriptor(required, source);
}

function sourceTypeCompatible(type: RequiredSource["type"], source: ScoredSource): boolean {
  const sourceType = source.source_type;
  const sourceName = source.source_name;

  if (type === "academic") return sourceType === "academic" || inSet(sourceName, ACADEMIC_SOURCE_NAMES);
  if (type === "code") return sourceType === "code" || sourceName === "github";
  if (type === "encyclopedic") return sourceType === "encyclopedic" || inSet(sourceName, ENCYCLOPEDIC_SOURCE_NAMES);
  if (type === "filing") return sourceType === "filing" || sourceName === "sec_edgar";
  if (type === "forum") return sourceType === "forum" || sourceType === "tech_discussion" || inSet(sourceName, FORUM_SOURCE_NAMES);
  if (type === "government") return sourceType === "government" || inSet(sourceName, GOVERNMENT_SOURCE_NAMES);
  if (type === "medical") return sourceType === "medical" || sourceName === "pubmed";
  if (type === "news") return sourceMentionsNews(source);
  return isPrimarySource(source);
}

function sourceMatchesDescriptor(required: RequiredSource, source: ScoredSource): boolean {
  const haystack = sourceHaystack(source);
  const aliasGroups = descriptorAliasGroups(required.description);
  const aliasMatched = aliasGroups.length === 0 || aliasGroups.some((group) => group.some((alias) => normalizedIncludes(haystack, alias)));
  if (!aliasMatched && !descriptorAllowsEquivalent(required.description)) return false;

  const terms = descriptorTerms(required.description);
  if (terms.length === 0) return aliasMatched || isPrimarySource(source);

  const hits = terms.filter((term) => normalizedIncludes(haystack, term)).length;
  const threshold = aliasGroups.length > 0 || descriptorAllowsEquivalent(required.description)
    ? Math.min(2, terms.length)
    : Math.min(3, Math.max(1, Math.ceil(terms.length * 0.5)));
  return hits >= threshold;
}

function isPrimarySource(source: ScoredSource): boolean {
  return (
    source.provenance === "primary" ||
    (source.source_type ? PRIMARY_SOURCE_TYPES.has(source.source_type) : false) ||
    inSet(source.source_name, PRIMARY_SOURCE_NAMES)
  );
}

function sourceMentionsNews(source: ScoredSource): boolean {
  const haystack = sourceHaystack(source);
  return ["news", "reuters", "bloomberg", "apnews", "associated press", "nyt", "wsj", "wall street journal"].some((term) =>
    normalizedIncludes(haystack, term)
  );
}

function descriptorAllowsEquivalent(description: string): boolean {
  return /\b(equivalent|mainstream|or)\b/i.test(description);
}

function descriptorAliasGroups(description: string): string[][] {
  const normalizedDescription = normalize(description);
  return DESCRIPTOR_ALIAS_GROUPS
    .filter((group) => group.some((alias) => normalizedIncludes(normalizedDescription, normalize(alias))))
    .map((group) => group.map(normalize));
}

function descriptorTerms(description: string): string[] {
  const aliasTokens = new Set(descriptorAliasGroups(description).flatMap((group) => group.flatMap((alias) => alias.split(" "))));
  return meaningfulTokens(description).filter((term) => !aliasTokens.has(term) && !DESCRIPTOR_STOPWORDS.has(term));
}

function sourceHaystack(source: ScoredSource): string {
  return normalize([source.source_name, source.source_type, source.provenance, source.title, source.url].filter(Boolean).join(" "));
}

function sourceKey(source: ScoredSource): string {
  return normalize(source.url || `${source.source_name ?? "unknown"} ${source.title ?? ""}`);
}

function inSet(value: string | undefined, set: Set<string>): boolean {
  return Boolean(value && set.has(value));
}

function inferUnsourcedClaims(answer: string, sources: ScoredSource[]): string[] {
  if (sources.length > 0) return [];
  return answer
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence.trim().length > 80)
    .slice(0, 3);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedIncludes(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) return false;
  if (normalizedNeedle.includes(" ")) return haystack.includes(normalizedNeedle);
  return new RegExp(`(?:^| )${escapeRegExp(normalizedNeedle)}(?: |$)`).test(haystack);
}

function meaningfulTokens(text: string): string[] {
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
  return normalize(text)
    .split(" ")
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
