import {
  DEFAULTS,
  NormalizedChunkSchema,
  getSourceWeight,
  type ExtractionMetadata,
  type IntentObject,
  type LLMProvider,
  type NormalizedChunk,
  type PipelineRequest,
  type Stage6BatchDiagnostics,
  type StructuredLLMCallTrace
} from "@agent-search/shared";
import { ChunkScoringResponseSchema, buildStage6ChunkScoringPrompt, structuredCall } from "@agent-search/llm";
import { stageError, type StageError } from "./errors.js";
import { createHash } from "node:crypto";

export interface Stage6Options {
  timeoutMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  scoringConcurrency?: number;
  stageLabel?: string;
  scoringThreshold?: number;
  now?: Date | string;
  signal?: AbortSignal;
  reasoningEnabled?: boolean;
  onProgress?: (event: import("@agent-search/shared").PipelineProgressEvent) => void | Promise<void>;
}

export interface Stage6Result {
  chunks: NormalizedChunk[];
  filteredOut: NormalizedChunk[];
  errors: StageError[];
  warnings: string[];
  diagnostics: Stage6BatchDiagnostics[];
  structuredLlmCalls: StructuredLLMCallTrace[];
}

interface ScoringBatch {
  index: number;
  start: number;
  chunks: NormalizedChunk[];
}

interface ScoringBatchResult {
  index: number;
  scored: NormalizedChunk[];
  filteredOut: NormalizedChunk[];
  errors: StageError[];
  warnings: string[];
  diagnostics: Stage6BatchDiagnostics;
  structuredLlmCalls: StructuredLLMCallTrace[];
}

const SCORING_CACHE_SCHEMA_VERSION = "stage6-score-v2";
const MAX_SCORING_CACHE_ENTRIES = 2_000;
const scoringCache = new Map<string, NormalizedChunk>();

export function clearStage6ScoringCache(): void {
  scoringCache.clear();
}

export async function scoreChunks(
  chunks: NormalizedChunk[],
  request: Pick<PipelineRequest, "query" | "memory_snippet">,
  intent: IntentObject,
  provider: LLMProvider,
  options: Stage6Options = {}
): Promise<Stage6Result> {
  const batchSize = options.batchSize ?? 8;
  const stageLabel = options.stageLabel ?? "stage6_score";
  const threshold = options.scoringThreshold ?? 0.2;
  const cacheContext = scoringCacheContext(request.query, intent, provider.model ?? provider.name);
  const cached = readCachedScores(chunks, cacheContext);
  const batches = makeBatches(cached.misses, batchSize);
  const concurrency = Math.max(1, Math.min(options.scoringConcurrency ?? DEFAULTS.stage6ScoringConcurrency, batches.length || 1));
  const scored: NormalizedChunk[] = [];
  let filteredOut: NormalizedChunk[] = [];
  const errors: StageError[] = [];
  const warnings: string[] = [];
  const diagnostics: Stage6BatchDiagnostics[] = [];
  const structuredLlmCalls: StructuredLLMCallTrace[] = [];

  for (const chunk of cached.hits) {
    if (combinedScore(chunk) >= threshold) scored.push(chunk);
    else filteredOut.push(chunk);
  }

  if (cached.hits.length > 0) {
    await emit(options.onProgress, {
      type: "stage_progress",
      stage: stageLabel,
      message: `Reused cached Stage 6 scores for ${cached.hits.length}/${chunks.length} chunk(s).`,
      at: new Date().toISOString(),
      details: {
        cache_hit_count: cached.hits.length,
        cache_miss_count: cached.misses.length,
        cached_chunk_ids: cached.hits.map((chunk) => chunk.id)
      }
    });
    diagnostics.push(cacheDiagnostics(stageLabel, cached, concurrency, scored.length, filteredOut.length));
  }

  if (chunks.length === 0) {
    return { chunks: [], filteredOut: [], errors: [], warnings: [], diagnostics: [], structuredLlmCalls: [] };
  }

  if (batches.length === 0) {
    return { chunks: scored, filteredOut, errors, warnings, diagnostics, structuredLlmCalls };
  }

  await emit(options.onProgress, {
    type: "stage_progress",
    stage: stageLabel,
    message: `Scoring ${cached.misses.length} uncached candidate chunk(s) across ${batches.length} batch(es) with concurrency ${concurrency}.`,
    at: new Date().toISOString(),
    details: {
      batch_count: batches.length,
      scoring_concurrency: concurrency,
      batch_size: batchSize,
      cache_hit_count: cached.hits.length,
      cache_miss_count: cached.misses.length
    }
  });

  const batchResults = await runScoringBatches(batches, concurrency, options.signal, (batch) =>
    scoreBatch(batch, {
      request,
      intent,
      provider,
      options,
      threshold,
      stageLabel,
      batchCount: batches.length,
      concurrency
    })
  );

  for (const batchResult of batchResults.sort((a, b) => a.index - b.index)) {
    scored.push(...batchResult.scored);
    filteredOut.push(...batchResult.filteredOut);
    errors.push(...batchResult.errors);
    warnings.push(...batchResult.warnings);
    diagnostics.push(batchResult.diagnostics);
    structuredLlmCalls.push(...batchResult.structuredLlmCalls);
    for (const chunk of [...batchResult.scored, ...batchResult.filteredOut]) {
      writeCachedScore(chunk, cacheContext);
    }
  }

  if (scored.length === 0 && filteredOut.length > 0) {
    const rescued = rescueBestAvailable(filteredOut, intent, Math.min(6, filteredOut.length), threshold);
    const rescuedIds = new Set(rescued.map((chunk) => chunk.id));
    scored.push(...rescued);
    filteredOut = filteredOut.filter((chunk) => !rescuedIds.has(chunk.id));
    if (rescued.length > 0) {
      warnings.push("Stage 6 rescued weak-but-plausible chunks because every candidate fell below the scoring threshold.");
    } else {
      warnings.push("Stage 6 did not rescue any chunks because all candidates had near-zero contextual relevance.");
    }
  }
  const coverageRescued = rescueMissingRequiredCoverage(scored, filteredOut, intent, threshold);
  if (coverageRescued.length > 0) {
    const rescuedIds = new Set(coverageRescued.map((chunk) => chunk.id));
    scored.push(...coverageRescued);
    filteredOut = filteredOut.filter((chunk) => !rescuedIds.has(chunk.id));
    warnings.push("Stage 6 rescued chunks for missing required source-type coverage.");
  }

  return { chunks: scored, filteredOut, errors, warnings, diagnostics, structuredLlmCalls };
}

async function scoreBatch(
  batch: ScoringBatch,
  input: {
    request: Pick<PipelineRequest, "query" | "memory_snippet">;
    intent: IntentObject;
    provider: LLMProvider;
    options: Stage6Options;
    threshold: number;
    stageLabel: string;
    batchCount: number;
    concurrency: number;
  }
): Promise<ScoringBatchResult> {
  const started = Date.now();
  const batchErrors: StageError[] = [];
  const batchWarnings: string[] = [];
  const localScored: NormalizedChunk[] = [];
  const localFiltered: NormalizedChunk[] = [];
  const batchNumber = batch.index + 1;
  const batchChunks = batch.chunks;

  await emit(input.options.onProgress, {
      type: "stage_progress",
      stage: input.stageLabel,
      message: `Scoring chunk batch ${batchNumber}/${input.batchCount} (${batchChunks.length} chunk(s)).`,
      at: new Date().toISOString(),
      details: {
        batch_start: batch.start,
        batch_size: batchChunks.length,
        total_batches: input.batchCount,
        scoring_concurrency: input.concurrency,
        fallback_available: true
      }
  });
  const result = await structuredCall(
    input.provider,
    {
      task: "stage6_quality_relevance_scorer",
      prompt: buildStage6ChunkScoringPrompt({ request: input.request, intent: input.intent, chunks: batchChunks, now: input.options.now }),
      schemaName: "ChunkScoringResponse",
      stage: "scoring",
      timeoutMs: input.options.timeoutMs,
      signal: input.options.signal,
      reasoningEnabled: input.options.reasoningEnabled,
      metadata: { stage: input.stageLabel, batchStart: batch.start, chunkIds: batchChunks.map((chunk) => chunk.id) }
    },
    ChunkScoringResponseSchema,
    { maxAttempts: input.options.maxAttempts ?? 2, timeoutMs: input.options.timeoutMs }
  );

  const scoreById = new Map(result.ok ? result.value.scores.map((score) => [score.chunk_id, score]) : []);
  const missingScoredIds = result.ok ? batchChunks.filter((chunk) => !scoreById.has(chunk.id)).map((chunk) => chunk.id) : [];
  if (!result.ok || (result.ok && missingScoredIds.length === batchChunks.length && result.value.scores.length > 0)) {
    batchErrors.push(
      stageError("stage6_score", "LLM_SCHEMA_INVALID", "Chunk scoring batch failed validation; fallback scoring used.", {
        provider: result.providerName,
        attempts: result.attempts,
        errors: result.errors,
        missing_chunk_ids: missingScoredIds,
        chunk_ids: batchChunks.map((chunk) => chunk.id)
      })
    );
    batchWarnings.push(`Stage 6 used fallback scoring for ${batchChunks.length} chunks.`);
    await emit(input.options.onProgress, {
      type: "stage_progress",
      stage: input.stageLabel,
      message: `Scoring batch ${batchNumber} fell back to deterministic scoring after structured LLM validation failed.`,
      at: new Date().toISOString(),
      details: {
        batch_start: batch.start,
        batch_size: batchChunks.length,
        attempts: result.attempts,
        fallback_used: true
      }
    });
  } else if (missingScoredIds.length > 0) {
    batchWarnings.push(`Stage 6 scorer omitted ${missingScoredIds.length} chunk id(s); deterministic fallback filled those scores.`);
  }

  for (const chunk of batchChunks) {
      const score = scoreById.get(chunk.id);
      const fallback = fallbackScore(chunk, input.request.query);
      const relevanceToQuery = applyContextualRelevanceGuard(
        score?.relevance_to_query ?? fallback.relevance_to_query,
        chunk,
        input.request.query
      );
      const rawNext = NormalizedChunkSchema.parse({
        ...chunk,
        metadata: {
          ...chunk.metadata,
          confidence_score: score?.confidence_score ?? fallback.confidence_score,
          summary: score?.summary ?? chunk.metadata.summary,
          claim_graph: score?.claim_graph?.length ? score.claim_graph : fallback.claim_graph,
          epistemic_stance: score?.epistemic_stance ?? chunk.metadata.epistemic_stance,
          surprise_score: score?.surprise_score ?? fallback.surprise_score
        },
        _internal: {
          ...chunk._internal,
          relevance_to_query: relevanceToQuery,
          source_weight: getSourceWeight(chunk.metadata.source_name, chunk.metadata.source_type),
          freshness_fitness: score?.freshness_fitness ?? fallback.freshness_fitness
        }
      });
      const next = applyExtractionTreatment(rawNext);
      const combined =
        next._internal.relevance_to_query *
        next._internal.source_weight *
        next.metadata.confidence_score *
        Math.max(0.4, next._internal.freshness_fitness);
      if (combined >= input.threshold) localScored.push(next);
      else localFiltered.push(next);
    }
  await emit(input.options.onProgress, {
      type: "stage_progress",
      stage: input.stageLabel,
      message: `Scoring batch ${batchNumber} complete: ${localScored.length} kept, ${localFiltered.length} filtered.`,
      at: new Date().toISOString(),
      details: {
        kept_count: localScored.length,
        filtered_count: localFiltered.length,
        total_chunks: batchChunks.length
      }
    });

  return {
    index: batch.index,
    scored: localScored,
    filteredOut: localFiltered,
    errors: batchErrors,
    warnings: batchWarnings,
    diagnostics: {
      stage_label: input.stageLabel,
      batch_index: batch.index,
      batch_start: batch.start,
      chunk_count: batchChunks.length,
      kept_count: localScored.length,
      filtered_count: localFiltered.length,
      duration_ms: Date.now() - started,
      attempts: result.attempts,
      fallback_used: batchErrors.length > 0,
      total_tokens: result.metadata.reduce((sum, item) => sum + (item.usage?.total_tokens ?? 0), 0),
      concurrency: input.concurrency,
      cache_hit_count: 0,
      cache_miss_count: batchChunks.length,
      cached_chunk_ids: []
    },
    structuredLlmCalls: result.attemptDiagnostics
  };
}

function makeBatches(chunks: NormalizedChunk[], batchSize: number): ScoringBatch[] {
  const safeBatchSize = Math.max(1, Math.trunc(batchSize));
  const batches: ScoringBatch[] = [];
  for (let start = 0; start < chunks.length; start += safeBatchSize) {
    batches.push({ index: batches.length, start, chunks: chunks.slice(start, start + safeBatchSize) });
  }
  return batches;
}

function scoringCacheContext(query: string, intent: IntentObject, model: string): string {
  return hashText(
    JSON.stringify({
      version: SCORING_CACHE_SCHEMA_VERSION,
      query: query.trim().toLowerCase(),
      intent,
      model
    })
  );
}

function readCachedScores(chunks: NormalizedChunk[], context: string): { hits: NormalizedChunk[]; misses: NormalizedChunk[] } {
  const hits: NormalizedChunk[] = [];
  const misses: NormalizedChunk[] = [];
  for (const chunk of chunks) {
    const key = scoringCacheKey(context, chunk);
    const cached = scoringCache.get(key);
    if (cached) {
      scoringCache.delete(key);
      scoringCache.set(key, cached);
      hits.push(NormalizedChunkSchema.parse({ ...cached, id: chunk.id }));
    } else {
      misses.push(chunk);
    }
  }
  return { hits, misses };
}

function writeCachedScore(chunk: NormalizedChunk, context: string): void {
  const key = scoringCacheKey(context, chunk);
  scoringCache.set(key, chunk);
  while (scoringCache.size > MAX_SCORING_CACHE_ENTRIES) {
    const oldest = scoringCache.keys().next().value;
    if (!oldest) break;
    scoringCache.delete(oldest);
  }
}

function scoringCacheKey(context: string, chunk: NormalizedChunk): string {
  return `${context}:${hashText(
    JSON.stringify({
      source: chunk.metadata.source_name,
      source_type: chunk.metadata.source_type,
      title: chunk.metadata.title,
      url: chunk.metadata.url,
      extraction: chunk.metadata.extraction
        ? {
            status: chunk.metadata.extraction.extraction_status,
            method: chunk.metadata.extraction.extraction_method,
            confidence: chunk.metadata.extraction.extraction_confidence,
            coverage: chunk.metadata.extraction.content_coverage
          }
        : null,
      content: chunk.content
    })
  )}`;
}

function cacheDiagnostics(
  stageLabel: string,
  cached: { hits: NormalizedChunk[]; misses: NormalizedChunk[] },
  concurrency: number,
  keptCount: number,
  filteredCount: number
): Stage6BatchDiagnostics {
  return {
    stage_label: `${stageLabel}_cache`,
    batch_index: 0,
    batch_start: 0,
    chunk_count: cached.hits.length,
    kept_count: keptCount,
    filtered_count: filteredCount,
    duration_ms: 0,
    attempts: 1,
    fallback_used: false,
    total_tokens: 0,
    concurrency,
    cache_hit_count: cached.hits.length,
    cache_miss_count: cached.misses.length,
    cached_chunk_ids: cached.hits.map((chunk) => chunk.id)
  };
}

async function runScoringBatches(
  batches: ScoringBatch[],
  concurrency: number,
  signal: AbortSignal | undefined,
  work: (batch: ScoringBatch) => Promise<ScoringBatchResult>
): Promise<ScoringBatchResult[]> {
  const results: ScoringBatchResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      const batch = batches[index];
      if (!batch) continue;
      results[index] = await work(batch);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Operation aborted");
}

async function emit(
  onProgress: Stage6Options["onProgress"],
  event: import("@agent-search/shared").PipelineProgressEvent
): Promise<void> {
  if (onProgress) await onProgress(event);
}

function rescueBestAvailable(chunks: NormalizedChunk[], intent: IntentObject, limit: number, threshold: number): NormalizedChunk[] {
  const viable = chunks.filter((chunk) => isWeakButPlausible(chunk, threshold));
  const sorted = [...viable].sort((a, b) => combinedScore(b) - combinedScore(a));
  const selected: NormalizedChunk[] = [];
  const selectedIds = new Set<string>();
  const add = (chunk: NormalizedChunk | undefined) => {
    if (!chunk || selectedIds.has(chunk.id) || selected.length >= limit) return;
    selected.push(chunk);
    selectedIds.add(chunk.id);
  };

  for (const requiredType of intent.required_source_types) {
    add(sorted.find((chunk) => matchesRequiredSourceType(chunk, requiredType)));
  }

  for (const chunk of sorted) {
    add(chunk);
  }

  return selected;
}

function matchesRequiredSourceType(chunk: NormalizedChunk, requiredType: IntentObject["required_source_types"][number]): boolean {
  if (requiredType === "primary-document") {
    return (
      chunk.metadata.epistemic_stance === "primary_source" ||
      ["government", "filing", "structured_fact", "medical"].includes(chunk.metadata.source_type)
    );
  }
  if (requiredType === "news") return false;
  return chunk.metadata.source_type === requiredType;
}

function rescueMissingRequiredCoverage(
  scored: NormalizedChunk[],
  filteredOut: NormalizedChunk[],
  intent: IntentObject,
  threshold: number
): NormalizedChunk[] {
  const rescued: NormalizedChunk[] = [];
  const selectedIds = new Set(scored.map((chunk) => chunk.id));
  const alreadyCovered = (requiredType: IntentObject["required_source_types"][number]) =>
    [...scored, ...rescued].some((chunk) => matchesRequiredSourceType(chunk, requiredType));

  for (const requiredType of intent.required_source_types) {
    if (alreadyCovered(requiredType)) continue;
    const candidate = filteredOut
      .filter((chunk) => !selectedIds.has(chunk.id) && matchesRequiredSourceType(chunk, requiredType) && isWeakButPlausible(chunk, threshold))
      .sort((a, b) => combinedScore(b) - combinedScore(a))[0];
    if (candidate) {
      rescued.push(candidate);
      selectedIds.add(candidate.id);
    }
  }

  return rescued;
}

function isWeakButPlausible(chunk: NormalizedChunk, threshold: number): boolean {
  return chunk._internal.relevance_to_query >= 0.12 && combinedScore(chunk) >= Math.max(0.025, threshold * 0.2);
}

function combinedScore(chunk: NormalizedChunk): number {
  return (
    chunk._internal.relevance_to_query *
    chunk._internal.source_weight *
    chunk.metadata.confidence_score *
    Math.max(0.4, chunk._internal.freshness_fitness)
  );
}

function applyExtractionTreatment(chunk: NormalizedChunk): NormalizedChunk {
  const extraction = chunk.metadata.extraction;
  if (!extraction) return chunk;
  const ceiling = confidenceCeilingForExtraction(extraction);
  if (ceiling >= 1) return chunk;
  const metadataOnly = extraction.extraction_status === "metadata_only" || extraction.extraction_status === "failed";
  return NormalizedChunkSchema.parse({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      confidence_score: Math.min(chunk.metadata.confidence_score, ceiling),
      claim_graph: metadataOnly ? [] : chunk.metadata.claim_graph,
      epistemic_stance: metadataOnly ? "speculation" : chunk.metadata.epistemic_stance
    },
    _internal: {
      ...chunk._internal,
      relevance_to_query: metadataOnly ? Math.min(chunk._internal.relevance_to_query, 0.12) : chunk._internal.relevance_to_query
    }
  });
}

function confidenceCeilingForExtraction(extraction: ExtractionMetadata): number {
  switch (extraction.extraction_status) {
    case "full_text":
    case "section_text":
      return 1;
    case "structured_abstract":
      return 0.55;
    case "snippet":
      return 0.35;
    case "metadata_only":
      return 0.15;
    case "failed":
      return 0.08;
  }
}

function fallbackScore(chunk: NormalizedChunk, query: string) {
  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3 && !STOPWORDS.has(term))
  );
  const content = `${chunk.metadata.title ?? ""} ${chunk.metadata.summary ?? ""} ${chunk.content}`.toLowerCase();
  const hits = [...queryTerms].filter((term) => content.includes(term)).length;
  const denominator = Math.max(4, Math.min(12, queryTerms.size || 4));
  const phraseBoost = contextualPhraseBoost(query, content);
  const relevance = queryTerms.size ? Math.min(1, hits / denominator + phraseBoost) : phraseBoost;
  const mismatchPenalty = /about the author|author biography|editorial board|copyright|terms of use/.test(content.slice(0, 300))
    ? 0.08
    : 1;
  const firstSentence = chunk.content.split(/(?<=\.)\s+/)[0]?.slice(0, 240) || chunk.content.slice(0, 240);
  return {
    relevance_to_query: Math.max(0, Math.min(1, relevance * mismatchPenalty)),
    confidence_score: Math.min(0.92, Math.max(0.28, chunk._internal.source_weight)),
    freshness_fitness: Math.max(0.2, chunk._internal.freshness_fitness),
    surprise_score: chunk.metadata.source_type === "forum" || chunk.metadata.source_type === "tech_discussion" ? 0.35 : 0.55,
    claim_graph: firstSentence
      ? [
          {
            claim: firstSentence,
            claim_type: "asserted" as const,
            supporting_text_offset: [0, Math.min(chunk.content.length, firstSentence.length)] as [number, number]
          }
        ]
      : []
  };
}

function contextualPhraseBoost(query: string, content: string): number {
  const lower = query.toLowerCase();
  let boost = 0;
  if (/(oil|crude|wti|brent|petroleum)/.test(lower) && /(eia|short-term energy outlook|steo|supply|demand|inventory|forecast)/.test(content)) boost += 0.22;
  if (/(trader|institution|bank|news|market data|co-?location|direct feed)/.test(lower) && /(sec|direct feed|co-location|edgar|fomc|cpi|market data|exchange)/.test(content)) boost += 0.24;
  if (/(dedup|duplicate|submodular|bayesian|similarity|pipeline)/.test(lower) && /(submodular|embedding|similarity|truth discovery|bayesian|jensen|kl|claim)/.test(content)) boost += 0.22;
  if (/(appsec|security|vibecode|owasp|nist|cisa)/.test(lower) && /(owasp|nist|cisa|authorization|access control|verification|ssdf)/.test(content)) boost += 0.24;
  if (/(debt|deficit|inflation|fiscal|cbo|treasury)/.test(lower) && /(cbo|treasury|interest|deficit|debt|inflation)/.test(content)) boost += 0.2;
  return Math.min(0.35, boost);
}

function applyContextualRelevanceGuard(relevance: number, chunk: NormalizedChunk, query: string): number {
  const lower = query.toLowerCase();
  const title = (chunk.metadata.title ?? "").toLowerCase();
  const content = `${title} ${chunk.metadata.summary ?? ""} ${chunk.content}`.toLowerCase();
  let cap = 1;

  if (/about the author|author biography|editorial board|copyright|terms of use/.test(title)) {
    cap = Math.min(cap, 0.05);
  }

  if (/(oil|crude|wti|brent|opec|petroleum)/.test(lower)) {
    const oilSpecificTitle = /(oil|crude|wti|brent|opec|petroleum|eia|steo)/.test(title);
    const forecastSignal = /(forecast|outlook|steo|brent|wti|supply|demand|inventor|production|consumption|price)/.test(content);
    if (/home heating oil|kerosene|propane/.test(title) && !/forecast|outlook|steo|crude|brent|wti/.test(content)) {
      cap = Math.min(cap, 0.18);
    } else if (chunk.metadata.source_type === "encyclopedic" && !oilSpecificTitle && !forecastSignal) {
      cap = Math.min(cap, 0.16);
    } else if (chunk.metadata.source_type === "encyclopedic" && !oilSpecificTitle) {
      cap = Math.min(cap, 0.24);
    }
  }

  if (/(dedup|duplicates?|submodular|bayesian|source reliability|truth discovery|jensen|kl divergence|token budget|learned similarity|pipeline)/.test(lower)) {
    const retrievalSignal = /(dedup|duplicate|submodular|bayesian|truth discovery|source reliability|similarity|embedding|jensen|kl|retrieval|claim)/.test(content);
    if (!retrievalSignal) cap = Math.min(cap, 0.12);
  }

  if (/(institution|bank|trader|news|squawk|co-?location|direct feeds?|market data|edgar|macro releases?)/.test(lower)) {
    const tradingSignal = /(sec|edgar|direct feed|co-location|colocation|market data|squawk|fomc|cpi|filing|exchange|release|surprise|consensus|compliance)/.test(content);
    if (!tradingSignal) cap = Math.min(cap, 0.16);
  }

  return Math.min(relevance, cap);
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
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
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);
