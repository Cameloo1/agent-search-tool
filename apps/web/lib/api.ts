import type {
  ApiNormalizedChunk,
  ApiCompareResult,
  ApiPipelineResponse,
  CitedSource,
  CompareApiPayload,
  CompareResult,
  EvaluationResult,
  PipelineProgressEvent,
  ProviderOpponentRequest,
  ProvenanceLabel,
  SearchDebugRecord,
  SearchRunFeedback,
  SearchRunFeedbackInput,
  SearchRequest,
  Trace
} from "./types";

const DEFAULT_API_BASE_URL = "http://localhost:3001";
const BENCHMARK_QUESTIONS: Array<{ id: string; question: string }> = [
  {
    id: "Q1",
    question:
      "What\u2019s gonna happen if we keep spending more and more money on debt? How can we approach fixing this, and how is AI poised to help exactly? What is it currently doing that\u2019s pushing us towards this?"
  },
  {
    id: "Q2",
    question:
      "How to use [LLM like GPT-5.5] for appsec and pre-production testing the correct way? Why exactly are most vibecode projects unsecure and unoptimized? What can I do to close this gap?"
  },
  {
    id: "Q3",
    question:
      "I want to learn more about retail and institution activity during market downturns, and how each one influenced geopolitical events and markets after, years to come. All notable market downturns, categorize by 1900s and 2000s to present. What are the most impactful events, and how are they still affecting debt, inflation, and economy sentiment / confidence to this present day?"
  },
  {
    id: "Q4",
    question:
      "To match and beat top traders, I want to learn about how institutions and banks get news updates fast and quick to gain a competitive edge over other traders in markets? I\u2019d like to know about their strategies and infrastructure so that I can research more about this."
  },
  {
    id: "Q5",
    question:
      "How can I build an advanced data pipeline that first identifies domain-specific duplicates using information-theoretic and learned similarity measures, then optimizes the assembly of those deduplicated chunks by treating information coverage as a submodular optimization problem within a token budget, and finally incorporates a dynamic Bayesian reliability layer to weight those sources based on their historical agreement or disagreement with the consensus?"
  }
];

const BENCHMARK_QUESTION_ID_BY_CANONICAL_QUERY = new Map(
  BENCHMARK_QUESTIONS.map((question) => [canonicalBenchmarkText(question.question), question.id])
);

export function getApiBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return (configured || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export async function search(request: SearchRequest): Promise<CompareApiPayload> {
  const response = await fetch(`${getApiBaseUrl()}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Search failed with HTTP ${response.status}`);
  }

  return (await response.json()) as CompareApiPayload;
}

export async function providerOpponentSearch(request: ProviderOpponentRequest): Promise<ApiCompareResult> {
  const response = await fetch(`${getApiBaseUrl()}/opponents/provider-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Provider opponent failed with HTTP ${response.status}`);
  }

  return (await response.json()) as ApiCompareResult;
}

export async function searchStream(
  request: SearchRequest,
  onEvent: (event: PipelineProgressEvent) => void,
  signal?: AbortSignal
): Promise<CompareApiPayload> {
  const response = await fetch(`${getApiBaseUrl()}/search/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request),
    signal
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Search stream failed with HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Search stream response body was unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: CompareApiPayload | undefined;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const parts = buffer.split(/\n\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const event = parseStreamEvent(part);
      if (!event) continue;
      onEvent(event);
      if (event.type === "final") {
        finalPayload = event.response;
      }
      if (event.type === "fatal") {
        throw new Error(event.error);
      }
    }

    if (done) break;
  }

  if (finalPayload) {
    return finalPayload;
  }

  throw new Error("Search stream ended before a final response was received.");
}

export async function fetchSearchDebug(requestId?: string): Promise<SearchDebugRecord> {
  const path = requestId ? `/debug/search/${encodeURIComponent(requestId)}` : "/debug/search/latest";
  const response = await fetch(`${getApiBaseUrl()}${path}`, { cache: "no-store" });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Debug log fetch failed with HTTP ${response.status}`);
  }
  return (await response.json()) as SearchDebugRecord;
}

export async function fetchSearchDebugRuns(limit = 12): Promise<SearchDebugRecord[]> {
  const response = await fetch(`${getApiBaseUrl()}/debug/search?limit=${encodeURIComponent(String(limit))}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Debug run list fetch failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { runs?: SearchDebugRecord[] };
  return Array.isArray(payload.runs) ? payload.runs : [];
}

export async function submitRunFeedback(
  requestId: string,
  feedback: SearchRunFeedbackInput
): Promise<SearchRunFeedback> {
  const response = await fetch(`${getApiBaseUrl()}/debug/search/${encodeURIComponent(requestId)}/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(feedback)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message || `Feedback failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { feedback?: SearchRunFeedback };
  if (!payload.feedback) {
    throw new Error("Feedback response did not include a saved review.");
  }
  return payload.feedback;
}

export function normalizeComparePayload(payload: CompareApiPayload, query: string): CompareResult[] {
  if (Array.isArray(payload)) {
    return payload.map((item, index) => normalizeCompareResult(item, query, index));
  }

  if (isObject(payload)) {
    const objectPayload = payload as Record<string, any>;
    const nestedResults = objectPayload.results ?? objectPayload.items ?? objectPayload.comparison;
    if (Array.isArray(nestedResults)) {
      return nestedResults.map((item, index) => normalizeCompareResult(item, query, index));
    }

    if (objectPayload.result) {
      return [normalizeCompareResult(objectPayload.result, query, 0)];
    }

    if (objectPayload.pipeline) {
      return [
        pipelineToCompareResult(objectPayload.pipeline, {
          engineName: typeof objectPayload.engine_name === "string" ? objectPayload.engine_name : "Agent Search",
          finalAnswer:
            typeof objectPayload.final_answer === "string"
              ? objectPayload.final_answer
              : objectPayload.pipeline.synthesized_answer ?? objectPayload.pipeline.final_answer,
          evaluation: objectPayload.evaluation,
          query
        })
      ];
    }

    if (isPipelineResponse(payload)) {
      return [pipelineToCompareResult(payload, { query })];
    }

    if (looksLikeCompareResult(payload)) {
      return [normalizeCompareResult(payload, query, 0)];
    }
  }

  throw new Error("Backend returned an unsupported search response shape.");
}

export function createInitialResults(): CompareResult[] {
  return [
    createPlaceholderResult({
      id: "agent-search-placeholder",
      engineName: "Agent Search",
      mode: "missing",
      notes: ["Run a query to populate live pipeline chunks and trace details."]
    }),
    createPlaceholderResult({
      id: "opponent-placeholder",
      engineName: "Opponent",
      mode: "missing",
      notes: ["No imported or live opponent fixture has been loaded yet."]
    })
  ];
}

export function createLoadingResults(query: string): CompareResult[] {
  const questionId = questionIdFromQuery(query);
  return [
    createPlaceholderResult({
      id: `agent-search-loading-${questionId}`,
      engineName: "Agent Search",
      questionId,
      mode: "missing",
      finalAnswer: "Loading pipeline...",
      notes: ["Pipeline is running. Previous run data is hidden until this search completes."]
    }),
    createPlaceholderResult({
      id: `opponent-loading-${questionId}`,
      engineName: "Opponent",
      questionId,
      mode: "missing",
      finalAnswer: "Loading...",
      notes: ["Opponent data is hidden while the new Agent Search run is in progress."]
    })
  ];
}

export function ensureSideBySide(results: CompareResult[], query: string): CompareResult[] {
  if (results.length >= 2) {
    return results.slice(0, 2);
  }

  if (results.length === 1) {
    return [
      results[0],
      createPlaceholderResult({
        id: "opponent-missing",
        engineName: "Opponent",
        questionId: questionIdFromQuery(query),
        mode: "missing",
        notes: ["Opponent result unavailable for this query."]
      })
    ];
  }

  return createInitialResults();
}

export function createUnavailableEvaluation(
  engineName: string,
  questionId: string,
  tokenCount = 0,
  timeToResultMs = 0,
  notes: string[] = ["Scoring unavailable until validated gold answers are present."]
): EvaluationResult {
  return {
    engine_name: engineName,
    question_id: questionId,
    score_status: "scoring_unavailable",
    facts_hit: 0,
    facts_total: 0,
    required_source_types_hit: 0,
    required_source_types_total: 0,
    primary_source_count: 0,
    hallucination_flags: [],
    unsourced_claims: [],
    token_count: tokenCount,
    time_to_result_ms: timeToResultMs,
    notes
  };
}

function normalizeCompareResult(item: ApiCompareResult, query: string, index: number): CompareResult {
  const engineName = item.engine_name || (index === 0 ? "Agent Search" : "Opponent");
  const questionId = item.question_id || questionIdFromQuery(query);
  const tokenCount = numberOrZero(item.token_count);
  const timeToResultMs = numberOrZero(item.time_to_result_ms);
  const evaluation =
    item.evaluation ??
    createUnavailableEvaluation(engineName, questionId, tokenCount, timeToResultMs, [
      "Scoring unavailable: no validated gold result was returned."
    ]);

  return {
    ...item,
    id: item.id || `${slug(engineName)}-${questionId}-${index}`,
    engine_name: engineName,
    question_id: questionId,
    final_answer: item.final_answer || item.pipeline?.synthesized_answer || item.pipeline?.final_answer || "",
    sources_cited: Array.isArray(item.sources_cited) ? item.sources_cited : [],
    token_count: tokenCount || evaluation.token_count,
    time_to_result_ms: timeToResultMs || evaluation.time_to_result_ms,
    mode: item.mode || "missing",
    evaluation
  };
}

function pipelineToCompareResult(
  pipeline: ApiPipelineResponse,
  options: {
    query: string;
    engineName?: string;
    finalAnswer?: string;
    evaluation?: EvaluationResult;
  }
): CompareResult {
  const engineName = options.engineName || "Agent Search";
  const questionId = questionIdFromQuery(options.query);
  const tokenCount = pipeline.trace?.selection?.estimated_tokens_used ?? estimateTokensFromChunks(pipeline.chunks);
  const timeToResultMs = durationFromTrace(pipeline.trace);
  const evaluation =
    options.evaluation ??
    createUnavailableEvaluation(engineName, questionId, tokenCount, timeToResultMs, [
      "Scoring unavailable: this search response did not include validated gold scoring."
    ]);

  return {
    id: `${slug(engineName)}-${questionId}`,
    engine_name: engineName,
    question_id: questionId,
    final_answer: options.finalAnswer || pipeline.synthesized_answer || pipeline.final_answer || "",
    sources_cited: sourcesFromChunks(pipeline.chunks),
    token_count: tokenCount,
    time_to_result_ms: timeToResultMs,
    mode: "live",
    evaluation,
    pipeline,
    notes: evaluation.notes
  };
}

function createPlaceholderResult(options: {
  id: string;
  engineName: string;
  questionId?: string;
  mode: CompareResult["mode"];
  finalAnswer?: string;
  notes: string[];
}): CompareResult {
  const questionId = options.questionId || "ad-hoc";
  return {
    id: options.id,
    engine_name: options.engineName,
    question_id: questionId,
    final_answer: options.finalAnswer ?? "",
    sources_cited: [],
    token_count: 0,
    time_to_result_ms: 0,
    mode: options.mode,
    evaluation: createUnavailableEvaluation(options.engineName, questionId, 0, 0, options.notes),
    notes: options.notes
  };
}

function sourcesFromChunks(chunks: ApiNormalizedChunk[] = []): CitedSource[] {
  const seen = new Set<string>();
  return chunks.flatMap((chunk) => {
    const url = chunk.metadata?.url;
    if (!url || seen.has(url)) {
      return [];
    }
    seen.add(url);

    return [
      {
        url,
        title: chunk.metadata.title,
        source_name: chunk.metadata.source_name,
        source_type: chunk.metadata.source_type,
        confidence_score: chunk.metadata.confidence_score,
        provenance: provenanceFromStance(chunk.metadata.epistemic_stance)
      }
    ];
  });
}

function provenanceFromStance(stance: string | undefined): ProvenanceLabel {
  if (stance === "primary_source") {
    return "primary";
  }

  if (stance === "secondary_analysis") {
    return "secondary";
  }

  if (stance === "tertiary_summary") {
    return "tertiary";
  }

  if (stance === "opinion" || stance === "speculation") {
    return "forum/opinion";
  }

  return "unknown";
}

function estimateTokensFromChunks(chunks: ApiNormalizedChunk[] = []) {
  const words = chunks.reduce((total, chunk) => total + chunk.content.trim().split(/\s+/).filter(Boolean).length, 0);
  return Math.ceil(words * 1.33);
}

function durationFromTrace(trace?: Trace) {
  if (!trace) {
    return 0;
  }

  const started = Date.parse(trace.started_at);
  const finished = Date.parse(trace.finished_at);
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    return finished - started;
  }

  return Math.round(Object.values(trace.stage_timings_ms ?? {}).reduce((sum, value) => sum + value, 0));
}

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { message?: string; error?: string };
    return payload.message || payload.error || "";
  } catch {
    return response.statusText;
  }
}

function parseStreamEvent(block: string): PipelineProgressEvent | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) {
    return undefined;
  }

  try {
    return JSON.parse(dataLines.join("\n")) as PipelineProgressEvent;
  } catch {
    return undefined;
  }
}

function isPipelineResponse(value: unknown): value is ApiPipelineResponse {
  return isObject(value) && Array.isArray(value.chunks) && isObject(value.trace);
}

function looksLikeCompareResult(value: unknown): value is ApiCompareResult {
  return isObject(value) && ("engine_name" in value || "final_answer" in value || "sources_cited" in value);
}

export function questionIdFromQuery(query: string) {
  return BENCHMARK_QUESTION_ID_BY_CANONICAL_QUERY.get(canonicalBenchmarkText(query)) ?? "ad-hoc";
}

export function canonicalBenchmarkText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
