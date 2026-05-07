import type { z } from "zod";
import type {
  AtomicFactSchema,
  CitedSourceSchema,
  ChatMessageSchema,
  CostSummarySchema,
  EvaluationResultSchema,
  EvidenceHealthSchema,
  EvidenceDocumentSchema,
  ExtractionAttemptSchema,
  ExtractionMetadataSchema,
  ExtractionTraceSchema,
  GapAnalysisSchema,
  ComparisonItemSchema,
  GoldArtifactSchema,
  FetchOptionsSchema,
  GoldAnswerSchema,
  GoldQuestionSchema,
  IntentObjectSchema,
  NormalizedChunkSchema,
  OpponentResultFixtureSchema,
  PipelineRequestSchema,
  PipelineResponseSchema,
  PreRankDiagnosticsSchema,
  RawItemSchema,
  RetrievalRoundSchema,
  RequiredSourceSchema,
  ModelCostLineItemSchema,
  Stage6BatchDiagnosticsSchema,
  SourceDescriptorSchema,
  SourcePluginEnvVarSchema,
  SourcePluginManifestSchema,
  StructuredLLMCallTraceSchema,
  SynthesisReviewSchema,
  SourceErrorSchema,
  SourceFetchResultSchema,
  SubQuerySchema,
  TokenUsageSchema,
  TraceSchema
} from "./schemas.js";
import type {
  ALLOWED_SOURCE_NAMES,
  CLAIM_TYPES,
  EVIDENCE_HEALTH_STATUSES,
  EPISTEMIC_STANCES,
  LLM_STAGE_KEYS,
  NORMALIZED_SOURCE_TYPES,
  OPPONENT_MODES,
  QUALITY_MODES,
  QUERY_TYPES,
  REQUIRED_SOURCE_TYPES,
  RETRIEVAL_INTENTS,
  SCORE_STATUSES,
  SOURCE_ERROR_CATEGORIES
} from "./constants.js";

declare const sourceIdBrand: unique symbol;

export type BuiltInSourceName = (typeof ALLOWED_SOURCE_NAMES)[number];
export type SourceId = string & { readonly [sourceIdBrand]: "SourceId" };
export type SourceName = string;
export type QueryType = (typeof QUERY_TYPES)[number];
export type RequiredSourceType = (typeof REQUIRED_SOURCE_TYPES)[number];
export type NormalizedSourceType = (typeof NORMALIZED_SOURCE_TYPES)[number];
export type RetrievalIntent = (typeof RETRIEVAL_INTENTS)[number];
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type EpistemicStance = (typeof EPISTEMIC_STANCES)[number];
export type OpponentMode = (typeof OPPONENT_MODES)[number];
export type ScoreStatus = (typeof SCORE_STATUSES)[number];
export type SourceErrorCategory = (typeof SOURCE_ERROR_CATEGORIES)[number];
export type EvidenceHealthStatus = (typeof EVIDENCE_HEALTH_STATUSES)[number];
export type QualityMode = (typeof QUALITY_MODES)[number];
export type LLMStageKey = (typeof LLM_STAGE_KEYS)[number];

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type IntentObject = z.infer<typeof IntentObjectSchema>;
export type SubQuery = z.infer<typeof SubQuerySchema>;
export type RawItem = z.infer<typeof RawItemSchema>;
export type SourceError = z.infer<typeof SourceErrorSchema>;
export type SourceFetchResult = z.infer<typeof SourceFetchResultSchema>;
export type FetchOptions = z.infer<typeof FetchOptionsSchema>;
export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;
export type SourcePluginEnvVar = z.infer<typeof SourcePluginEnvVarSchema>;
export type SourcePluginManifest = z.infer<typeof SourcePluginManifestSchema>;
export type NormalizedChunk = z.infer<typeof NormalizedChunkSchema>;
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;
export type PipelineResponse = z.infer<typeof PipelineResponseSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type ModelCostLineItem = z.infer<typeof ModelCostLineItemSchema>;
export type CostSummary = z.infer<typeof CostSummarySchema>;
export type PreRankDiagnostics = z.infer<typeof PreRankDiagnosticsSchema>;
export type Stage6BatchDiagnostics = z.infer<typeof Stage6BatchDiagnosticsSchema>;
export type StructuredLLMCallTrace = z.infer<typeof StructuredLLMCallTraceSchema>;
export type Trace = z.infer<typeof TraceSchema>;
export type GoldQuestion = z.infer<typeof GoldQuestionSchema>;
export type GoldAnswer = z.infer<typeof GoldAnswerSchema>;
export type AtomicFact = z.infer<typeof AtomicFactSchema>;
export type RequiredSource = z.infer<typeof RequiredSourceSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type EvidenceHealth = z.infer<typeof EvidenceHealthSchema>;
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;
export type ExtractionAttempt = z.infer<typeof ExtractionAttemptSchema>;
export type ExtractionMetadata = z.infer<typeof ExtractionMetadataSchema>;
export type ExtractionTrace = z.infer<typeof ExtractionTraceSchema>;
export type GapAnalysis = z.infer<typeof GapAnalysisSchema>;
export type RetrievalRound = z.infer<typeof RetrievalRoundSchema>;
export type SynthesisReview = z.infer<typeof SynthesisReviewSchema>;
export type OpponentResultFixture = z.infer<typeof OpponentResultFixtureSchema>;
export type GoldArtifact = z.infer<typeof GoldArtifactSchema>;
export type ComparisonItem = z.infer<typeof ComparisonItemSchema>;
export type CitedSource = z.infer<typeof CitedSourceSchema>;

export interface StructuredLLMInput {
  task: string;
  prompt: string;
  schemaName: string;
  model?: string;
  stage?: LLMStageKey;
  reasoningEnabled?: boolean;
  jsonSchema?: unknown;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMCallMetadata {
  provider: string;
  model?: string;
  generationId?: string;
  usage?: Partial<TokenUsage>;
  costUsd?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  pricingSource?: "provider_usage" | "catalog_estimate" | "mock_zero" | "unavailable";
  warnings?: string[];
}

export interface LLMProviderResponse {
  output: unknown;
  metadata?: LLMCallMetadata;
}

export interface LLMProvider {
  name: string;
  model?: string;
  generateStructured(input: StructuredLLMInput): Promise<unknown | LLMProviderResponse>;
}

export interface Embedder {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type PipelineProgressEvent =
  | {
      type: "stage_start";
      stage: string;
      message: string;
      at: string;
    }
  | {
      type: "stage_complete";
      stage: string;
      message: string;
      at: string;
      timing_ms?: number;
      counts?: Partial<Trace["counts"]>;
    }
  | {
      type: "stage_error";
      stage: string;
      message: string;
      at: string;
      error: string;
    }
  | {
      type: "stage_progress";
      stage: string;
      message: string;
      at: string;
      counts?: Partial<Trace["counts"]>;
      details?: Record<string, unknown>;
    }
  | {
      type: "source_start";
      stage: string;
      source: SourceName;
      sub_query: string;
      at: string;
    }
  | {
      type: "source_complete";
      stage: string;
      source: SourceName;
      ok: boolean;
      item_count: number;
      timing_ms: number;
      at: string;
      error?: SourceError;
    }
  | {
      type: "counts";
      stage: string;
      counts: Partial<Trace["counts"]>;
      at: string;
    }
  | {
      type: "retrieval_round";
      at: string;
      round_index: number;
      message: string;
      evidence_status?: EvidenceHealthStatus;
      counts?: Partial<Trace["counts"]>;
    }
  | {
      type: "gap_analysis";
      at: string;
      status: GapAnalysis["status"];
      should_retry: boolean;
      message: string;
      reasons: string[];
    }
  | {
      type: "final";
      at: string;
      response: PipelineResponse;
    }
  | {
      type: "fatal";
      at: string;
      error: string;
    };
