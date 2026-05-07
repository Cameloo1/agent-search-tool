import {
  ALLOWED_SOURCE_NAMES,
  RETRIEVAL_INTENTS,
  SubQuerySchema,
  type IntentObject,
  type LLMProvider,
  type PipelineRequest,
  type RetrievalIntent,
  type SourceDescriptor,
  type SourceName,
  type StructuredLLMCallTrace,
  type SubQuery
} from "@agent-search/shared";
import { buildStage2StrategyPrompt, structuredCall } from "@agent-search/llm";
import { z } from "zod";
import { stageError, type StageError } from "./errors.js";

export interface Stage2Result {
  subQueries: SubQuery[];
  errors: StageError[];
  warnings: string[];
  structuredLlmCalls: StructuredLLMCallTrace[];
}

export interface Stage2SourcePlanningOptions {
  sourceDescriptors?: SourceDescriptor[];
  preferredSourceIds?: SourceName[];
}

const StrategyLLMResponseSchema = z.object({
  sub_queries: z.array(
    z.object({
      sub_query: z.string().min(1),
      target_sources: z.array(z.string()).min(1),
      retrieval_intent: z.string().min(1),
      max_results: z.number().int().min(1).max(10)
    })
  ).min(1).max(8)
});

export async function buildQueryStrategy(
  request: Pick<PipelineRequest, "query" | "chat_history" | "memory_snippet">,
  intent: IntentObject,
  provider: LLMProvider,
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    now?: Date | string;
    maxSubQueries?: number;
    signal?: AbortSignal;
    reasoningEnabled?: boolean;
    sourceDescriptors?: SourceDescriptor[];
    preferredSourceIds?: SourceName[];
  } = {}
): Promise<Stage2Result> {
  const sourcePlanning = normalizeSourcePlanningOptions(options);
  const result = await structuredCall(
    provider,
    {
      task: "stage2_query_strategist",
      prompt: buildStage2StrategyPrompt({
        request,
        intent,
        now: options.now,
        maxSubQueries: options.maxSubQueries ?? 7,
        sourceDescriptors: sourcePlanning.sourceDescriptors
      }),
      schemaName: "QueryStrategyResponse",
      stage: "strategy",
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      reasoningEnabled: options.reasoningEnabled,
      metadata: { stage: "stage2", query: request.query, intent }
    },
    StrategyLLMResponseSchema,
    { maxAttempts: options.maxAttempts ?? 2, timeoutMs: options.timeoutMs, coerceOutput: coerceStrategyResponse }
  );

  if (result.ok) {
    const valid = normalizeLLMSubQueries(result.value.sub_queries, sourcePlanning);
    if (valid.length > 0) {
      return {
        subQueries: applyPreferredSources(
          broadenSubQueries(valid, request.query, intent, options.maxSubQueries ?? 7),
          request.query,
          sourcePlanning.preferredSourceIds,
          options.maxSubQueries ?? 7
        ),
        errors: [],
        warnings: result.errors.length > 0 ? ["Stage 2 normalized or repaired a structured strategy response before validation succeeded."] : [],
        structuredLlmCalls: result.attemptDiagnostics
      };
    }
  }

  return {
    subQueries: applyPreferredSources(
      broadenSubQueries(fallbackSubQueries(request.query, intent), request.query, intent, options.maxSubQueries ?? 7),
      request.query,
      sourcePlanning.preferredSourceIds,
      options.maxSubQueries ?? 7
    ),
    errors: [
      stageError("stage2_strategy", "LLM_SCHEMA_INVALID", "Query strategist failed validation; deterministic source-aware fallback used.", {
        provider: result.providerName,
        attempts: result.attempts,
        errors: result.errors
      })
    ],
    warnings: ["Stage 2 used deterministic fallback subqueries."],
    structuredLlmCalls: result.attemptDiagnostics
  };
}

function coerceStrategyResponse(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return { sub_queries: raw };
  }
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.sub_queries)) return raw;
  if (Array.isArray(record.subqueries)) return { ...record, sub_queries: record.subqueries };
  if (Array.isArray(record.queries)) return { ...record, sub_queries: record.queries };
  if (Array.isArray(record.query_strategy)) return { ...record, sub_queries: record.query_strategy };
  return raw;
}

function broadenSubQueries(subQueries: SubQuery[], query: string, intent: IntentObject, maxSubQueries: number): SubQuery[] {
  const lower = query.toLowerCase();
  const next = [...subQueries];
  const hasSource = (source: SourceName) => next.some((subQuery) => subQuery.target_sources.includes(source));
  const hasSourceFamily = (sources: SourceName[]) => sources.some(hasSource);
  const push = (candidate: SubQuery) => {
    if (next.length >= maxSubQueries) return;
    const duplicate = next.some(
      (subQuery) =>
        subQuery.sub_query.toLowerCase() === candidate.sub_query.toLowerCase() &&
        subQuery.target_sources.some((source) => candidate.target_sources.includes(source))
    );
    if (!duplicate) next.push(SubQuerySchema.parse(candidate));
  };

  const isShortFactQuery = query.trim().split(/\s+/).length <= 10;
  const isMarketOrCommodity =
    /(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel|commodity|commodities|inflation|rates|fed|treasury|market|prices?)/.test(
      lower
    );

  if ((isShortFactQuery || isMarketOrCommodity) && !hasSourceFamily(["wikipedia", "wikidata"])) {
    push({
      sub_query: `${query} background entities official context`,
      target_sources: ["wikipedia", "wikidata"],
      retrieval_intent: "definitional",
      max_results: 3
    });
  }

  if ((intent.query_type.includes("fresh-fact") || isMarketOrCommodity) && !hasSourceFamily(["official_docs", "data_gov"])) {
    push({
      sub_query: `${query} official data forecast statistics`,
      target_sources: ["official_docs", "data_gov"],
      retrieval_intent: "temporal",
      max_results: 5
    });
  }

  if ((isShortFactQuery || isMarketOrCommodity || intent.required_source_types.includes("academic")) && !hasSourceFamily(["openalex", "crossref"])) {
    push({
      sub_query: `${query} causes forecast analysis evidence`,
      target_sources: ["openalex", "crossref"],
      retrieval_intent: "corroborating",
      max_results: 4
    });
  }

  if (/(software|security|appsec|code|api|library|framework|github|vulnerability)/.test(lower) && !hasSource("github")) {
    push({
      sub_query: `${query} implementation examples documentation`,
      target_sources: ["github", "stack_exchange"],
      retrieval_intent: "corroborating",
      max_results: 4
    });
  }

  return next.slice(0, maxSubQueries);
}

export function fallbackSubQueries(query: string, intent: IntentObject): SubQuery[] {
  const lower = query.toLowerCase();
  if (isTradingNewsSpeedQuery(lower)) {
    return tradingNewsSpeedFallbackSubQueries();
  }

  if (isRetrievalPipelineQuery(lower)) {
    return retrievalPipelineFallbackSubQueries();
  }

  if (/(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel|commodity|commodities)/.test(lower)) {
    return oilFallbackSubQueries(query);
  }

  const sources = new Set<SourceName>();

  for (const sourceType of intent.required_source_types) {
    if (sourceType === "academic") ["arxiv", "semantic_scholar", "openalex", "crossref"].forEach((s) => sources.add(s as SourceName));
    if (sourceType === "medical") sources.add("pubmed");
    if (sourceType === "encyclopedic") sources.add("wikipedia");
    if (sourceType === "forum") ["stack_exchange", "hacker_news"].forEach((s) => sources.add(s as SourceName));
    if (sourceType === "code") sources.add("github");
    if (sourceType === "filing") sources.add("sec_edgar");
    if (sourceType === "government") ["official_docs", "data_gov", "wikidata"].forEach((s) => sources.add(s as SourceName));
    if (sourceType === "primary-document") ["official_docs", "data_gov", "sec_edgar", "wikidata", "openalex", "crossref"].forEach((s) => sources.add(s as SourceName));
  }

  if (/(debt|deficit|inflation|cbo|treasury|fred)/.test(lower)) ["official_docs", "data_gov", "openalex", "crossref"].forEach((s) => sources.add(s as SourceName));
  if (/(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel|commodity|commodities)/.test(lower)) {
    ["wikipedia", "wikidata", "data_gov", "openalex", "crossref"].forEach((s) => sources.add(s as SourceName));
  }
  if (/(appsec|owasp|nist|cisa|security|vibecode)/.test(lower)) ["official_docs", "github", "stack_exchange", "crossref"].forEach((s) => sources.add(s as SourceName));
  if (/(market|crash|downturn|trader|filing|edgar|co-location|macro)/.test(lower)) ["official_docs", "sec_edgar", "data_gov", "crossref", "wikipedia"].forEach((s) => sources.add(s as SourceName));
  if (/(duplicate|dedup|submodular|bayesian|embedding|truth discovery)/.test(lower)) ["arxiv", "semantic_scholar", "github", "crossref"].forEach((s) => sources.add(s as SourceName));
  if (sources.size === 0) ["wikipedia", "wikidata", "crossref"].forEach((s) => sources.add(s as SourceName));

  const targetSources = orderFallbackSources(Array.from(sources), lower).slice(0, 6);
  const subQueries: SubQuery[] = [
    {
      sub_query: rewriteFallbackQuery(query),
      target_sources: targetSources,
      retrieval_intent: intent.query_type.includes("source-attribution") ? "primary_evidence" : "corroborating",
      max_results: Math.min(6, Math.max(3, targetSources.length))
    }
  ];

  if (intent.query_type.includes("fresh-fact")) {
    subQueries.push({
      sub_query: `${query} latest official data projections`,
      target_sources: targetSources.filter((s) => ["data_gov", "sec_edgar", "openalex", "crossref"].includes(s)).slice(0, 4) as SourceName[],
      retrieval_intent: "temporal",
      max_results: 5
    });
  }

  if (intent.query_type.includes("adversarial")) {
    subQueries.push({
      sub_query: `${query} primary source evidence risks limitations`,
      target_sources: targetSources.filter((s) => !["hacker_news"].includes(s)).slice(0, 5),
      retrieval_intent: "contrarian",
      max_results: 4
    });
  }

  return subQueries
    .filter((subQuery) => subQuery.target_sources.length > 0)
    .map((subQuery) => SubQuerySchema.parse(subQuery))
    .slice(0, 6);
}

function oilFallbackSubQueries(query: string): SubQuery[] {
  return [
    {
      sub_query: "EIA Short-Term Energy Outlook crude oil Brent WTI price forecast supply demand inventory",
      target_sources: ["official_docs", "data_gov"],
      retrieval_intent: "temporal",
      max_results: 7
    },
    {
      sub_query: `${query} crude oil price forecast EIA Brent WTI supply demand inventory`,
      target_sources: ["data_gov", "official_docs"],
      retrieval_intent: "temporal",
      max_results: 6
    },
    {
      sub_query: `${query} OPEC Brent WTI crude oil supply demand background`,
      target_sources: ["wikipedia", "wikidata"],
      retrieval_intent: "definitional",
      max_results: 4
    },
    {
      sub_query: `${query} crude oil price forecast supply demand geopolitical risk analysis`,
      target_sources: ["openalex", "crossref"],
      retrieval_intent: "corroborating",
      max_results: 5
    },
    {
      sub_query: `${query} crude oil prices forecast literature supply shock demand shock`,
      target_sources: ["semantic_scholar", "arxiv"],
      retrieval_intent: "contrarian",
      max_results: 4
    }
  ].map((subQuery) => SubQuerySchema.parse(subQuery));
}

function tradingNewsSpeedFallbackSubQueries(): SubQuery[] {
  return [
    {
      sub_query: "SEC market structure direct exchange data feeds co-location public guidance",
      target_sources: ["official_docs"],
      retrieval_intent: "primary_evidence",
      max_results: 6
    },
    {
      sub_query: "SEC EDGAR access guidance public filings 8-K 10-Q 10-K fair access rate limits",
      target_sources: ["official_docs", "sec_edgar"],
      retrieval_intent: "primary_evidence",
      max_results: 5
    },
    {
      sub_query: "Federal Reserve FOMC BLS CPI macro release calendar expectations surprise trading",
      target_sources: ["official_docs", "data_gov"],
      retrieval_intent: "temporal",
      max_results: 6
    },
    {
      sub_query: "institutional traders market data feeds squawk news NLP entity mapping expectations versus surprise",
      target_sources: ["semantic_scholar", "openalex", "crossref"],
      retrieval_intent: "corroborating",
      max_results: 6
    },
    {
      sub_query: "material nonpublic information insider trading compliance public information SEC guidance",
      target_sources: ["official_docs", "sec_edgar"],
      retrieval_intent: "contrarian",
      max_results: 5
    }
  ].map((subQuery) => SubQuerySchema.parse(subQuery));
}

function retrievalPipelineFallbackSubQueries(): SubQuery[] {
  return [
    {
      sub_query: "domain specific duplicate detection entity resolution learned similarity claim overlap",
      target_sources: ["semantic_scholar", "arxiv", "crossref"],
      retrieval_intent: "primary_evidence",
      max_results: 6
    },
    {
      sub_query: "sentence transformers all-MiniLM-L6-v2 semantic similarity clustering embeddings",
      target_sources: ["official_docs", "github"],
      retrieval_intent: "primary_evidence",
      max_results: 5
    },
    {
      sub_query: "information theoretic novelty KL divergence Jensen Shannon divergence text summarization retrieval",
      target_sources: ["arxiv", "semantic_scholar", "crossref"],
      retrieval_intent: "corroborating",
      max_results: 6
    },
    {
      sub_query: "submodular optimization budgeted multi document summarization greedy coverage token budget",
      target_sources: ["arxiv", "semantic_scholar", "crossref"],
      retrieval_intent: "primary_evidence",
      max_results: 6
    },
    {
      sub_query: "truth discovery Bayesian source reliability source correlation consensus herding",
      target_sources: ["arxiv", "semantic_scholar", "crossref"],
      retrieval_intent: "primary_evidence",
      max_results: 6
    }
  ].map((subQuery) => SubQuerySchema.parse(subQuery));
}

function normalizeLLMSubQueries(
  subQueries: Array<{ sub_query: string; target_sources: string[]; retrieval_intent: string; max_results: number }>,
  sourcePlanning: Required<Stage2SourcePlanningOptions>
): SubQuery[] {
  return subQueries.flatMap((subQuery) => {
    const targetSources = uniqueSources(subQuery.target_sources.flatMap((source) => coerceSourceName(source, sourcePlanning.sourceDescriptors)));
    if (targetSources.length === 0) return [];
    const retrievalIntent = isRetrievalIntent(subQuery.retrieval_intent) ? subQuery.retrieval_intent : "corroborating";
    const parsed = SubQuerySchema.safeParse({
      sub_query: subQuery.sub_query,
      target_sources: targetSources.slice(0, 6),
      retrieval_intent: retrievalIntent,
      max_results: Math.min(10, Math.max(1, subQuery.max_results))
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function coerceSourceName(source: string, sourceDescriptors: SourceDescriptor[] = builtInSourceDescriptors()): SourceName[] {
  const lowerExact = source.toLowerCase().trim();
  const exactDescriptor = sourceDescriptors.find((descriptor) => descriptor.id.toLowerCase() === lowerExact);
  if (exactDescriptor) return [exactDescriptor.id];

  const normalized = source.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const normalizedDescriptor = sourceDescriptors.find((descriptor) => descriptor.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === normalized);
  if (normalizedDescriptor) return [normalizedDescriptor.id];

  if ((ALLOWED_SOURCE_NAMES as readonly string[]).includes(normalized)) return [normalized as SourceName];

  const aliases: Record<string, SourceName[]> = {
    eia: ["data_gov"],
    energy_information_administration: ["data_gov"],
    fred: ["data_gov"],
    bls: ["data_gov"],
    bea: ["data_gov"],
    opec: ["wikidata", "openalex"],
    iea: ["openalex", "crossref"],
    scholar: ["semantic_scholar", "openalex"],
    google_scholar: ["semantic_scholar", "openalex"],
    sec: ["sec_edgar"],
    edgar: ["sec_edgar"],
    wiki: ["wikipedia"],
    wikidata_sparql: ["wikidata"],
    government: ["data_gov"],
    official_data: ["data_gov"],
    official_docs: ["official_docs"],
    sec_gov: ["official_docs", "sec_edgar"],
    nist: ["official_docs"],
    cisa: ["official_docs"],
    owasp: ["official_docs"],
    eia_open_data: ["official_docs", "data_gov"],
    eia_steo: ["official_docs", "data_gov"],
    exchange_docs: ["official_docs"]
  };

  return aliases[normalized] ?? [];
}

function normalizeSourcePlanningOptions(options: Stage2SourcePlanningOptions): Required<Stage2SourcePlanningOptions> {
  const builtIns = builtInSourceDescriptors();
  const byId = new Map<string, SourceDescriptor>();
  for (const descriptor of [...builtIns, ...(options.sourceDescriptors ?? [])]) {
    byId.set(descriptor.id, descriptor);
  }
  const sourceDescriptors = Array.from(byId.values());
  const sourceIds = new Set(sourceDescriptors.map((descriptor) => descriptor.id));
  const preferredSourceIds = uniqueSources((options.preferredSourceIds ?? []).filter((source) => sourceIds.has(source)));
  return { sourceDescriptors, preferredSourceIds };
}

function builtInSourceDescriptors(): SourceDescriptor[] {
  return ALLOWED_SOURCE_NAMES.map((id) => ({ id, label: id, built_in: true }));
}

function applyPreferredSources(subQueries: SubQuery[], query: string, preferredSourceIds: SourceName[], maxSubQueries: number): SubQuery[] {
  if (preferredSourceIds.length === 0) return subQueries;
  const preferredSet = new Set(preferredSourceIds);
  const constrained = subQueries
    .map((subQuery) => {
      const target_sources = subQuery.target_sources.filter((source) => preferredSet.has(source));
      return target_sources.length > 0 ? { ...subQuery, target_sources } : null;
    })
    .filter((subQuery): subQuery is SubQuery => Boolean(subQuery));

  if (constrained.length > 0) return constrained.slice(0, maxSubQueries);

  return [
    SubQuerySchema.parse({
      sub_query: query,
      target_sources: preferredSourceIds.slice(0, 6),
      retrieval_intent: "primary_evidence",
      max_results: Math.min(10, Math.max(3, preferredSourceIds.length))
    })
  ];
}

function uniqueSources(sources: SourceName[]): SourceName[] {
  return Array.from(new Set(sources));
}

function isRetrievalIntent(value: string): value is RetrievalIntent {
  return (RETRIEVAL_INTENTS as readonly string[]).includes(value);
}

function rewriteFallbackQuery(query: string): string {
  const lower = query.toLowerCase();
  if (/(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel)/.test(lower)) {
    return `${query} crude oil prices forecast EIA OPEC Brent WTI supply demand inventory`;
  }
  return query;
}

function orderFallbackSources(sources: SourceName[], lowerQuery: string): SourceName[] {
  const priority = /(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel)/.test(lowerQuery)
    ? ["official_docs", "data_gov", "wikipedia", "wikidata", "openalex", "crossref", "semantic_scholar", "arxiv", "sec_edgar"]
    : isTradingNewsSpeedQuery(lowerQuery)
      ? ["official_docs", "sec_edgar", "data_gov", "semantic_scholar", "openalex", "crossref", "wikipedia"]
      : isRetrievalPipelineQuery(lowerQuery)
        ? ["official_docs", "semantic_scholar", "arxiv", "crossref", "github", "openalex"]
        : ALLOWED_SOURCE_NAMES;
  const orderedPriority = priority as readonly string[];
  return [
    ...orderedPriority.filter((source): source is SourceName => sources.includes(source as SourceName)),
    ...sources.filter((source) => !orderedPriority.includes(source))
  ];
}

function isTradingNewsSpeedQuery(lower: string): boolean {
  return /(institution|bank|trader|top traders|news updates|squawk|co-?location|direct feeds?|market data|edgar|macro releases?|competitive edge)/.test(lower);
}

function isRetrievalPipelineQuery(lower: string): boolean {
  return /(dedup|duplicates?|submodular|bayesian|source reliability|truth discovery|jensen|kl divergence|token budget|learned similarity)/.test(lower);
}
