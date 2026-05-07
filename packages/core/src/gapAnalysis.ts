import {
  SubQuerySchema,
  type EvidenceHealth,
  type GapAnalysis,
  type IntentObject,
  type NormalizedChunk,
  type SourceName,
  type SubQuery,
  type Trace
} from "@agent-search/shared";

interface AnalyzeEvidenceGapsInput {
  query: string;
  intent: IntentObject;
  selectedChunks: NormalizedChunk[];
  filteredChunks: NormalizedChunk[];
  sourceResults: Trace["source_results"];
  evidenceHealth?: EvidenceHealth;
  roundIndex: number;
  maxRepairRounds: number;
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "because",
  "been",
  "being",
  "between",
  "could",
  "does",
  "doing",
  "down",
  "each",
  "exactly",
  "from",
  "have",
  "more",
  "most",
  "should",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "towards",
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);

export function analyzeEvidenceGaps(input: AnalyzeEvidenceGapsInput): GapAnalysis {
  const reasons: string[] = [];
  const badContextReasons: string[] = [];
  const selected = input.selectedChunks;
  const health = input.evidenceHealth;
  const averageRelevance = average(selected.map((chunk) => chunk._internal.relevance_to_query));
  const lowRelevanceIds = selected.filter((chunk) => chunk._internal.relevance_to_query < 0.18).map((chunk) => chunk.id);
  const keywordOnlyIds = selected.filter((chunk) => isKeywordOnlyMismatch(input.query, chunk)).map((chunk) => chunk.id);
  const sourceTypeGaps = health?.details.missing_required_source_types ?? [];
  const { hard: hardSourceTypeGaps, soft: softSourceTypeGaps } = classifySourceTypeGaps({
    query: input.query,
    intent: input.intent,
    evidenceHealth: health,
    sourceTypeGaps
  });
  const importantFailedSources = importantSourceFailures(input.sourceResults, input.query, input.intent);
  const facets = missingFacets(input.query, selected);
  const recommended = repairSubQueries(input.query, input.intent, facets, hardSourceTypeGaps, selected);
  const healthyEvidence = health ? ["adequate", "strong"].includes(health.status) : false;

  if (!selected.length) {
    reasons.push("No selected chunks survived retrieval, scoring, deduplication, and assembly.");
  }
  if (health && ["insufficient", "weak"].includes(health.status)) {
    reasons.push(`Evidence health is ${health.status}.`);
  }
  if (hardSourceTypeGaps.length > 0) {
    reasons.push(`Missing critical required source types: ${hardSourceTypeGaps.join(", ")}.`);
  }
  if (softSourceTypeGaps.length > 0) {
    reasons.push(`Adequate evidence; soft source gaps not repaired further: ${softSourceTypeGaps.join(", ")}.`);
  }
  if (averageRelevance > 0 && averageRelevance < 0.35) {
    reasons.push(`Average selected relevance is low (${averageRelevance.toFixed(2)}).`);
  }
  if (lowRelevanceIds.length > 0) {
    badContextReasons.push(`Selected chunks with near-zero contextual relevance: ${lowRelevanceIds.join(", ")}.`);
  }
  if (keywordOnlyIds.length > 0) {
    badContextReasons.push(`Selected chunks appear keyword-adjacent rather than answer-relevant: ${keywordOnlyIds.join(", ")}.`);
  }
  if (facets.length > 0) {
    reasons.push(`Missing answer facets: ${facets.join(", ")}.`);
  }
  if (importantFailedSources.length > 0) {
    reasons.push(`Important source failures may block answerability: ${importantFailedSources.join(", ")}.`);
  }

  const criticalGaps =
    selected.length === 0 ||
    (health ? ["insufficient", "weak"].includes(health.status) : false) ||
    badContextReasons.length > 0 ||
    hardSourceTypeGaps.length > 0 ||
    facets.length > 0 ||
    importantFailedSources.length > 0 ||
    averageRelevance < 0.25;
  const canRetry = input.roundIndex < input.maxRepairRounds && recommended.length > 0;
  const shouldRetry = criticalGaps && canRetry;
  const stopReason = shouldRetry
    ? "retryable_critical_gaps"
    : criticalGaps
      ? "critical_gaps_not_retryable"
      : healthyEvidence && softSourceTypeGaps.length > 0
        ? "adequate_with_soft_gaps"
        : "no_retryable_gaps";

  return {
    status: shouldRetry ? "retry_retrieval" : criticalGaps ? "synthesize_cautiously" : "no_retry",
    should_retry: shouldRetry,
    should_synthesize_cautiously: criticalGaps && !shouldRetry,
    missing_facets: facets,
    source_type_gaps: sourceTypeGaps,
    hard_source_type_gaps: hardSourceTypeGaps,
    soft_source_type_gaps: softSourceTypeGaps,
    stop_reason: stopReason,
    bad_context_reasons: badContextReasons,
    keyword_only_chunk_ids: keywordOnlyIds,
    important_failed_sources: importantFailedSources,
    recommended_sub_queries: dedupeSubQueries(recommended).slice(0, 7),
    reasons: [...reasons, ...badContextReasons]
  };
}

function classifySourceTypeGaps(input: {
  query: string;
  intent: IntentObject;
  evidenceHealth?: EvidenceHealth;
  sourceTypeGaps: IntentObject["required_source_types"];
}): { hard: IntentObject["required_source_types"]; soft: IntentObject["required_source_types"] } {
  const hard: IntentObject["required_source_types"] = [];
  const soft: IntentObject["required_source_types"] = [];
  const lower = input.query.toLowerCase();
  const healthyEvidence = input.evidenceHealth ? ["adequate", "strong"].includes(input.evidenceHealth.status) : false;
  const matched = new Set(input.evidenceHealth?.details.matched_required_source_types ?? []);
  const hasOfficialOrAcademicForAppSec =
    isAppSec(lower) &&
    healthyEvidence &&
    (matched.has("academic") || (input.evidenceHealth?.details.distinct_source_count ?? 0) >= 2) &&
    (matched.has("primary-document") || (input.evidenceHealth?.details.primary_source_count ?? 0) > 0);

  for (const gap of input.sourceTypeGaps) {
    if (gap === "code" && hasOfficialOrAcademicForAppSec) {
      soft.push(gap);
      continue;
    }
    if (gap === "encyclopedic" && (healthyEvidence || hasOfficialOrAcademicForAppSec)) {
      soft.push(gap);
      continue;
    }
    if (gap === "forum" && healthyEvidence) {
      soft.push(gap);
      continue;
    }
    if (gap === "code" && !needsCodeEvidence(lower, input.intent) && healthyEvidence) {
      soft.push(gap);
      continue;
    }
    if (gap === "news") {
      soft.push(gap);
      continue;
    }
    if (["primary-document", "government", "filing", "medical"].includes(gap)) {
      hard.push(gap);
      continue;
    }
    if (gap === "academic" && (input.intent.query_type.includes("academic") || input.intent.query_type.includes("source-attribution"))) {
      hard.push(gap);
      continue;
    }
    if (!healthyEvidence) hard.push(gap);
    else soft.push(gap);
  }

  return { hard, soft };
}

function needsCodeEvidence(lower: string, intent: IntentObject): boolean {
  return (
    intent.required_source_types.includes("code") &&
    /(repository|github|code sample|implementation|library|sdk|api|package|framework|test file|scanner rule)/.test(lower)
  );
}

function repairSubQueries(
  query: string,
  intent: IntentObject,
  missing: string[],
  sourceTypeGaps: IntentObject["required_source_types"],
  selectedChunks: NormalizedChunk[]
): SubQuery[] {
  const lower = query.toLowerCase();
  const queries: SubQuery[] = [];
  const add = (sub_query: string, target_sources: SourceName[], retrieval_intent: SubQuery["retrieval_intent"], max_results = 5) => {
    queries.push(SubQuerySchema.parse({ sub_query, target_sources, retrieval_intent, max_results }));
  };

  if (isTradingNewsSpeed(lower)) {
    add("SEC market structure direct feeds co-location exchange data feeds public guidance", ["official_docs"], "primary_evidence", 6);
    add("SEC EDGAR access guidance public filings fair access rate limits", ["official_docs", "sec_edgar"], "primary_evidence", 5);
    add("Federal Reserve FOMC calendar CPI BLS scheduled macro releases market surprise", ["official_docs", "data_gov"], "temporal", 6);
    add("exchange direct market data feed order book co-location documentation", ["official_docs"], "primary_evidence", 5);
    add("institutional market data feeds news squawk expectations versus surprise market microstructure", ["semantic_scholar", "openalex", "crossref"], "corroborating", 6);
    add("material nonpublic information trading compliance SEC insider trading public information", ["official_docs", "sec_edgar"], "contrarian", 5);
  } else if (isRankFusionRerankingQuestion(lower)) {
    add("Reciprocal Rank Fusion RRF hybrid retrieval BM25 dense sparse benchmark", ["semantic_scholar", "arxiv", "crossref"], "primary_evidence", 6);
    add("cross-encoder reranking learned reranker retrieval augmented generation benchmark", ["semantic_scholar", "arxiv", "crossref"], "primary_evidence", 6);
    add("open source RAG implementation RRF cross encoder reranking benchmark GitHub", ["github", "semantic_scholar", "arxiv"], "corroborating", 6);
  } else if (isRetrievalArchitecture(lower)) {
    add("domain specific duplicate detection entity resolution claim overlap learned similarity", ["semantic_scholar", "arxiv", "crossref"], "primary_evidence", 6);
    add("sentence transformers all-MiniLM-L6-v2 semantic similarity clustering model card", ["official_docs", "github"], "primary_evidence", 5);
    add("information theoretic novelty KL divergence Jensen Shannon divergence retrieval summarization", ["arxiv", "semantic_scholar", "crossref"], "corroborating", 6);
    add("submodular optimization budgeted multi document summarization token budget greedy selection", ["arxiv", "semantic_scholar", "crossref"], "primary_evidence", 6);
    add("truth discovery Bayesian source reliability source correlation consensus herding", ["arxiv", "semantic_scholar", "crossref"], "primary_evidence", 6);
    add("RAG context relevance faithfulness retrieval evaluation RAGAS corrective RAG self RAG", ["arxiv", "semantic_scholar", "github"], "corroborating", 6);
  } else if (isOil(lower)) {
    add("EIA Short-Term Energy Outlook crude oil Brent WTI price forecast supply demand inventory", ["official_docs", "data_gov"], "temporal", 7);
    add("EIA petroleum crude oil prices inventories production consumption forecast", ["official_docs", "data_gov"], "primary_evidence", 7);
    add("crude oil price forecast supply demand OPEC inventory geopolitical risk academic evidence", ["semantic_scholar", "openalex", "crossref"], "corroborating", 5);
  } else if (isAppSec(lower)) {
    add("OWASP Top 10 broken access control injection security misconfiguration vulnerable dependencies", ["official_docs"], "primary_evidence", 5);
    add("OWASP ASVS verification standard authentication authorization input validation release gate", ["official_docs"], "primary_evidence", 5);
    add("NIST SSDF secure software development framework pre production testing SDLC", ["official_docs"], "primary_evidence", 5);
    add("CISA secure by design software security guidance production readiness", ["official_docs"], "corroborating", 5);
  } else if (isFiscalAi(lower)) {
    add("CBO long-term budget outlook deficits debt net interest costs projections", ["official_docs", "data_gov"], "primary_evidence", 6);
    add("Treasury Fiscal Data interest costs debt public data", ["official_docs", "data_gov"], "primary_evidence", 5);
    add("AI data center electricity demand energy infrastructure IEA academic evidence", ["openalex", "crossref", "semantic_scholar"], "corroborating", 5);
  }

  for (const sourceType of sourceTypeGaps) {
    if (sourceType === "government" || sourceType === "primary-document") {
      add(`${query} official primary source guidance data`, ["official_docs", "data_gov"], "primary_evidence", 5);
    }
    if (sourceType === "academic") {
      add(`${query} academic paper evidence mechanism`, ["semantic_scholar", "openalex", "crossref"], "corroborating", 5);
    }
    if (sourceType === "filing") {
      add(`${query} SEC filing EDGAR disclosure`, ["sec_edgar", "official_docs"], "primary_evidence", 4);
    }
  }

  if (queries.length === 0 && (missing.length > 0 || selectedChunks.length < 3)) {
    add(`${query} official primary source evidence`, ["official_docs", "data_gov"], "primary_evidence", 5);
    add(`${query} academic evidence mechanism`, ["semantic_scholar", "openalex", "crossref"], "corroborating", 5);
  }

  if (intent.query_type.includes("adversarial")) {
    add(`${query} limitations risks legal boundaries primary source`, ["official_docs", "sec_edgar", "data_gov"], "contrarian", 5);
  }

  return queries;
}

function missingFacets(query: string, selected: NormalizedChunk[]): string[] {
  const lower = query.toLowerCase();
  const text = selected.map((chunk) => `${chunk.metadata.title ?? ""} ${chunk.content}`).join(" ").toLowerCase();
  const expected = expectedFacets(lower);
  return expected.filter((facet) => !facet.terms.some((term) => text.includes(term))).map((facet) => facet.name);
}

function expectedFacets(lowerQuery: string): Array<{ name: string; terms: string[] }> {
  if (isTradingNewsSpeed(lowerQuery)) {
    return [
      { name: "direct feeds/co-location", terms: ["direct feed", "co-location", "colocation", "exchange data"] },
      { name: "scheduled macro releases", terms: ["fomc", "cpi", "macro", "scheduled", "release calendar"] },
      { name: "SEC filings/EDGAR", terms: ["edgar", "8-k", "10-q", "filing", "disclosure"] },
      { name: "expectations versus surprise", terms: ["surprise", "expectation", "consensus"] },
      { name: "legal/compliance boundaries", terms: ["material nonpublic", "insider", "compliance", "legal"] }
    ];
  }
  if (isRankFusionRerankingQuestion(lowerQuery)) {
    return [
      { name: "RRF or rank-fusion evidence", terms: ["rrf", "reciprocal rank fusion", "rank fusion", "hybrid retrieval"] },
      { name: "learned cross-encoder reranking", terms: ["cross-encoder", "cross encoder", "rerank", "reranker"] },
      { name: "speed/quality trade-off", terms: ["latency", "compute", "cost", "speed", "precision", "quality", "trade-off", "tradeoff"] },
      { name: "open-source benchmark evidence", terms: ["open-source", "open source", "github", "benchmark", "trec", "beir", "rag implementation"] }
    ];
  }
  if (isRetrievalArchitecture(lowerQuery)) {
    return [
      { name: "claim-level duplication", terms: ["claim-level", "claim overlap", "atomic claim"] },
      { name: "information-theoretic novelty", terms: ["kl", "jensen", "information-theoretic", "divergence"] },
      { name: "submodular selection", terms: ["submodular", "budgeted", "greedy", "coverage"] },
      { name: "Bayesian reliability", terms: ["bayesian", "truth discovery", "source reliability", "consensus"] }
    ];
  }
  if (isOil(lowerQuery)) {
    return [
      { name: "official forecast", terms: ["eia", "forecast", "outlook", "steo"] },
      { name: "supply-demand mechanism", terms: ["supply", "demand", "inventory", "production", "consumption"] }
    ];
  }
  return [];
}

function importantSourceFailures(
  sourceResults: Trace["source_results"],
  query: string,
  intent: IntentObject
): SourceName[] {
  const important = new Set<SourceName>();
  const lower = query.toLowerCase();
  if (isTradingNewsSpeed(lower)) ["official_docs", "sec_edgar", "data_gov"].forEach((source) => important.add(source as SourceName));
  if (isOil(lower)) ["official_docs", "data_gov"].forEach((source) => important.add(source as SourceName));
  if (isAppSec(lower)) important.add("official_docs");
  if (isFiscalAi(lower)) ["official_docs", "data_gov"].forEach((source) => important.add(source as SourceName));
  if (intent.required_source_types.includes("filing")) important.add("sec_edgar");
  if (intent.required_source_types.includes("government")) {
    important.add("data_gov");
    important.add("official_docs");
  }
  return [...important].filter((source) => {
    const result = sourceResults[source];
    return result ? result.queried > 0 && result.ok === 0 && result.failed > 0 : false;
  });
}

function isKeywordOnlyMismatch(query: string, chunk: NormalizedChunk): boolean {
  if (chunk._internal.relevance_to_query < 0.18) return true;
  const queryTerms = [...terms(query)].filter((term) => !STOPWORDS.has(term));
  if (queryTerms.length < 4) return false;
  const contentTerms = terms(`${chunk.metadata.title ?? ""} ${chunk.content}`);
  const hits = queryTerms.filter((term) => contentTerms.has(term)).length;
  const title = (chunk.metadata.title ?? "").toLowerCase();
  const aboutAuthor = /about the author|author biography|editorial board|copyright|terms of use/.test(title);
  return aboutAuthor || (hits <= 1 && chunk._internal.relevance_to_query < 0.35);
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
}

function isTradingNewsSpeed(lower: string): boolean {
  return /(institution|bank|trader|top traders|news|squawk|co-?location|direct feed|edgar|macro release|market data)/.test(lower);
}

function isRankFusionRerankingQuestion(lower: string): boolean {
  return /(rrf|reciprocal rank fusion|rank fusion|cross[- ]?encoder|rerank|reranker|hybrid retrieval|rag implementation|rag benchmarks?)/.test(lower);
}

function isRetrievalArchitecture(lower: string): boolean {
  return /(dedup|duplicates?|submodular|bayesian|source reliability|truth discovery|jensen|kl divergence|token budget|learned similarity)/.test(lower);
}

function isOil(lower: string): boolean {
  return /(oil|crude|wti|brent|opec|petroleum|gasoline)/.test(lower);
}

function isAppSec(lower: string): boolean {
  return /(appsec|owasp|asvs|nist|cisa|vibecode|security|webhook|sast|dast|sca)/.test(lower);
}

function isFiscalAi(lower: string): boolean {
  return /(debt|deficit|cbo|treasury|inflation|fiscal|ai productivity|data center|electricity)/.test(lower);
}

function dedupeSubQueries(subQueries: SubQuery[]): SubQuery[] {
  const seen = new Set<string>();
  return subQueries.filter((subQuery) => {
    const key = `${subQuery.sub_query.toLowerCase()}::${subQuery.target_sources.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
