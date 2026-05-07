import type {
  EvaluationResult as SharedEvaluationResult,
  EvidenceHealth as SharedEvidenceHealth,
  CostSummary as SharedCostSummary,
  NormalizedChunk as SharedNormalizedChunk,
  OpponentMode as SharedOpponentMode,
  PipelineProgressEvent as SharedPipelineProgressEvent,
  PipelineResponse as SharedPipelineResponse,
  QualityMode as SharedQualityMode,
  ScoreStatus as SharedScoreStatus,
  Trace as SharedTrace
} from "@agent-search/shared";

export type ScoreStatus = SharedScoreStatus;
export type OpponentMode = SharedOpponentMode;
export type EvaluationResult = SharedEvaluationResult;
export type Trace = SharedTrace;
export type QualityMode = SharedQualityMode;
export type EvidenceHealth = SharedEvidenceHealth;
export type PipelineProgressEvent = SharedPipelineProgressEvent;
export type CostSummary = SharedCostSummary;

export type BackendStatusState = "idle" | "live" | "stalled" | "done" | "broken";
export type RunFeedbackRating = "up" | "neutral" | "down";

export type SearchRunFeedback = {
  rating: RunFeedbackRating;
  note?: string;
  updated_at: string;
};

export type SearchRunFeedbackInput = {
  rating: RunFeedbackRating;
  note?: string;
};

export type SearchDebugRecord = {
  status: "ok" | "error";
  written_at: string;
  feedback?: SearchRunFeedback;
  events: PipelineProgressEvent[];
  request: {
    query: string;
    token_budget?: number;
    quality_mode?: string;
    synthesize_answer?: boolean;
    debug?: boolean;
    chat_history_count: number;
    memory_snippet_chars: number;
  };
  response?: {
    request_id: string;
    intent?: SharedPipelineResponse["intent"];
    sub_queries_executed?: SharedPipelineResponse["sub_queries_executed"];
    synthesized_answer?: string;
    synthesis_review?: SharedPipelineResponse["synthesis_review"];
    adjudication?: SharedPipelineResponse["adjudication"];
    evidence_health?: SharedPipelineResponse["evidence_health"];
    trace?: SharedPipelineResponse["trace"];
    cost_summary?: SharedPipelineResponse["trace"]["cost_summary"];
    retrieval_rounds?: SharedPipelineResponse["trace"]["retrieval_rounds"];
    gap_analysis?: SharedPipelineResponse["trace"]["gap_analysis"];
    trace_summary?: {
      sources_queried: string[];
      source_failures: Array<{ source: string; code: string; message: string }>;
      raw_item_count: number;
      normalized_chunk_count: number;
      scored_chunk_count: number;
      deduped_chunk_count: number;
      selected_chunk_count: number;
      estimated_tokens_used: number;
    };
    selected_chunks?: ApiNormalizedChunk[];
    selected_sources?: CitedSource[];
    ui_metrics?: {
      token_count: number;
      time_to_result_ms: number;
      evidence_quality?: number;
      evidence_coverage?: number;
      evidence_status?: string;
      score_status?: string;
      hallucination_flags: string[];
    };
    warnings?: string[];
    errors?: SharedPipelineResponse["trace"]["errors"];
  };
  error?: string;
};

export type ProvenanceLabel = "primary" | "secondary" | "tertiary" | "forum/opinion" | "unknown";

export type CitedSource = {
  url?: string;
  title?: string | null;
  source_name?: string;
  provenance?: ProvenanceLabel;
  source_type?: string;
  confidence_score?: number;
};

export type ApiNormalizedChunk = Omit<SharedNormalizedChunk, "_internal"> & {
  _internal?: Partial<SharedNormalizedChunk["_internal"]>;
};

export type ApiPipelineResponse = Omit<SharedPipelineResponse, "chunks"> & {
  chunks: ApiNormalizedChunk[];
  final_answer?: string;
};

export type CompareResult = {
  id: string;
  engine_name: string;
  question_id: string;
  final_answer: string;
  sources_cited: CitedSource[];
  token_count: number;
  time_to_result_ms: number;
  mode: OpponentMode;
  evaluation?: EvaluationResult;
  pipeline?: ApiPipelineResponse;
  notes?: string[];
  feedback?: SearchRunFeedback;
};

export type ApiCompareResult = {
  id?: string;
  engine_name?: string;
  question_id?: string;
  final_answer?: string;
  sources_cited?: CitedSource[];
  token_count?: number;
  time_to_result_ms?: number;
  mode?: OpponentMode;
  evaluation?: EvaluationResult;
  pipeline?: ApiPipelineResponse;
  notes?: string[];
  feedback?: SearchRunFeedback;
};

export type SearchRequest = {
  query: string;
  token_budget?: number;
  quality_mode?: QualityMode;
  synthesize_answer?: boolean;
  debug?: boolean;
};

export type ProviderOpponent = "openai" | "claude" | "gemini";

export type ProviderOpponentRequest = {
  provider: ProviderOpponent;
  query: string;
};

export type SearchFormValues = {
  query: string;
  tokenBudget: number;
  qualityMode: QualityMode;
  synthesizeAnswer: boolean;
};

export type CompareApiPayload =
  | ApiPipelineResponse
  | ApiCompareResult
  | ApiCompareResult[]
  | {
      result?: ApiCompareResult;
      results?: ApiCompareResult[];
      items?: ApiCompareResult[];
      pipeline?: ApiPipelineResponse;
      comparison?: ApiCompareResult[];
      final_answer?: string;
      engine_name?: string;
      question_id?: string;
      evaluation?: EvaluationResult;
    };
