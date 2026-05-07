import { randomUUID } from "node:crypto";
import {
  DEFAULTS,
  TraceSchema,
  type EvidenceHealth,
  type ExtractionTrace,
  type GapAnalysis,
  type ModelCostLineItem,
  type CostSummary,
  type PreRankDiagnostics,
  type RetrievalRound,
  type Stage6BatchDiagnostics,
  type StructuredLLMCallTrace,
  type SynthesisReview,
  type Trace
} from "@agent-search/shared";
import type { StageError } from "./errors.js";
import type { AssemblySelection } from "./stage8Assemble.js";

export interface TraceBuilder {
  requestId: string;
  startedAt: string;
  stageTimingsMs: Record<string, number>;
  sourceResults: Trace["source_results"];
  errors: StageError[];
  warnings: string[];
  modelUsage: Trace["model_usage"];
  modelCostLineItems: ModelCostLineItem[];
  costSummary?: CostSummary;
  escalations: Trace["escalations"];
  deduplication: Trace["deduplication"];
  evidenceHealth?: EvidenceHealth;
  extraction?: ExtractionTrace;
  retrievalRounds: RetrievalRound[];
  preRank: PreRankDiagnostics[];
  scoringBatches: Stage6BatchDiagnostics[];
  structuredLlmCalls: StructuredLLMCallTrace[];
  gapAnalysis?: GapAnalysis;
  synthesisReview?: SynthesisReview;
  counts: Trace["counts"];
  selection: AssemblySelection;
}

export function createTraceBuilder(tokenBudget: number = DEFAULTS.tokenBudget): TraceBuilder {
  return {
    requestId: randomUUID(),
    startedAt: new Date().toISOString(),
    stageTimingsMs: {},
    sourceResults: {},
    errors: [],
    warnings: [],
    modelUsage: {},
    modelCostLineItems: [],
    costSummary: undefined,
    escalations: [],
    deduplication: { clusters: [] },
    evidenceHealth: undefined,
    extraction: undefined,
    retrievalRounds: [],
    preRank: [],
    scoringBatches: [],
    structuredLlmCalls: [],
    gapAnalysis: undefined,
    synthesisReview: undefined,
    counts: {
      raw_items: 0,
      normalized_chunks: 0,
      scored_chunks: 0,
      filtered_chunks: 0,
      deduped_chunks: 0,
      selected_chunks: 0
    },
    selection: {
      token_budget: tokenBudget,
      estimated_tokens_used: 0,
      selected_chunk_ids: [],
      rejected_chunk_ids: [],
      final_marginal_gains: {},
      reasons: {}
    }
  };
}

export async function timeStage<T>(trace: TraceBuilder, stageName: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    trace.stageTimingsMs[stageName] = Date.now() - started;
  }
}

export function finalizeTrace(trace: TraceBuilder): Trace {
  return TraceSchema.parse({
    request_id: trace.requestId,
    started_at: trace.startedAt,
    finished_at: new Date().toISOString(),
    stage_timings_ms: trace.stageTimingsMs,
    source_results: trace.sourceResults,
    errors: trace.errors,
    warnings: trace.warnings,
    model_usage: trace.modelUsage,
    cost_summary: trace.costSummary,
    escalations: trace.escalations,
    deduplication: trace.deduplication,
    evidence_health: trace.evidenceHealth,
    extraction: trace.extraction,
    retrieval_rounds: trace.retrievalRounds,
    pre_rank: trace.preRank,
    scoring_batches: trace.scoringBatches,
    structured_llm_calls: trace.structuredLlmCalls,
    gap_analysis: trace.gapAnalysis,
    synthesis_review: trace.synthesisReview,
    counts: trace.counts,
    selection: trace.selection
  });
}
