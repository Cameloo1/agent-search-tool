import {
  EvaluationResultSchema,
  type CitedSource,
  type EvaluationResult,
  type GoldAnswer,
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
  const requiredHit = input.gold.required_source_types.filter((required) =>
    input.sources.some((source) => source.source_type === mapRequiredSourceType(required.type) || source.provenance === "primary")
  ).length;
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
    notes: ["Claim-level lexical scorer; human audit remains authoritative for benchmark publication."]
  });
}

function factHit(answer: string, factText: string, keywords: string[]): boolean {
  const terms = keywords.length ? keywords : factText.split(/[^a-z0-9]+/).filter((term) => term.length > 5).slice(0, 5);
  return terms.some((term) => answer.includes(normalize(term)));
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
  return sources.filter((source) => source.provenance === "primary" || ["filing", "government"].includes(source.source_type ?? "")).length;
}

function mapRequiredSourceType(type: GoldAnswer["required_source_types"][number]["type"]) {
  const map = {
    academic: "academic",
    news: "other",
    "primary-document": "filing",
    encyclopedic: "encyclopedic",
    forum: "forum",
    code: "code",
    filing: "filing",
    government: "government",
    medical: "medical"
  } as const;
  return map[type];
}

function inferUnsourcedClaims(answer: string, sources: ScoredSource[]): string[] {
  if (sources.length > 0) return [];
  return answer
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence.trim().length > 80)
    .slice(0, 3);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
