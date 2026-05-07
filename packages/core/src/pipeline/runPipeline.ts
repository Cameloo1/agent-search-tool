import {
  DEFAULTS,
  PipelineRequestSchema,
  PipelineResponseSchema,
  type Embedder,
  type ExtractionTrace,
  type LLMProvider,
  type LLMStageKey,
  type PipelineRequest,
  type PipelineProgressEvent,
  type PipelineResponse,
  type RawItem,
  type SourceDescriptor,
  type RetrievalRound,
  type RequiredSourceType,
  type SourceFetchResult,
  type SourceName,
  type SubQuery
} from "@agent-search/shared";
import { createMockLLMProvider } from "@agent-search/llm";
import { createDefaultEmbedder } from "@agent-search/embeddings";
import type { SourceHandler } from "@agent-search/sources";
import { decomposeIntent, fallbackIntent } from "../stage1Intent.js";
import { buildQueryStrategy, fallbackSubQueries } from "../stage2Strategy.js";
import { routeSources, summarizeSourceResults } from "../stage3Router.js";
import { mergeExtractionTrace, resolveAndExtractEvidence } from "../stage4Extraction.js";
import { normalizeRawItems } from "../stage5Normalize.js";
import { preRankChunks } from "../stage5_5Prerank.js";
import { scoreChunks } from "../stage6Score.js";
import { deduplicateChunks } from "../stage7Dedup.js";
import { assembleFinalChunks } from "../stage8Assemble.js";
import { computeEvidenceHealth } from "../evidenceHealth.js";
import { analyzeEvidenceGaps } from "../gapAnalysis.js";
import { synthesizeSelectedAnswer } from "../answerSynthesis.js";
import { reviewSynthesizedAnswer } from "../synthesisReview.js";
import { createTraceBuilder, finalizeTrace, timeStage } from "../trace.js";
import { createCostTrackingProvider, summarizeModelCosts } from "../costTracking.js";
import {
  createBalancedStageModelConfig,
  createModelRouter,
  createStageModelConfig,
  type StageModelConfig,
  type StageModelDecision
} from "../modelRouting.js";
import {
  applyReliabilityScores,
  createReliabilityStore,
  observeSelectedChunks,
  type SourceReliabilityStore
} from "../reliabilityStore.js";

export interface PipelineOptions {
  llmProvider?: LLMProvider;
  stageModels?: Partial<StageModelConfig>;
  balancedStageModels?: Partial<StageModelConfig>;
  embedder?: Embedder;
  sourceHandlers?: Partial<Record<string, SourceHandler>>;
  sourceDescriptors?: SourceDescriptor[];
  preferredSourceIds?: SourceName[];
  mockRawItems?: RawItem[];
  pipelineTimeoutMs?: number;
  sourceTimeoutMs?: number;
  maxConcurrency?: number;
  dedupSimilarityThreshold?: number;
  scoringThreshold?: number;
  llmTimeoutMs?: number;
  apiKeys?: {
    core?: string;
    github?: string;
    semanticScholar?: string;
  };
  secUserAgent?: string;
  enableDebugInternals?: boolean;
  reliabilityStore?: SourceReliabilityStore;
  reliabilityDbPath?: string;
  maxRepairRounds?: number;
  repairTimeBudgetMs?: number;
  prerankMaxLlmChunks?: number;
  stage6ScoringConcurrency?: number;
  synthesisReviewTimeoutMs?: number;
  openRouterPricingCacheTtlMs?: number;
  enableExtraction?: boolean;
  extractionMaxDocuments?: number;
  extractionFetchTimeoutMs?: number;
  now?: Date | string;
  abortSignal?: AbortSignal;
  onProgress?: (event: PipelineProgressEvent) => void | Promise<void>;
}

export async function runPipeline(input: PipelineRequest, options: PipelineOptions = {}): Promise<PipelineResponse> {
  const request = PipelineRequestSchema.parse(input);
  const qualityMode = request.quality_mode ?? "fast";
  const balancedMode = qualityMode === "balanced";
  const tokenBudget = request.token_budget ?? DEFAULTS.tokenBudget;
  const trace = createTraceBuilder(tokenBudget);
  const baseLlmProvider = options.llmProvider ?? createRuleBasedMockProvider();
  const llmProvider = createCostTrackingProvider(baseLlmProvider, trace);
  const stageModels = createStageModelConfig(options.stageModels);
  const balancedStageModels = createBalancedStageModelConfig(options.balancedStageModels);
  const modelRouter = createModelRouter(llmProvider, request, stageModels, stageModels.adjudicator, balancedStageModels);
  const embedder = options.embedder ?? createDefaultEmbedder();
  const reliabilityStore = options.reliabilityStore ?? (await createReliabilityStore(options.reliabilityDbPath));
  const reliabilityDomain = inferReliabilityDomain(request.query);
  const shouldSynthesize = request.synthesize_answer ?? ["balanced", "quality"].includes(request.quality_mode ?? "fast");
  const maxRepairRounds = balancedMode
    ? Math.min(options.maxRepairRounds ?? DEFAULTS.maxRepairRounds, 2)
    : options.maxRepairRounds ?? DEFAULTS.maxRepairRounds;
  const repairTimeBudgetMs = balancedMode
    ? Math.min(options.repairTimeBudgetMs ?? DEFAULTS.repairTimeBudgetMs, 45_000)
    : options.repairTimeBudgetMs ?? DEFAULTS.repairTimeBudgetMs;
  const prerankMaxLlmChunks = balancedMode
    ? Math.min(options.prerankMaxLlmChunks ?? DEFAULTS.prerankMaxLlmChunks, 12)
    : options.prerankMaxLlmChunks ?? DEFAULTS.prerankMaxLlmChunks;
  const stage6ScoringConcurrency = options.stage6ScoringConcurrency ?? DEFAULTS.stage6ScoringConcurrency;
  const synthesisReviewTimeoutMs = balancedMode
    ? Math.min(options.synthesisReviewTimeoutMs ?? DEFAULTS.synthesisReviewTimeoutMs, 12_000)
    : options.synthesisReviewTimeoutMs ?? DEFAULTS.synthesisReviewTimeoutMs;

  await emit(options.onProgress, stageStart("stage1_intent", "Decomposing user intent."));
  const intentModel = modelRouter.providerFor("intent", { request });
  recordModelDecision(trace, intentModel);
  const intentTimeoutMs = stageTimeout(request, options.llmTimeoutMs, 15_000, 8_000);
  const intentResult = await timeStage(trace, "stage1_intent_ms", () =>
    withStageHeartbeat(options.onProgress, "stage1_intent", "Still decomposing intent; deterministic fallback is available if the structured LLM call fails.", () =>
      decomposeIntent(request, intentModel.provider, {
        timeoutMs: intentTimeoutMs,
        maxAttempts: structuredAttempts(request),
        now: options.now,
        signal: options.abortSignal,
        reasoningEnabled: reasoningEnabledForStage(request, "intent")
      })
    )
  );
  trace.errors.push(...intentResult.errors);
  trace.warnings.push(...intentResult.warnings);
  trace.structuredLlmCalls.push(...intentResult.structuredLlmCalls);
  if (intentResult.warnings.length > 0) {
    await emit(options.onProgress, stageProgress("stage1_intent", intentResult.warnings.join(" ")));
  }
  await emit(options.onProgress, stageComplete("stage1_intent", "Intent decomposition complete.", trace, "stage1_intent_ms"));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage2_strategy", "Planning allowlisted source queries."));
  const strategyModel = modelRouter.providerFor("strategy", { request, intent: intentResult.intent });
  recordModelDecision(trace, strategyModel);
  const strategyTimeoutMs = stageTimeout(request, options.llmTimeoutMs, 15_000, 8_000);
  const strategyResult = await timeStage(trace, "stage2_strategy_ms", () =>
    withStageHeartbeat(options.onProgress, "stage2_strategy", "Still planning source queries; deterministic source-aware fallback is armed.", () =>
      buildQueryStrategy(request, intentResult.intent, strategyModel.provider, {
        timeoutMs: strategyTimeoutMs,
        maxAttempts: structuredAttempts(request),
        now: options.now,
        signal: options.abortSignal,
        reasoningEnabled: reasoningEnabledForStage(request, "strategy"),
        sourceDescriptors: options.sourceDescriptors,
        preferredSourceIds: options.preferredSourceIds
      })
    )
  );
  trace.errors.push(...strategyResult.errors);
  trace.warnings.push(...strategyResult.warnings);
  trace.structuredLlmCalls.push(...strategyResult.structuredLlmCalls);
  if (strategyResult.warnings.length > 0) {
    await emit(options.onProgress, stageProgress("stage2_strategy", strategyResult.warnings.join(" ")));
  }
  const subQueriesExecuted = [...strategyResult.subQueries];
  await emit(options.onProgress, stageComplete("stage2_strategy", "Source strategy complete.", trace, "stage2_strategy_ms"));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage3_4_router_fetch", "Fetching source evidence."));
  const initialRoundStartedAt = new Date().toISOString();
  const routerResult = await timeStage(trace, "stage3_4_router_fetch_ms", async () => {
    if (options.mockRawItems) {
      return { rawItems: options.mockRawItems, fetchResults: [] };
    }
    return routeSources(strategyResult.subQueries, {
      handlers: options.sourceHandlers,
      sourceTimeoutMs: options.sourceTimeoutMs ?? DEFAULTS.sourceTimeoutMs,
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      apiKeys: options.apiKeys,
      secUserAgent: options.secUserAgent,
      abortSignal: options.abortSignal,
      onProgress: options.onProgress
    });
  });
  trace.sourceResults = summarizeSourceResults(routerResult.fetchResults);
  let allFetchResults = [...routerResult.fetchResults];
  let allRawItems = [...routerResult.rawItems];
  trace.counts.raw_items = allRawItems.length;
  await emit(options.onProgress, stageComplete("stage3_4_router_fetch", "Source fetching complete.", trace, "stage3_4_router_fetch_ms"));
  await emit(options.onProgress, countsEvent("stage3_4_router_fetch", trace));

  let initialExtraction: ExtractionTrace | undefined;
  if (shouldUseExtraction(request, options)) {
    throwIfAborted(options.abortSignal);
    await emit(options.onProgress, stageStart("stage4_extraction", "Resolving canonical documents and deepening thin evidence."));
    const extractionResult = await timeStage(trace, "stage4_extraction_ms", () =>
      resolveAndExtractEvidence(allRawItems, {
        enabled: true,
        maxDocuments: options.extractionMaxDocuments ?? 12,
        fetchTimeoutMs: options.extractionFetchTimeoutMs ?? 4_000
      })
    );
    allRawItems = extractionResult.rawItems;
    initialExtraction = extractionResult.diagnostics;
    trace.extraction = mergeExtractionTrace(trace.extraction, extractionResult.diagnostics);
    trace.counts.raw_items = allRawItems.length;
    await emit(
      options.onProgress,
      stageProgress("stage4_extraction", "Canonical extraction complete.", {
        document_count: extractionResult.diagnostics.document_count,
        deepened_document_count: extractionResult.diagnostics.deepened_document_count,
        degraded_document_count: extractionResult.diagnostics.degraded_document_count,
        metadata_only_count: extractionResult.diagnostics.metadata_only_count,
        attempt_count: extractionResult.diagnostics.attempt_count
      })
    );
    await emit(options.onProgress, stageComplete("stage4_extraction", "Evidence extraction complete.", trace, "stage4_extraction_ms"));
    await emit(options.onProgress, countsEvent("stage4_extraction", trace));
  }

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage5_normalize", "Normalizing source content into chunks."));
  let normalizedChunks = await timeStage(trace, "stage5_normalize_ms", async () => normalizeRawItems(allRawItems));
  trace.counts.normalized_chunks = normalizedChunks.length;
  await emit(options.onProgress, stageComplete("stage5_normalize", "Content normalization complete.", trace, "stage5_normalize_ms"));
  await emit(options.onProgress, countsEvent("stage5_normalize", trace));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage5_5_prerank", "Pre-ranking normalized chunks before LLM scoring."));
  const initialUnavailableSources = unavailableSourcesFromSummary(trace.sourceResults);
  const initialPreRank = await timeStage(trace, "stage5_5_prerank_ms", async () =>
    preRankChunks(normalizedChunks, request.query, intentResult.intent, {
      maxLlmChunks: prerankMaxLlmChunks,
      roundIndex: 0,
      broadeningLevel: 0,
      unavailableSourcesSkipped: initialUnavailableSources
    })
  );
  trace.preRank.push(initialPreRank.diagnostics);
  await emit(
    options.onProgress,
    stageProgress("stage5_5_prerank", `Pre-ranked ${initialPreRank.diagnostics.selected_for_llm_count}/${normalizedChunks.length} chunks for LLM scoring.`, {
      selected_for_llm_count: initialPreRank.diagnostics.selected_for_llm_count,
      rejected_count: initialPreRank.diagnostics.rejected_count,
      duplicate_group_count: initialPreRank.diagnostics.duplicate_group_count
    })
  );
  await emit(options.onProgress, stageComplete("stage5_5_prerank", "Pre-ranking complete.", trace, "stage5_5_prerank_ms"));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage6_score", "Scoring chunk relevance and quality."));
  const scoringModel = modelRouter.providerFor("scoring", {
    request,
    intent: intentResult.intent
  });
  recordModelDecision(trace, scoringModel);
  const scoringTimeoutMs = stageTimeout(request, options.llmTimeoutMs, 12_000, 12_000);
  const scoredResult = await timeStage(trace, "stage6_score_ms", () =>
    withStageHeartbeat(options.onProgress, "stage6_score", "Still scoring chunks; deterministic fallback and filtering remain available.", () =>
      scoreChunks(initialPreRank.chunks, request, intentResult.intent, scoringModel.provider, {
        timeoutMs: scoringTimeoutMs,
        maxAttempts: structuredAttempts(request),
        scoringThreshold: options.scoringThreshold ?? DEFAULTS.scoringThreshold,
        scoringConcurrency: stage6ScoringConcurrency,
        stageLabel: "stage6_score",
        now: options.now,
        signal: options.abortSignal,
        reasoningEnabled: reasoningEnabledForStage(request, "scoring"),
        onProgress: options.onProgress
      })
    )
  );
  trace.errors.push(...scoredResult.errors);
  trace.warnings.push(...scoredResult.warnings);
  trace.scoringBatches.push(...scoredResult.diagnostics);
  trace.structuredLlmCalls.push(...scoredResult.structuredLlmCalls);
  if (scoredResult.warnings.length > 0) {
    await emit(options.onProgress, stageProgress("stage6_score", scoredResult.warnings.join(" ")));
  }
  let filteredChunks = [...initialPreRank.rejectedChunks, ...scoredResult.filteredOut];
  await emit(options.onProgress, stageComplete("stage6_score", "Chunk scoring complete.", trace, "stage6_score_ms"));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage6b_reliability", "Applying source reliability weights."));
  let reliabilityAdjustedChunks = await timeStage(trace, "stage6b_reliability_ms", () =>
    applyReliabilityScores(scoredResult.chunks, reliabilityStore, reliabilityDomain)
  );
  trace.counts.scored_chunks = reliabilityAdjustedChunks.length;
  trace.counts.filtered_chunks = scoredResult.filteredOut.length;
  await emit(options.onProgress, stageComplete("stage6b_reliability", "Reliability weighting complete.", trace, "stage6b_reliability_ms"));
  await emit(options.onProgress, countsEvent("stage6b_reliability", trace));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage7_dedup", "Clustering duplicate and near-duplicate chunks."));
  let dedupResult = await timeStage(trace, "stage7_dedup_ms", () =>
    deduplicateChunks(reliabilityAdjustedChunks, embedder, {
      threshold: options.dedupSimilarityThreshold ?? DEFAULTS.dedupSimilarityThreshold,
      debugInternals: request.debug || options.enableDebugInternals
    })
  );
  trace.warnings.push(...dedupResult.warnings);
  trace.deduplication = {
    clusters: dedupResult.clusters.map((cluster) => ({
      id: cluster.id,
      representative_id: cluster.representative_id,
      member_ids: cluster.member_ids,
      rejected_ids: cluster.rejected_ids,
      duplicate_level: cluster.duplicate_level,
      novelty_score: cluster.novelty_score,
      js_divergence: cluster.js_divergence
    }))
  };
  trace.counts.deduped_chunks = dedupResult.chunks.length;
  await emit(options.onProgress, stageComplete("stage7_dedup", "Deduplication complete.", trace, "stage7_dedup_ms"));
  await emit(options.onProgress, countsEvent("stage7_dedup", trace));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("stage8_assemble", "Selecting final chunks under token budget."));
  let assemblyResult = await timeStage(trace, "stage8_assemble_ms", async () =>
    assembleFinalChunks(dedupResult.chunks, intentResult.intent, tokenBudget)
  );
  trace.selection = assemblyResult.selection;
  trace.counts.selected_chunks = assemblyResult.chunks.length;
  await emit(options.onProgress, stageComplete("stage8_assemble", "Final assembly complete.", trace, "stage8_assemble_ms"));
  await emit(options.onProgress, countsEvent("stage8_assemble", trace));

  throwIfAborted(options.abortSignal);
  await emit(options.onProgress, stageStart("evidence_health", "Computing evidence health diagnostics."));
  trace.evidenceHealth = await timeStage(trace, "evidence_health_ms", async () =>
    computeEvidenceHealth({
      chunks: assemblyResult.chunks,
      intent: intentResult.intent,
      sourceResults: trace.sourceResults,
      deduplication: trace.deduplication
    })
  );
  await emit(options.onProgress, stageComplete("evidence_health", "Evidence health computed.", trace, "evidence_health_ms"));
  trace.gapAnalysis = analyzeEvidenceGaps({
    query: request.query,
    intent: intentResult.intent,
    selectedChunks: assemblyResult.chunks,
    filteredChunks,
    sourceResults: trace.sourceResults,
    evidenceHealth: trace.evidenceHealth,
    roundIndex: 0,
    maxRepairRounds
  });
  recordGapStopWarning(trace);
  applyBalancedRepairStop(trace, request);
  trace.retrievalRounds.push(
    makeRetrievalRound({
      roundIndex: 0,
      reason: "initial_retrieval",
      startedAt: initialRoundStartedAt,
      subQueries: strategyResult.subQueries,
      fetchResults: routerResult.fetchResults,
      rawItemCount: routerResult.rawItems.length,
      normalizedChunkCount: normalizedChunks.length,
      preRank: initialPreRank.diagnostics,
      scoringBatches: scoredResult.diagnostics,
      extraction: initialExtraction,
      scoredChunkCount: reliabilityAdjustedChunks.length,
      filteredChunkCount: filteredChunks.length,
      dedupedChunkCount: dedupResult.chunks.length,
      selectedChunkCount: assemblyResult.chunks.length,
      evidenceHealth: trace.evidenceHealth,
      gapAnalysis: trace.gapAnalysis,
      warnings: [...strategyResult.warnings, ...scoredResult.warnings],
      errors: [...strategyResult.errors, ...scoredResult.errors]
    })
  );
  await emit(options.onProgress, gapEvent(trace.gapAnalysis!));

  const repairLoopStartedAt = Date.now();
  const deepenedExistingRawIds = new Set<string>();
  for (let roundIndex = 1; trace.gapAnalysis.should_retry && roundIndex <= maxRepairRounds; roundIndex += 1) {
    throwIfAborted(options.abortSignal);
    if (Date.now() - repairLoopStartedAt >= repairTimeBudgetMs) {
      markGapAsCautious(trace, `Repair loop stopped after reaching the ${repairTimeBudgetMs}ms repair time budget.`);
      break;
    }
    const unavailableSources = unavailableSourcesFromSummary(trace.sourceResults);
    const deepenExistingCandidates = balancedMode ? selectDegradedHighAuthorityRawItems(assemblyResult.chunks, allRawItems, deepenedExistingRawIds) : [];
    const useDeepenExistingSource = deepenExistingCandidates.length > 0;
    const repairSourceTypeGaps = trace.gapAnalysis.hard_source_type_gaps.length
      ? trace.gapAnalysis.hard_source_type_gaps
      : intentResult.intent.required_source_types;
    const repairSubQueries = useDeepenExistingSource
      ? []
      : filterUnavailableSources(
          broadenRepairSubQueries(trace.gapAnalysis.recommended_sub_queries, request.query, repairSourceTypeGaps, roundIndex),
          unavailableSources
        );
    if (!useDeepenExistingSource && repairSubQueries.length === 0) {
      markGapAsCautious(trace, "Repair loop stopped because no retryable allowed sources remained for the current gaps.");
      break;
    }
    const repairReason = useDeepenExistingSource ? "deepen_existing_source" : trace.gapAnalysis.reasons.slice(0, 3).join(" ");
    const broadeningLevel = Math.max(0, roundIndex - 1);
    await emit(options.onProgress, {
      type: "retrieval_round",
      at: new Date().toISOString(),
      round_index: roundIndex,
      message: useDeepenExistingSource
        ? `Repair round ${roundIndex}: deepening ${deepenExistingCandidates.length} degraded high-authority source(s).`
        : `Repair round ${roundIndex}: ${repairReason || "targeted evidence repair"}`,
      evidence_status: trace.evidenceHealth?.status,
      counts: { ...trace.counts }
    });
    if (!useDeepenExistingSource && (broadeningLevel > 0 || unavailableSources.length > 0)) {
      await emit(
        options.onProgress,
        stageProgress(`repair_${roundIndex}_strategy`, `Repair round ${roundIndex} broadened source targeting.`, {
          broadening_level: broadeningLevel,
          unavailable_sources_skipped: unavailableSources,
          sub_query_count: repairSubQueries.length
        })
      );
    }

    const roundStartedAt = new Date().toISOString();
    const repairFetch = await timeStage(trace, `repair_${roundIndex}_stage3_4_router_fetch_ms`, async () => {
      if (useDeepenExistingSource) {
        for (const item of deepenExistingCandidates) deepenedExistingRawIds.add(item.id);
        return { rawItems: deepenExistingCandidates, fetchResults: [] };
      }
      if (options.mockRawItems) {
        return { rawItems: [], fetchResults: [] };
      }
      return routeSources(repairSubQueries, {
        handlers: options.sourceHandlers,
        sourceTimeoutMs: options.sourceTimeoutMs ?? DEFAULTS.sourceTimeoutMs,
        maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
        apiKeys: options.apiKeys,
        secUserAgent: options.secUserAgent,
        abortSignal: options.abortSignal,
        onProgress: options.onProgress
      });
    });
    allFetchResults = [...allFetchResults, ...repairFetch.fetchResults];
    subQueriesExecuted.push(...repairSubQueries);
    trace.sourceResults = summarizeSourceResults(allFetchResults);

    let repairRawItems = repairFetch.rawItems;
    let repairExtraction: ExtractionTrace | undefined;
    if (shouldUseExtraction(request, options) && repairFetch.rawItems.length > 0) {
      await emit(options.onProgress, stageStart(`repair_${roundIndex}_stage4_extraction`, `Repair round ${roundIndex}: deepening newly found evidence.`));
      const repairExtractionResult = await timeStage(trace, `repair_${roundIndex}_stage4_extraction_ms`, () =>
        resolveAndExtractEvidence(repairFetch.rawItems, {
          enabled: true,
          maxDocuments: options.extractionMaxDocuments ?? 12,
          fetchTimeoutMs: options.extractionFetchTimeoutMs ?? 4_000
        })
      );
      repairRawItems = repairExtractionResult.rawItems;
      repairExtraction = repairExtractionResult.diagnostics;
      trace.extraction = mergeExtractionTrace(trace.extraction, repairExtractionResult.diagnostics);
      await emit(
        options.onProgress,
        stageProgress(`repair_${roundIndex}_stage4_extraction`, `Repair round ${roundIndex}: canonical extraction complete.`, {
          document_count: repairExtractionResult.diagnostics.document_count,
          deepened_document_count: repairExtractionResult.diagnostics.deepened_document_count,
          degraded_document_count: repairExtractionResult.diagnostics.degraded_document_count,
          metadata_only_count: repairExtractionResult.diagnostics.metadata_only_count,
          attempt_count: repairExtractionResult.diagnostics.attempt_count
        })
      );
      await emit(options.onProgress, stageComplete(`repair_${roundIndex}_stage4_extraction`, `Repair round ${roundIndex}: extraction complete.`, trace, `repair_${roundIndex}_stage4_extraction_ms`));
    }

    allRawItems = [...allRawItems, ...repairRawItems];
    trace.counts.raw_items = allRawItems.length;

    const repairNormalized = await timeStage(trace, `repair_${roundIndex}_stage5_normalize_ms`, async () =>
      normalizeRawItems(repairRawItems)
    );
    normalizedChunks = [...normalizedChunks, ...repairNormalized];
    trace.counts.normalized_chunks = normalizedChunks.length;

    const repairPreRank = await timeStage(trace, `repair_${roundIndex}_stage5_5_prerank_ms`, async () =>
      preRankChunks(repairNormalized, request.query, intentResult.intent, {
        maxLlmChunks: prerankMaxLlmChunks,
        roundIndex,
        broadeningLevel,
        unavailableSourcesSkipped: unavailableSources
      })
    );
    trace.preRank.push(repairPreRank.diagnostics);
    await emit(
      options.onProgress,
      stageProgress(`repair_${roundIndex}_stage5_5_prerank`, `Repair round ${roundIndex} pre-ranked ${repairPreRank.diagnostics.selected_for_llm_count}/${repairNormalized.length} chunks.`, {
        selected_for_llm_count: repairPreRank.diagnostics.selected_for_llm_count,
        rejected_count: repairPreRank.diagnostics.rejected_count,
        duplicate_group_count: repairPreRank.diagnostics.duplicate_group_count
      })
    );

    const repairScored = await timeStage(trace, `repair_${roundIndex}_stage6_score_ms`, () =>
      withStageHeartbeat(options.onProgress, `repair_${roundIndex}_stage6_score`, `Repair round ${roundIndex} is still scoring retrieved chunks.`, () =>
        scoreChunks(repairPreRank.chunks, request, intentResult.intent, scoringModel.provider, {
          timeoutMs: scoringTimeoutMs,
          maxAttempts: structuredAttempts(request),
          scoringThreshold: options.scoringThreshold ?? DEFAULTS.scoringThreshold,
          scoringConcurrency: stage6ScoringConcurrency,
          stageLabel: `repair_${roundIndex}_stage6_score`,
          now: options.now,
          signal: options.abortSignal,
          reasoningEnabled: reasoningEnabledForStage(request, "scoring"),
          onProgress: options.onProgress
        })
      )
    );
    trace.errors.push(...repairScored.errors);
    trace.warnings.push(...repairScored.warnings);
    trace.scoringBatches.push(...repairScored.diagnostics);
    trace.structuredLlmCalls.push(...repairScored.structuredLlmCalls);
    if (repairScored.warnings.length > 0) {
      await emit(options.onProgress, stageProgress(`repair_${roundIndex}_stage6_score`, repairScored.warnings.join(" ")));
    }
    filteredChunks = [...filteredChunks, ...repairPreRank.rejectedChunks, ...repairScored.filteredOut];

    const repairReliabilityChunks = await timeStage(trace, `repair_${roundIndex}_stage6b_reliability_ms`, () =>
      applyReliabilityScores(repairScored.chunks, reliabilityStore, reliabilityDomain)
    );
    reliabilityAdjustedChunks = [...reliabilityAdjustedChunks, ...repairReliabilityChunks];
    trace.counts.scored_chunks = reliabilityAdjustedChunks.length;
    trace.counts.filtered_chunks = filteredChunks.length;

    dedupResult = await timeStage(trace, `repair_${roundIndex}_stage7_dedup_ms`, () =>
      deduplicateChunks(reliabilityAdjustedChunks, embedder, {
        threshold: options.dedupSimilarityThreshold ?? DEFAULTS.dedupSimilarityThreshold,
        debugInternals: request.debug || options.enableDebugInternals
      })
    );
    trace.warnings.push(...dedupResult.warnings);
    trace.deduplication = {
      clusters: dedupResult.clusters.map((cluster) => ({
        id: cluster.id,
        representative_id: cluster.representative_id,
        member_ids: cluster.member_ids,
        rejected_ids: cluster.rejected_ids,
        duplicate_level: cluster.duplicate_level,
        novelty_score: cluster.novelty_score,
        js_divergence: cluster.js_divergence
      }))
    };
    trace.counts.deduped_chunks = dedupResult.chunks.length;

    assemblyResult = await timeStage(trace, `repair_${roundIndex}_stage8_assemble_ms`, async () =>
      assembleFinalChunks(dedupResult.chunks, intentResult.intent, tokenBudget)
    );
    trace.selection = assemblyResult.selection;
    trace.counts.selected_chunks = assemblyResult.chunks.length;

    trace.evidenceHealth = await timeStage(trace, `repair_${roundIndex}_evidence_health_ms`, async () =>
      computeEvidenceHealth({
        chunks: assemblyResult.chunks,
        intent: intentResult.intent,
        sourceResults: trace.sourceResults,
        deduplication: trace.deduplication
      })
    );
    trace.gapAnalysis = analyzeEvidenceGaps({
      query: request.query,
      intent: intentResult.intent,
      selectedChunks: assemblyResult.chunks,
      filteredChunks,
      sourceResults: trace.sourceResults,
      evidenceHealth: trace.evidenceHealth,
      roundIndex,
      maxRepairRounds
    });
    recordGapStopWarning(trace);
    applyBalancedRepairStop(trace, request);
    trace.retrievalRounds.push(
      makeRetrievalRound({
        roundIndex,
        reason: repairReason || "targeted_evidence_repair",
        startedAt: roundStartedAt,
        subQueries: repairSubQueries,
        fetchResults: repairFetch.fetchResults,
        rawItemCount: repairFetch.rawItems.length,
        normalizedChunkCount: repairNormalized.length,
        preRank: repairPreRank.diagnostics,
        scoringBatches: repairScored.diagnostics,
        extraction: repairExtraction,
        scoredChunkCount: repairReliabilityChunks.length,
        filteredChunkCount: repairScored.filteredOut.length,
        dedupedChunkCount: dedupResult.chunks.length,
        selectedChunkCount: assemblyResult.chunks.length,
        evidenceHealth: trace.evidenceHealth,
        gapAnalysis: trace.gapAnalysis,
        warnings: repairScored.warnings,
        errors: repairScored.errors
      })
    );
    await emit(options.onProgress, gapEvent(trace.gapAnalysis!));
    await emit(options.onProgress, countsEvent(`repair_${roundIndex}`, trace));
  }
  if (trace.gapAnalysis?.should_retry) {
    markGapAsCautious(trace, `Repair loop stopped after reaching the ${maxRepairRounds} round cap.`);
  }

  throwIfAborted(options.abortSignal);
  await timeStage(trace, "stage8b_reliability_observe_ms", () =>
    observeSelectedChunks(assemblyResult.chunks, reliabilityStore, reliabilityDomain, "observed")
  );

  let synthesizedAnswer: string | undefined;
  if (shouldSynthesize) {
    await emit(options.onProgress, stageStart("synthesis", "Synthesizing final answer from selected chunks."));
    const synthesisModel = modelRouter.providerFor("synthesis", { request, intent: intentResult.intent });
    recordModelDecision(trace, synthesisModel);
    const synthesisTimeoutMs = stageTimeout(request, options.llmTimeoutMs, options.llmTimeoutMs ?? 30_000, 15_000);
    const synthesis = await timeStage(trace, "synthesis_ms", () =>
      withStageHeartbeat(options.onProgress, "synthesis", "Still synthesizing from selected chunks; deterministic synthesis fallback is available.", () =>
        synthesizeSelectedAnswer(
          { query: request.query, chunks: assemblyResult.chunks },
          synthesisModel.provider,
          {
            timeoutMs: synthesisTimeoutMs,
            maxAttempts: structuredAttempts(request),
            signal: options.abortSignal,
            reasoningEnabled: reasoningEnabledForStage(request, "synthesis")
          }
        )
      )
    );
    synthesizedAnswer = synthesis.synthesized_answer;
    trace.warnings.push(...synthesis.warnings);
    trace.structuredLlmCalls.push(...synthesis.structuredLlmCalls);
    await emit(options.onProgress, stageComplete("synthesis", "Answer synthesis complete.", trace, "synthesis_ms"));

    if (shouldRunCautiousReview(trace)) {
      await emit(options.onProgress, stageStart("synthesis_review", "Reviewing weak-evidence answer for gaps and citation support."));
      const reviewerModel = modelRouter.providerFor("adjudicator", { request, intent: intentResult.intent });
      recordModelDecision(trace, reviewerModel);
      const review = await timeStage(trace, "synthesis_review_ms", () =>
        withStageHeartbeat(options.onProgress, "synthesis_review", "Still reviewing weak evidence and citation support; deterministic review fallback is available.", () =>
          reviewSynthesizedAnswer(
            {
              query: request.query,
              draftAnswer: synthesizedAnswer ?? "",
              chunks: assemblyResult.chunks,
              evidenceHealth: trace.evidenceHealth,
              gapAnalysis: trace.gapAnalysis
            },
            reviewerModel.provider,
            {
              timeoutMs: synthesisReviewTimeoutMs,
              maxAttempts: structuredAttempts(request),
              signal: options.abortSignal,
              reasoningEnabled: reasoningEnabledForStage(request, "adjudicator")
            }
          )
        )
      );
      trace.synthesisReview = review.review;
      synthesizedAnswer = review.review.final_answer;
      trace.warnings.push(...review.warnings);
      trace.structuredLlmCalls.push(...review.structuredLlmCalls);
      await emit(options.onProgress, stageComplete("synthesis_review", "Cautious synthesis review complete.", trace, "synthesis_review_ms"));
    }
  }

  trace.costSummary = await summarizeModelCosts(trace.modelCostLineItems, {
    openRouterPricingCacheTtlMs: options.openRouterPricingCacheTtlMs
  });
  const finalizedTrace = finalizeTrace(trace);

  return PipelineResponseSchema.parse({
    query: request.query,
    intent: intentResult.intent,
    sub_queries_executed: subQueriesExecuted,
    chunks: assemblyResult.chunks,
    synthesized_answer: synthesizedAnswer,
    synthesis_review: trace.synthesisReview,
    evidence_health: trace.evidenceHealth,
    trace: finalizedTrace
  });
}

function inferReliabilityDomain(query: string): string {
  const lower = query.toLowerCase();
  if (/(security|appsec|owasp|vulnerability|auth|webhook)/.test(lower)) return "appsec";
  if (/(market|trader|inflation|debt|fiscal|fed|sec|filing|macro)/.test(lower)) return "markets_macro";
  if (/(medical|clinical|pubmed|health)/.test(lower)) return "medical";
  if (/(dedup|embedding|submodular|bayesian|pipeline|similarity)/.test(lower)) return "technical_retrieval";
  return "general";
}

function recordModelDecision(trace: ReturnType<typeof createTraceBuilder>, decision: StageModelDecision): void {
  trace.modelUsage[decision.stage] = {
    provider: decision.providerName,
    model: decision.model,
    stage: decision.stage,
    quality_mode: decision.qualityMode,
    escalated: decision.escalated,
    reason: decision.reason
  };
  if (decision.escalated && decision.fromModel) {
    trace.escalations.push({
      stage: decision.stage,
      from_model: decision.fromModel,
      to_model: decision.model,
      reason: decision.reason ?? "model_escalation"
    });
  }
}

async function emit(
  onProgress: PipelineOptions["onProgress"],
  event: PipelineProgressEvent
): Promise<void> {
  if (onProgress) await onProgress(event);
}

function stageStart(stage: string, message: string): PipelineProgressEvent {
  return { type: "stage_start", stage, message, at: new Date().toISOString() };
}

function stageComplete(
  stage: string,
  message: string,
  trace: ReturnType<typeof createTraceBuilder>,
  timingKey: string
): PipelineProgressEvent {
  return {
    type: "stage_complete",
    stage,
    message,
    at: new Date().toISOString(),
    timing_ms: trace.stageTimingsMs[timingKey],
    counts: { ...trace.counts }
  };
}

function stageProgress(stage: string, message: string, details?: Record<string, unknown>): PipelineProgressEvent {
  return { type: "stage_progress", stage, message, details, at: new Date().toISOString() };
}

function countsEvent(stage: string, trace: ReturnType<typeof createTraceBuilder>): PipelineProgressEvent {
  return { type: "counts", stage, counts: { ...trace.counts }, at: new Date().toISOString() };
}

async function withStageHeartbeat<T>(
  onProgress: PipelineOptions["onProgress"],
  stage: string,
  message: string,
  work: () => Promise<T>,
  intervalMs = 5_000
): Promise<T> {
  let tick = 0;
  const timer =
    onProgress && intervalMs > 0
      ? setInterval(() => {
          tick += 1;
          void emit(onProgress, {
            type: "stage_progress",
            stage,
            message: `${message} (${tick * Math.round(intervalMs / 1000)}s elapsed)`,
            at: new Date().toISOString(),
            details: { elapsed_ms: tick * intervalMs, fallback_available: true }
          }).catch(() => undefined);
        }, intervalMs)
      : undefined;
  try {
    return await work();
  } finally {
    if (timer) clearInterval(timer);
  }
}

function gapEvent(gapAnalysis: NonNullable<ReturnType<typeof createTraceBuilder>["gapAnalysis"]>): PipelineProgressEvent {
  return {
    type: "gap_analysis",
    at: new Date().toISOString(),
    status: gapAnalysis.status,
    should_retry: gapAnalysis.should_retry,
    message: gapAnalysis.should_retry
      ? `Evidence repair requested: ${gapAnalysis.reasons.slice(0, 2).join(" ")}`
      : `Evidence gap analysis complete: ${gapAnalysis.status}`,
    reasons: gapAnalysis.reasons
  };
}

function makeRetrievalRound(input: {
  roundIndex: number;
  reason: string;
  startedAt: string;
  subQueries: RetrievalRound["sub_queries"];
  fetchResults: SourceFetchResult[];
  rawItemCount: number;
  normalizedChunkCount: number;
  preRank: RetrievalRound["pre_rank"];
  scoringBatches?: RetrievalRound["scoring_batches"];
  extraction?: RetrievalRound["extraction"];
  scoredChunkCount: number;
  filteredChunkCount: number;
  dedupedChunkCount: number;
  selectedChunkCount: number;
  evidenceHealth: RetrievalRound["evidence_health"];
  gapAnalysis: RetrievalRound["gap_analysis"];
  warnings: string[];
  errors: RetrievalRound["errors"];
}): RetrievalRound {
  return {
    round_index: input.roundIndex,
    reason: input.reason,
    started_at: input.startedAt,
    finished_at: new Date().toISOString(),
    sub_queries: input.subQueries,
    raw_item_count: input.rawItemCount,
    normalized_chunk_count: input.normalizedChunkCount,
    pre_rank: input.preRank,
    scoring_batches: input.scoringBatches ?? [],
    extraction: input.extraction,
    scored_chunk_count: input.scoredChunkCount,
    filtered_chunk_count: input.filteredChunkCount,
    deduped_chunk_count: input.dedupedChunkCount,
    selected_chunk_count: input.selectedChunkCount,
    evidence_health: input.evidenceHealth,
    gap_analysis: input.gapAnalysis,
    source_results: summarizeSourceResults(input.fetchResults),
    warnings: input.warnings,
    errors: input.errors
  };
}

function shouldRunCautiousReview(trace: ReturnType<typeof createTraceBuilder>): boolean {
  return (
    trace.gapAnalysis?.should_synthesize_cautiously === true ||
    trace.gapAnalysis?.status === "synthesize_cautiously" ||
    trace.evidenceHealth?.status === "weak" ||
    trace.evidenceHealth?.status === "insufficient"
  );
}

export function selectDegradedHighAuthorityRawItems(chunks: RawItemAwareChunk[], rawItems: RawItem[], alreadyDeepened: Set<string>): RawItem[] {
  const degradedCanonicalUrls = new Set(
    chunks
      .filter((chunk) => isHighAuthorityChunk(chunk) && isDegradedExtractionStatus(chunk.metadata.extraction?.extraction_status))
      .map((chunk) => chunk.metadata.extraction?.canonical_url ?? chunk.metadata.url)
  );
  if (degradedCanonicalUrls.size === 0) return [];
  const selected: RawItem[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const metadata = item.metadata as Record<string, unknown>;
    const extraction = metadata.extraction as { canonical_url?: unknown } | undefined;
    const canonicalUrl = typeof extraction?.canonical_url === "string" ? extraction.canonical_url : item.url;
    if (!degradedCanonicalUrls.has(canonicalUrl) || alreadyDeepened.has(item.id) || seen.has(canonicalUrl)) continue;
    selected.push(item);
    seen.add(canonicalUrl);
  }
  return selected.slice(0, 4);
}

type RawItemAwareChunk = PipelineResponse["chunks"][number];

function isHighAuthorityChunk(chunk: RawItemAwareChunk): boolean {
  return (
    chunk._internal.source_weight >= 0.65 ||
    ["government", "filing", "medical", "academic", "structured_fact"].includes(chunk.metadata.source_type) ||
    ["official_docs", "data_gov", "sec_edgar", "pubmed", "arxiv", "openalex", "semantic_scholar", "crossref"].includes(chunk.metadata.source_name)
  );
}

function isDegradedExtractionStatus(status: string | undefined): boolean {
  return status === "structured_abstract" || status === "snippet" || status === "metadata_only" || status === "failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Operation aborted");
}

function structuredAttempts(request: PipelineRequest): number {
  return ["fast", "balanced"].includes(request.quality_mode ?? "fast") ? 1 : 2;
}

function shouldUseExtraction(request: PipelineRequest, options: PipelineOptions): boolean {
  if (options.enableExtraction !== undefined) return options.enableExtraction;
  return ["balanced", "quality"].includes(request.quality_mode ?? "fast");
}

function stageTimeout(
  request: PipelineRequest,
  configured: number | undefined,
  fastCapMs: number,
  balancedCapMs: number
): number | undefined {
  const mode = request.quality_mode ?? "fast";
  if (mode === "quality") return configured;
  const cap = mode === "balanced" ? balancedCapMs : fastCapMs;
  return Math.min(configured ?? cap, cap);
}

function reasoningEnabledForStage(request: PipelineRequest, stage: LLMStageKey): boolean {
  const mode = request.quality_mode ?? "fast";
  if (mode === "quality") return true;
  if (mode === "balanced") return stage === "synthesis";
  return false;
}

function applyBalancedRepairStop(trace: ReturnType<typeof createTraceBuilder>, request: PipelineRequest): void {
  if ((request.quality_mode ?? "fast") !== "balanced") return;
  const gap = trace.gapAnalysis;
  const health = trace.evidenceHealth;
  if (!gap?.should_retry || !health || !["adequate", "strong"].includes(health.status)) return;
  if (gap.hard_source_type_gaps.length > 0 || gap.bad_context_reasons.length > 0 || gap.important_failed_sources.length > 0) return;

  const message = "Balanced mode stopped repair after adequate evidence; remaining gaps are soft or heuristic.";
  if (!trace.warnings.includes(message)) trace.warnings.push(message);
  const cautious = gap.missing_facets.length > 0 || gap.soft_source_type_gaps.length > 0;
  trace.gapAnalysis = {
    ...gap,
    status: cautious ? "synthesize_cautiously" : "no_retry",
    should_retry: false,
    should_synthesize_cautiously: cautious,
    stop_reason: "balanced_adequate_soft_gaps",
    reasons: gap.reasons.includes(message) ? gap.reasons : [...gap.reasons, message]
  };
}

function markGapAsCautious(trace: ReturnType<typeof createTraceBuilder>, reason: string): void {
  trace.warnings.push(reason);
  if (!trace.gapAnalysis) return;
  trace.gapAnalysis = {
    ...trace.gapAnalysis,
    status: "synthesize_cautiously",
    should_retry: false,
    should_synthesize_cautiously: true,
    reasons: [...trace.gapAnalysis.reasons, reason]
  };
}

function unavailableSourcesFromSummary(sourceResults: ReturnType<typeof summarizeSourceResults>): SourceName[] {
  return Object.entries(sourceResults)
    .filter(([, result]) => {
      if (!result.queried || result.ok > 0 || !result.errors.length) return false;
      return result.errors.every((error) => {
        const code = String(error.code).toUpperCase();
        return (
          ["missing_config", "rate_limited", "query_invalid", "unavailable"].includes(error.category) ||
          code.includes("MISSING") ||
          code.includes("DISABLED") ||
          code === "HTTP_403" ||
          code === "HTTP_429" ||
          code === "HTTP_422"
        );
      });
    })
    .map(([source]) => source as SourceName);
}

function recordGapStopWarning(trace: ReturnType<typeof createTraceBuilder>): void {
  if (trace.gapAnalysis?.stop_reason !== "adequate_with_soft_gaps") return;
  const message =
    trace.gapAnalysis.reasons.find((reason) => reason.startsWith("Adequate evidence; soft source gaps")) ??
    "Adequate evidence; soft source gaps were not repaired further.";
  if (!trace.warnings.includes(message)) trace.warnings.push(message);
}

function filterUnavailableSources(subQueries: SubQuery[], unavailableSources: SourceName[]): SubQuery[] {
  if (!unavailableSources.length) return uniqueSubQueries(subQueries);
  const unavailable = new Set(unavailableSources);
  return uniqueSubQueries(
    subQueries.flatMap((subQuery) => {
      const target_sources = subQuery.target_sources.filter((source) => !unavailable.has(source));
      return target_sources.length ? [{ ...subQuery, target_sources }] : [];
    })
  );
}

function broadenRepairSubQueries(
  recommended: SubQuery[],
  query: string,
  sourceTypeGaps: RequiredSourceType[],
  roundIndex: number
): SubQuery[] {
  const broadened = [...recommended];
  if (roundIndex >= 2) {
    broadened.push(...broadSourceQueries(query, sourceTypeGaps));
  }
  if (roundIndex >= 3) {
    broadened.push(...exhaustiveSourceTypeQueries(query, sourceTypeGaps));
  }
  return uniqueSubQueries(broadened);
}

function broadSourceQueries(query: string, sourceTypeGaps: RequiredSourceType[]): SubQuery[] {
  const gaps: RequiredSourceType[] = sourceTypeGaps.length ? sourceTypeGaps : ["primary-document", "academic", "government"];
  return gaps.flatMap((gap) => subQueriesForSourceType(query, gap, true));
}

function exhaustiveSourceTypeQueries(query: string, sourceTypeGaps: RequiredSourceType[]): SubQuery[] {
  const gaps: RequiredSourceType[] = sourceTypeGaps.length
    ? sourceTypeGaps
    : ["academic", "primary-document", "government", "encyclopedic", "forum", "code"];
  return gaps.flatMap((gap) => subQueriesForSourceType(query, gap, false));
}

function subQueriesForSourceType(query: string, sourceType: RequiredSourceType, broad: boolean): SubQuery[] {
  const suffix = broad ? "official evidence mechanism source details" : "supporting context source attribution";
  if (sourceType === "academic") {
    return [
      makeRepairSubQuery(`${query} academic literature evidence mechanism`, ["openalex", "crossref", "arxiv", "semantic_scholar"], "corroborating", broad ? 8 : 6)
    ];
  }
  if (sourceType === "primary-document" || sourceType === "filing") {
    return [
      makeRepairSubQuery(`${query} SEC filing EDGAR official disclosure ${suffix}`, ["sec_edgar", "official_docs"], "primary_evidence", broad ? 7 : 5),
      makeRepairSubQuery(`${query} official primary source documentation ${suffix}`, ["official_docs", "data_gov", "wikidata"], "primary_evidence", broad ? 7 : 5)
    ];
  }
  if (sourceType === "government") {
    return [makeRepairSubQuery(`${query} government official data report ${suffix}`, ["official_docs", "data_gov", "wikidata"], "primary_evidence", broad ? 8 : 5)];
  }
  if (sourceType === "encyclopedic") {
    return [makeRepairSubQuery(`${query} background entities definitions context`, ["wikipedia", "wikidata"], "definitional", 4)];
  }
  if (sourceType === "forum") {
    return [makeRepairSubQuery(`${query} practitioner discussion implementation constraints`, ["stack_exchange", "hacker_news"], "contrarian", 4)];
  }
  if (sourceType === "code") {
    return [makeRepairSubQuery(`${query} implementation repository documentation`, ["github", "stack_exchange"], "corroborating", 5)];
  }
  if (sourceType === "medical") {
    return [makeRepairSubQuery(`${query} medical clinical literature`, ["pubmed", "openalex"], "corroborating", 5)];
  }
  return [];
}

function makeRepairSubQuery(
  sub_query: string,
  target_sources: SourceName[],
  retrieval_intent: SubQuery["retrieval_intent"],
  max_results: number
): SubQuery {
  return { sub_query, target_sources, retrieval_intent, max_results: Math.min(10, Math.max(1, max_results)) };
}

function uniqueSubQueries(subQueries: SubQuery[]): SubQuery[] {
  const seen = new Set<string>();
  const unique: SubQuery[] = [];
  for (const subQuery of subQueries) {
    const key = `${subQuery.sub_query.toLowerCase()}|${[...subQuery.target_sources].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(subQuery);
  }
  return unique.slice(0, 12);
}

export function makeMockRawItems(query: string): RawItem[] {
  const now = new Date().toISOString();
  return [
    {
      id: "mock:cbo",
      source: "data_gov",
      source_type: "government",
      url: "https://www.cbo.gov/",
      title: "Mock official data result",
      author: "Public agency",
      publish_date: now,
      text: `Official data relevant to ${query}. It includes primary-source evidence, fiscal constraints, source attribution, and traceable decision points.`,
      summary: "Mock official source summary.",
      metadata: { mode: "mock" }
    },
    {
      id: "mock:academic",
      source: "crossref",
      source_type: "academic",
      url: "https://api.crossref.org/",
      title: "Mock academic result",
      author: "Research metadata",
      publish_date: now,
      text: `Academic metadata relevant to ${query}. It supports corroborating evidence, definitions, and method framing for a consuming LLM.`,
      summary: "Mock academic source summary.",
      metadata: { mode: "mock" }
    },
    {
      id: "mock:discussion",
      source: "github",
      source_type: "code",
      url: "https://github.com/",
      title: "Mock code evidence result",
      author: "Public repository",
      publish_date: now,
      text: `Code-oriented evidence relevant to ${query}. It highlights implementation choices, tests, validation, and operational guardrails.`,
      summary: "Mock code source summary.",
      metadata: { mode: "mock" }
    }
  ];
}

function createRuleBasedMockProvider(): LLMProvider {
  return createMockLLMProvider((input) => {
    const query = typeof input.metadata?.query === "string" ? input.metadata.query : extractQueryFromPrompt(input.prompt);
    if (input.schemaName === "IntentObject") {
      return fallbackIntent(query);
    }
    if (input.schemaName === "QueryStrategyResponse") {
      const intent = fallbackIntent(query);
      return { sub_queries: fallbackSubQueries(query, intent) };
    }
    if (input.schemaName === "ChunkScoringResponse") {
      const chunkIds = Array.isArray(input.metadata?.chunkIds) ? input.metadata.chunkIds : [];
      return {
        scores: chunkIds.map((chunkId) => ({
          chunk_id: String(chunkId),
          relevance_to_query: 0.82,
          confidence_score: 0.78,
          freshness_fitness: 0.75,
          surprise_score: 0.55,
          claim_graph: [
            {
              claim: "Mock scorer found this chunk relevant to the query.",
              claim_type: "asserted",
              supporting_text_offset: [0, 80]
            }
          ],
          epistemic_stance: "secondary_analysis"
        }))
      };
    }
    return {};
  });
}

function extractQueryFromPrompt(prompt: string): string {
  const match = prompt.match(/User query:\s*(.+)/);
  return match?.[1]?.trim() || "mock query";
}
