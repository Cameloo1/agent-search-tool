import { z } from "zod";
import {
  ALLOWED_SOURCE_NAMES,
  CLAIM_TYPES,
  DEFAULTS,
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

export const SOURCE_ID_PATTERN = "^[a-z][a-z0-9_:-]{1,63}$";
export const BuiltInSourceNameSchema = z.enum(ALLOWED_SOURCE_NAMES);
export const SourceIdSchema = z
  .string()
  .regex(new RegExp(SOURCE_ID_PATTERN), "Source ids must be lowercase and may contain numbers, underscores, hyphens, and colons.");
export const SourceNameSchema = SourceIdSchema;
export const QueryTypeSchema = z.enum(QUERY_TYPES);
export const RequiredSourceTypeSchema = z.enum(REQUIRED_SOURCE_TYPES);
export const NormalizedSourceTypeSchema = z.enum(NORMALIZED_SOURCE_TYPES);
export const RetrievalIntentSchema = z.enum(RETRIEVAL_INTENTS);
export const ClaimTypeSchema = z.enum(CLAIM_TYPES);
export const EpistemicStanceSchema = z.enum(EPISTEMIC_STANCES);
export const OpponentModeSchema = z.enum(OPPONENT_MODES);
export const ScoreStatusSchema = z.enum(SCORE_STATUSES);
export const EvidenceHealthStatusSchema = z.enum(EVIDENCE_HEALTH_STATUSES);
export const SourceErrorCategorySchema = z.enum(SOURCE_ERROR_CATEGORIES);
export const QualityModeSchema = z.enum(QUALITY_MODES);
export const LLMStageKeySchema = z.enum(LLM_STAGE_KEYS);
export const SourceDescriptorSchema = z
  .object({
    id: SourceNameSchema,
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    source_type: NormalizedSourceTypeSchema.optional(),
    built_in: z.boolean().default(false).optional()
  })
  .strict();
export const SourcePluginEnvVarSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean().default(false),
    description: z.string().min(1).optional()
  })
  .strict();
export const SourcePluginManifestSchema = z
  .object({
    id: SourceNameSchema,
    version: z.string().min(1),
    entrypoint: z.string().min(1),
    compatibility: z.string().min(1).default("^0.1.0"),
    sources: z.array(SourceDescriptorSchema.extend({ id: SourceNameSchema })).min(1),
    env: z.array(SourcePluginEnvVarSchema).default([]),
    permissions: z
      .object({
        network: z.array(z.string().min(1)).default([]),
        filesystem: z.array(z.string().min(1)).default([])
      })
      .default({ network: [], filesystem: [] })
  })
  .strict();
export const ModelOverridesSchema = z
  .object({
    default: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    strategy: z.string().min(1).optional(),
    scoring: z.string().min(1).optional(),
    synthesis: z.string().min(1).optional(),
    adjudicator: z.string().min(1).optional()
  })
  .strict();

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1)
});

export const IntentObjectSchema = z.object({
  core_intent: z.string().min(1),
  query_type: z.array(QueryTypeSchema).min(1),
  entities: z.array(z.string()).default([]),
  temporal_constraints: z.string().nullable(),
  required_source_types: z.array(RequiredSourceTypeSchema).default([])
});

export const SubQuerySchema = z.object({
  sub_query: z.string().min(1),
  target_sources: z.array(SourceNameSchema).min(1),
  retrieval_intent: RetrievalIntentSchema,
  max_results: z.number().int().min(1).max(10)
});

export const RawItemSchema = z.object({
  id: z.string().min(1),
  source: SourceNameSchema,
  source_type: NormalizedSourceTypeSchema,
  url: z.string().url(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publish_date: z.string().datetime().nullable(),
  text: z.string(),
  summary: z.string().nullable(),
  metadata: z.record(z.unknown()).default({})
});

export const SourceErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  category: SourceErrorCategorySchema.default("unknown")
});

const SourceFetchSuccessSchema = z.object({
  source: SourceNameSchema,
  ok: z.literal(true),
  items: z.array(RawItemSchema),
  error: z.null(),
  timing_ms: z.number().nonnegative()
});

const SourceFetchFailureSchema = z.object({
  source: SourceNameSchema,
  ok: z.literal(false),
  items: z.tuple([]),
  error: SourceErrorSchema,
  timing_ms: z.number().nonnegative()
});

export const SourceFetchResultSchema = z.discriminatedUnion("ok", [
  SourceFetchSuccessSchema,
  SourceFetchFailureSchema
]);

export const FetchOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULTS.sourceTimeoutMs),
  maxResults: z.number().int().min(1).max(10).default(5),
  apiKeys: z
    .object({
      core: z.string().optional(),
      github: z.string().optional(),
      semanticScholar: z.string().optional()
    })
    .optional(),
  secUserAgent: z.string().optional(),
  signal: z.custom<AbortSignal>().optional()
});

export const ClaimGraphItemSchema = z.object({
  claim: z.string().min(1),
  claim_type: ClaimTypeSchema,
  supporting_text_offset: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
});

export const ExtractionDocumentTypeSchema = z.enum([
  "html",
  "pdf",
  "api_record",
  "repository",
  "dataset",
  "filing",
  "paper",
  "unknown"
]);

export const ExtractionRetrievalMethodSchema = z.enum([
  "source_api",
  "canonical_url",
  "html_fetch",
  "pdf_fetch",
  "repository_api",
  "metadata"
]);

export const ExtractionMethodSchema = z.enum([
  "source_api_text",
  "readability_html",
  "pdf_text",
  "source_snippet",
  "metadata_only"
]);

export const ExtractionStatusSchema = z.enum([
  "full_text",
  "section_text",
  "structured_abstract",
  "snippet",
  "metadata_only",
  "failed"
]);

export const ExtractionAttemptSchema = z.object({
  method: ExtractionMethodSchema,
  retrieval_method: ExtractionRetrievalMethodSchema,
  status: ExtractionStatusSchema,
  duration_ms: z.number().int().nonnegative(),
  char_count: z.number().int().nonnegative(),
  started_at: z.string().datetime(),
  error_code: z.string().optional(),
  error_message: z.string().optional()
});

export const ExtractionMetadataSchema = z.object({
  canonical_url: z.string().url(),
  document_type: ExtractionDocumentTypeSchema,
  retrieval_method: ExtractionRetrievalMethodSchema,
  extraction_method: ExtractionMethodSchema,
  extraction_status: ExtractionStatusSchema,
  extraction_confidence: z.number().min(0).max(1),
  content_coverage: z.number().min(0).max(1),
  section_path: z.array(z.string()).default([]),
  page_number: z.number().int().positive().nullable().optional(),
  line_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable().optional(),
  degradation_reason: z.string().optional(),
  attempts: z.array(ExtractionAttemptSchema).default([])
});

export const EvidenceDocumentSchema = z.object({
  id: z.string().min(1),
  source: SourceNameSchema,
  source_type: NormalizedSourceTypeSchema,
  url: z.string().url(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  publish_date: z.string().datetime().nullable(),
  text: z.string(),
  summary: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  extraction: ExtractionMetadataSchema
});

export const NormalizedChunkSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  metadata: z.object({
    url: z.string().url(),
    source_name: SourceNameSchema,
    source_type: NormalizedSourceTypeSchema,
    title: z.string().nullable(),
    publish_date: z.string().datetime().nullable(),
    author: z.string().nullable(),
    confidence_score: z.number().min(0).max(1),
    summary: z.string().nullable(),
    claim_graph: z.array(ClaimGraphItemSchema),
    epistemic_stance: EpistemicStanceSchema,
    surprise_score: z.number().min(0).max(1),
    extraction: ExtractionMetadataSchema.optional()
  }),
  _internal: z.object({
    relevance_to_query: z.number().min(0).max(1),
    source_weight: z.number().min(0).max(1),
    freshness_fitness: z.number().min(0).max(1),
    embedding: z.array(z.number())
  })
});

export const PipelineRequestSchema = z.object({
  query: z.string().min(1),
  chat_history: z.array(ChatMessageSchema).optional(),
  memory_snippet: z.string().optional(),
  token_budget: z.number().int().positive().optional(),
  quality_mode: QualityModeSchema.default("fast").optional(),
  synthesize_answer: z.boolean().optional(),
  model_overrides: ModelOverridesSchema.optional(),
  debug: z.boolean().optional()
});

export const EvidenceHealthSchema = z.object({
  status: EvidenceHealthStatusSchema,
  evidence_quality_score: z.number().min(0).max(100),
  evidence_coverage_score: z.number().min(0).max(100),
  components: z.object({
    relevance_confidence: z.number().min(0).max(100),
    source_authority: z.number().min(0).max(100),
    coverage_diversity: z.number().min(0).max(100),
    freshness_failure: z.number().min(0).max(100)
  }),
  reasons: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  details: z.object({
    selected_chunk_count: z.number().int().nonnegative(),
    selected_claim_count: z.number().int().nonnegative(),
    distinct_source_count: z.number().int().nonnegative(),
    distinct_source_type_count: z.number().int().nonnegative(),
    primary_source_count: z.number().int().nonnegative(),
    failed_important_source_count: z.number().int().nonnegative(),
    failed_source_count: z.number().int().nonnegative(),
    degraded_extraction_count: z.number().int().nonnegative().default(0),
    metadata_only_count: z.number().int().nonnegative().default(0),
    failed_extraction_count: z.number().int().nonnegative().default(0),
    average_relevance: z.number().min(0).max(1),
    average_confidence: z.number().min(0).max(1),
    average_source_weight: z.number().min(0).max(1),
    average_freshness: z.number().min(0).max(1),
    non_redundancy: z.number().min(0).max(1),
    matched_required_source_types: z.array(RequiredSourceTypeSchema),
    missing_required_source_types: z.array(RequiredSourceTypeSchema),
    failed_important_sources: z.array(SourceNameSchema)
  })
});

export const TraceStageErrorSchema = z.object({
  stage: z.string(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional()
});

export const TraceSourceResultSchema = z.object({
  queried: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  timing_ms: z.number().nonnegative(),
  errors: z.array(SourceErrorSchema).default([])
});

export const GapAnalysisSchema = z.object({
  status: z.enum(["no_retry", "retry_retrieval", "retry_scoring", "synthesize_cautiously"]),
  should_retry: z.boolean(),
  should_synthesize_cautiously: z.boolean(),
  missing_facets: z.array(z.string()).default([]),
  source_type_gaps: z.array(RequiredSourceTypeSchema).default([]),
  hard_source_type_gaps: z.array(RequiredSourceTypeSchema).default([]),
  soft_source_type_gaps: z.array(RequiredSourceTypeSchema).default([]),
  stop_reason: z.string().optional(),
  bad_context_reasons: z.array(z.string()).default([]),
  keyword_only_chunk_ids: z.array(z.string()).default([]),
  important_failed_sources: z.array(SourceNameSchema).default([]),
  recommended_sub_queries: z.array(SubQuerySchema).default([]),
  reasons: z.array(z.string()).default([])
});

export const PreRankCandidateSchema = z.object({
  chunk_id: z.string(),
  local_score: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([])
});

export const PreRankDuplicateGroupSchema = z.object({
  id: z.string(),
  representative_id: z.string(),
  member_ids: z.array(z.string()),
  reason: z.string()
});

export const PreRankDiagnosticsSchema = z.object({
  round_index: z.number().int().nonnegative(),
  broadening_level: z.number().int().nonnegative(),
  input_chunk_count: z.number().int().nonnegative(),
  duplicate_group_count: z.number().int().nonnegative(),
  duplicate_rejected_count: z.number().int().nonnegative(),
  selected_for_llm_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  unavailable_sources_skipped: z.array(SourceNameSchema).default([]),
  selected_candidates: z.array(PreRankCandidateSchema).default([]),
  rejected_candidates: z.array(PreRankCandidateSchema).default([]),
  duplicate_groups: z.array(PreRankDuplicateGroupSchema).default([])
});

export const TokenUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().default(0),
  completion_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative().default(0),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional()
});

export const ModelCostPricingSourceSchema = z.enum([
  "provider_usage",
  "catalog_estimate",
  "mock_zero",
  "unavailable"
]);

export const ModelCostLineItemSchema = z.object({
  id: z.string().min(1),
  stage: LLMStageKeySchema,
  task: z.string().min(1),
  schema_name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  quality_mode: QualityModeSchema,
  attempt: z.number().int().positive(),
  usage: TokenUsageSchema,
  input_cost_usd: z.number().nonnegative().nullable(),
  output_cost_usd: z.number().nonnegative().nullable(),
  total_cost_usd: z.number().nonnegative().nullable(),
  pricing_source: ModelCostPricingSourceSchema,
  generation_id: z.string().nullable(),
  duration_ms: z.number().int().nonnegative().optional(),
  estimated: z.boolean().default(false),
  warnings: z.array(z.string()).default([])
});

export const StructuredLLMCallTraceSchema = z.object({
  stage: z.string().min(1),
  task: z.string().min(1),
  schema_name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  quality_mode: QualityModeSchema.optional(),
  attempt: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  ok: z.boolean(),
  usage: TokenUsageSchema.optional(),
  cost_usd: z.number().nonnegative().nullable().optional(),
  pricing_source: ModelCostPricingSourceSchema.optional(),
  generation_id: z.string().nullable().optional(),
  validation_issues: z.array(z.string()).default([]),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  raw_output_snippet: z.string().optional(),
  timeout: z.boolean().default(false),
  reasoning_enabled: z.boolean().optional()
});

export const Stage6BatchDiagnosticsSchema = z.object({
  stage_label: z.string().min(1),
  batch_index: z.number().int().nonnegative(),
  batch_start: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  kept_count: z.number().int().nonnegative(),
  filtered_count: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  fallback_used: z.boolean(),
  total_tokens: z.number().int().nonnegative().default(0),
  concurrency: z.number().int().positive(),
  cache_hit_count: z.number().int().nonnegative().default(0),
  cache_miss_count: z.number().int().nonnegative().default(0),
  cached_chunk_ids: z.array(z.string()).default([])
});

export const ModelCostGroupSchema = z.object({
  total_cost_usd: z.number().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  line_item_count: z.number().int().nonnegative(),
  estimated: z.boolean()
});

export const CostSummarySchema = z.object({
  currency: z.literal("USD"),
  total_cost_usd: z.number().nonnegative(),
  total_prompt_tokens: z.number().int().nonnegative(),
  total_completion_tokens: z.number().int().nonnegative(),
  total_reasoning_tokens: z.number().int().nonnegative(),
  total_cached_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
  pricing_source: z.enum(["provider_usage", "catalog_estimate", "mixed", "mock_zero", "unavailable"]),
  by_stage: z.record(ModelCostGroupSchema),
  by_model: z.record(ModelCostGroupSchema),
  line_items: z.array(ModelCostLineItemSchema),
  warnings: z.array(z.string()).default([])
});

export const ExtractionDocumentTraceSchema = z.object({
  document_id: z.string().min(1),
  source: SourceNameSchema,
  canonical_url: z.string().url(),
  document_type: ExtractionDocumentTypeSchema,
  extraction_status: ExtractionStatusSchema,
  extraction_method: ExtractionMethodSchema,
  duration_ms: z.number().int().nonnegative(),
  char_count: z.number().int().nonnegative(),
  degraded: z.boolean(),
  attempts: z.array(ExtractionAttemptSchema).default([]),
  degradation_reason: z.string().optional()
});

export const ExtractionTraceSchema = z.object({
  document_count: z.number().int().nonnegative(),
  source_item_count: z.number().int().nonnegative(),
  deepened_document_count: z.number().int().nonnegative(),
  degraded_document_count: z.number().int().nonnegative(),
  metadata_only_count: z.number().int().nonnegative(),
  failed_extraction_count: z.number().int().nonnegative(),
  attempt_count: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  max_documents: z.number().int().nonnegative(),
  documents: z.array(ExtractionDocumentTraceSchema).default([])
});

export const RetrievalRoundSchema = z.object({
  round_index: z.number().int().nonnegative(),
  reason: z.string().min(1),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  sub_queries: z.array(SubQuerySchema),
  raw_item_count: z.number().int().nonnegative(),
  normalized_chunk_count: z.number().int().nonnegative(),
  scored_chunk_count: z.number().int().nonnegative(),
  filtered_chunk_count: z.number().int().nonnegative(),
  deduped_chunk_count: z.number().int().nonnegative(),
  selected_chunk_count: z.number().int().nonnegative(),
  pre_rank: PreRankDiagnosticsSchema.optional(),
  scoring_batches: z.array(Stage6BatchDiagnosticsSchema).default([]),
  extraction: ExtractionTraceSchema.optional(),
  evidence_health: EvidenceHealthSchema.optional(),
  gap_analysis: GapAnalysisSchema.optional(),
  source_results: z.record(TraceSourceResultSchema).default({}),
  warnings: z.array(z.string()).default([]),
  errors: z.array(TraceStageErrorSchema).default([])
});

export const SynthesisReviewSchema = z.object({
  final_answer: z.string().min(1),
  coverage_status: z.enum(["answered", "partially_answered", "insufficient_evidence"]),
  addressed_questions: z.array(z.string()).default([]),
  remaining_gaps: z.array(z.string()).default([]),
  unsupported_or_weak_claims: z.array(z.string()).default([]),
  source_backed_claims: z.array(z.string()).default([]),
  model_prior_notes: z.array(z.string()).default([]),
  keyword_context_warnings: z.array(z.string()).default([]),
  cited_chunk_ids: z.array(z.string()).default([])
});

export const TraceSchema = z.object({
  request_id: z.string().min(1),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  stage_timings_ms: z.record(z.number().nonnegative()),
  source_results: z.record(TraceSourceResultSchema),
  errors: z.array(TraceStageErrorSchema),
  warnings: z.array(z.string()),
  model_usage: z
    .record(
      z.object({
        provider: z.string(),
        model: z.string(),
        stage: LLMStageKeySchema,
        quality_mode: QualityModeSchema,
        escalated: z.boolean().default(false),
        reason: z.string().optional()
      })
    )
    .default({}),
  cost_summary: CostSummarySchema.optional(),
  escalations: z
    .array(
      z.object({
        stage: LLMStageKeySchema,
        from_model: z.string(),
        to_model: z.string(),
        reason: z.string()
      })
    )
    .default([]),
  deduplication: z
    .object({
      clusters: z.array(
        z.object({
          id: z.string(),
          representative_id: z.string(),
          member_ids: z.array(z.string()),
          rejected_ids: z.array(z.string()),
          duplicate_level: z.enum(["document", "chunk", "claim", "semantic"]),
          novelty_score: z.number().min(0).max(1).optional(),
          js_divergence: z.number().min(0).max(1).optional()
        })
      )
    })
    .default({ clusters: [] }),
  evidence_health: EvidenceHealthSchema.optional(),
  retrieval_rounds: z.array(RetrievalRoundSchema).default([]),
  extraction: ExtractionTraceSchema.optional(),
  pre_rank: z.array(PreRankDiagnosticsSchema).default([]),
  scoring_batches: z.array(Stage6BatchDiagnosticsSchema).default([]),
  structured_llm_calls: z.array(StructuredLLMCallTraceSchema).default([]),
  gap_analysis: GapAnalysisSchema.optional(),
  synthesis_review: SynthesisReviewSchema.optional(),
  counts: z.object({
    raw_items: z.number().int().nonnegative(),
    normalized_chunks: z.number().int().nonnegative(),
    scored_chunks: z.number().int().nonnegative(),
    filtered_chunks: z.number().int().nonnegative(),
    deduped_chunks: z.number().int().nonnegative(),
    selected_chunks: z.number().int().nonnegative()
  }),
  selection: z.object({
    token_budget: z.number().int().nonnegative(),
    estimated_tokens_used: z.number().int().nonnegative(),
    selected_chunk_ids: z.array(z.string()),
    rejected_chunk_ids: z.array(z.string()),
    final_marginal_gains: z.record(z.number()).default({}),
    reasons: z.record(z.string()).default({})
  })
});

export const AtomicFactSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  weight: z.number().positive().default(1)
});

export const RequiredSourceSchema = z.object({
  id: z.string().min(1),
  type: RequiredSourceTypeSchema,
  description: z.string().min(1),
  weight: z.number().positive().default(1)
});

export const GoldQuestionSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  query_types: z.array(QueryTypeSchema).min(1),
  question: z.string().min(1)
});

export const GoldAnswerSchema = z.object({
  question_id: z.string().min(1),
  gold_answer: z.string().min(1),
  must_hit_atomic_facts: z.array(AtomicFactSchema).min(1),
  required_source_types: z.array(RequiredSourceSchema).min(1),
  penalize_if: z.array(z.string()).default([]),
  methodology_notes: z.string().default("")
});

export const GoldArtifactSchema = z.object({
  version: z.string().min(1),
  methodology: z.string().min(1),
  questions: z.array(GoldQuestionSchema).length(5),
  answers: z.array(GoldAnswerSchema).length(5)
});

export const CitedSourceSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().nullable().optional(),
  source_name: z.string().optional(),
  provenance: z.enum(["primary", "secondary", "tertiary", "forum/opinion", "unknown"]),
  source_type: NormalizedSourceTypeSchema.optional()
});

export const EvaluationResultSchema = z.object({
  engine_name: z.string().min(1),
  question_id: z.string(),
  score_status: ScoreStatusSchema,
  facts_hit: z.number().int().nonnegative(),
  facts_total: z.number().int().nonnegative(),
  required_source_types_hit: z.number().int().nonnegative(),
  required_source_types_total: z.number().int().nonnegative(),
  primary_source_count: z.number().int().nonnegative(),
  hallucination_flags: z.array(z.string()),
  unsourced_claims: z.array(z.string()),
  token_count: z.number().int().nonnegative(),
  time_to_result_ms: z.number().int().nonnegative(),
  notes: z.array(z.string())
});

export const PipelineResponseSchema = z.object({
  query: z.string(),
  intent: IntentObjectSchema,
  sub_queries_executed: z.array(SubQuerySchema),
  chunks: z.array(NormalizedChunkSchema),
  synthesized_answer: z.string().optional(),
  synthesis_review: SynthesisReviewSchema.optional(),
  adjudication: EvaluationResultSchema.optional(),
  evidence_health: EvidenceHealthSchema.optional(),
  trace: TraceSchema
});

export const OpponentResultFixtureSchema = z.object({
  engine_name: z.string().min(1),
  question_id: z.string().min(1),
  final_answer: z.string().default(""),
  sources_cited: z.array(CitedSourceSchema).default([]),
  token_count: z.number().int().nonnegative().default(0),
  time_to_result_ms: z.number().int().nonnegative().default(0),
  mode: OpponentModeSchema,
  notes: z.array(z.string()).default([])
});

export const ComparisonItemSchema = z.object({
  engine_name: z.string(),
  question_id: z.string(),
  final_answer: z.string(),
  sources_cited: z.array(CitedSourceSchema),
  token_count: z.number().int().nonnegative(),
  time_to_result_ms: z.number().int().nonnegative(),
  mode: OpponentModeSchema,
  evaluation: EvaluationResultSchema,
  pipeline: PipelineResponseSchema.optional()
});
