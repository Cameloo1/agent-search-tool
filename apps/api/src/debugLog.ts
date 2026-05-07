import type { NormalizedChunk, PipelineProgressEvent, PipelineRequest, PipelineResponse } from "@agent-search/shared";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SEARCH_RUN_FEEDBACK_RATINGS = ["up", "neutral", "down"] as const;
const FEEDBACK_NOTE_MAX_CHARS = 2_000;

export type SearchRunFeedbackRating = (typeof SEARCH_RUN_FEEDBACK_RATINGS)[number];

export interface SearchRunFeedback {
  rating: SearchRunFeedbackRating;
  note?: string;
  updated_at: string;
}

export interface SearchDebugLogEntry {
  status: "ok" | "error";
  written_at: string;
  feedback?: SearchRunFeedback;
  request: {
    query: string;
    token_budget?: number;
    quality_mode?: string;
    synthesize_answer?: boolean;
    debug?: boolean;
    chat_history_count: number;
    memory_snippet_chars: number;
  };
  events: PipelineProgressEvent[];
  response?: {
    request_id: string;
    intent: PipelineResponse["intent"];
    sub_queries_executed: PipelineResponse["sub_queries_executed"];
    synthesized_answer?: string;
    synthesis_review?: PipelineResponse["synthesis_review"];
    adjudication?: PipelineResponse["adjudication"];
    evidence_health: PipelineResponse["evidence_health"];
    retrieval_rounds: PipelineResponse["trace"]["retrieval_rounds"];
    gap_analysis: PipelineResponse["trace"]["gap_analysis"];
    counts: PipelineResponse["trace"]["counts"];
    source_results: PipelineResponse["trace"]["source_results"];
    stage_timings_ms: PipelineResponse["trace"]["stage_timings_ms"];
    trace: PipelineResponse["trace"];
    cost_summary?: PipelineResponse["trace"]["cost_summary"];
    trace_summary: {
      sources_queried: string[];
      source_failures: Array<{ source: string; code: string; message: string }>;
      raw_item_count: number;
      normalized_chunk_count: number;
      scored_chunk_count: number;
      deduped_chunk_count: number;
      selected_chunk_count: number;
      estimated_tokens_used: number;
    };
    warnings: string[];
    errors: PipelineResponse["trace"]["errors"];
    selected_chunk_ids: string[];
    rejected_chunk_ids: string[];
    selected_chunks: SanitizedChunk[];
    rejected_chunks: SanitizedChunk[];
    selected_sources: Array<{
      id: string;
      source_name: string;
      source_type: string;
      title: string | null;
      url: string;
      confidence_score: number;
      relevance_to_query?: number;
      provenance: string;
    }>;
    ui_metrics: {
      token_count: number;
      time_to_result_ms: number;
      evidence_quality?: number;
      evidence_coverage?: number;
      evidence_status?: string;
      score_status?: string;
      hallucination_flags: string[];
    };
  };
  error?: string;
}

export type SanitizedChunk = Omit<NormalizedChunk, "_internal" | "content"> & {
  content: string;
  _internal: Omit<NormalizedChunk["_internal"], "embedding">;
};

export async function writeSearchDebugLog(input: {
  request: PipelineRequest;
  response?: PipelineResponse;
  events?: PipelineProgressEvent[];
  error?: unknown;
}): Promise<void> {
  const entry = buildEntry(input);
  const directory = resolveDebugRunsDirectory();
  await mkdir(directory, { recursive: true });
  const stableId = input.response?.trace.request_id ?? sanitizeForFileName(new Date().toISOString());
  const content = `${JSON.stringify(entry, null, 2)}\n`;
  await Promise.all([
    writeFile(resolve(directory, `${stableId}.json`), content, "utf8"),
    writeFile(resolve(directory, "latest.json"), content, "utf8")
  ]);
}

export async function readLatestSearchDebugLog(): Promise<SearchDebugLogEntry | undefined> {
  const latest = resolve(resolveDebugRunsDirectory(), "latest.json");
  try {
    return JSON.parse(await readFile(latest, "utf8")) as SearchDebugLogEntry;
  } catch {
    return undefined;
  }
}

export async function readSearchDebugLog(requestId: string): Promise<SearchDebugLogEntry | undefined> {
  const path = resolve(resolveDebugRunsDirectory(), `${sanitizeForFileName(requestId)}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as SearchDebugLogEntry;
  } catch {
    return undefined;
  }
}

export async function readSearchDebugLogList(limit = 12): Promise<SearchDebugLogEntry[]> {
  const directory = resolveDebugRunsDirectory();
  try {
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".json") && file !== "latest.json")
      .map((file) => resolve(directory, file));
    const newest = await Promise.all(
      files.map(async (path) => ({
        path,
        mtimeMs: (await stat(path)).mtimeMs
      }))
    );

    const records = await Promise.all(
      newest
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
        .map(async (item) => JSON.parse(await readFile(item.path, "utf8")) as SearchDebugLogEntry)
    );

    return records.filter((record) => record.status === "ok" && Boolean(record.response));
  } catch {
    return [];
  }
}

export async function writeSearchDebugFeedback(input: {
  requestId: string;
  rating: SearchRunFeedbackRating;
  note?: string;
}): Promise<SearchRunFeedback | undefined> {
  const stableId = sanitizeForFileName(input.requestId);
  const path = resolve(resolveDebugRunsDirectory(), `${stableId}.json`);
  let entry: SearchDebugLogEntry;

  try {
    entry = JSON.parse(await readFile(path, "utf8")) as SearchDebugLogEntry;
  } catch {
    return undefined;
  }

  const feedback: SearchRunFeedback = {
    rating: input.rating,
    updated_at: new Date().toISOString()
  };
  const note = normalizeFeedbackNote(input.note);
  if (note) {
    feedback.note = note;
  }

  await writeDebugEntry(path, { ...entry, feedback });
  await updateLatestFeedback(stableId, feedback);
  return feedback;
}

export function isSearchRunFeedbackRating(value: unknown): value is SearchRunFeedbackRating {
  return SEARCH_RUN_FEEDBACK_RATINGS.includes(value as SearchRunFeedbackRating);
}

function buildEntry(input: {
  request: PipelineRequest;
  response?: PipelineResponse;
  events?: PipelineProgressEvent[];
  error?: unknown;
}): SearchDebugLogEntry {
  return {
    status: input.error ? "error" : "ok",
    written_at: new Date().toISOString(),
    request: {
      query: input.request.query,
      token_budget: input.request.token_budget,
      quality_mode: input.request.quality_mode,
      synthesize_answer: input.request.synthesize_answer,
      debug: input.request.debug,
      chat_history_count: input.request.chat_history?.length ?? 0,
      memory_snippet_chars: input.request.memory_snippet?.length ?? 0
    },
    events: sanitizeEvents(input.events ?? []),
    response: input.response ? summarizeResponse(input.response) : undefined,
    error: input.error ? (input.error instanceof Error ? input.error.message : String(input.error)) : undefined
  };
}

function summarizeResponse(response: PipelineResponse): NonNullable<SearchDebugLogEntry["response"]> {
  return {
    request_id: response.trace.request_id,
    intent: response.intent,
    sub_queries_executed: response.sub_queries_executed,
    synthesized_answer: response.synthesized_answer,
    synthesis_review: response.synthesis_review ?? response.trace.synthesis_review,
    adjudication: response.adjudication,
    evidence_health: response.evidence_health,
    retrieval_rounds: response.trace.retrieval_rounds,
    gap_analysis: response.trace.gap_analysis,
    counts: response.trace.counts,
    source_results: response.trace.source_results,
    stage_timings_ms: response.trace.stage_timings_ms,
    trace: response.trace,
    cost_summary: response.trace.cost_summary,
    trace_summary: summarizeTrace(response),
    warnings: response.trace.warnings,
    errors: response.trace.errors,
    selected_chunk_ids: response.trace.selection.selected_chunk_ids,
    rejected_chunk_ids: response.trace.selection.rejected_chunk_ids,
    selected_chunks: response.chunks.map(sanitizeChunk),
    rejected_chunks: [],
    selected_sources: response.chunks.map((chunk) => ({
      id: chunk.id,
      source_name: chunk.metadata.source_name,
      source_type: chunk.metadata.source_type,
      title: chunk.metadata.title,
      url: chunk.metadata.url,
      confidence_score: chunk.metadata.confidence_score,
      relevance_to_query: chunk._internal?.relevance_to_query,
      provenance: provenanceForStance(chunk.metadata.epistemic_stance)
    })),
    ui_metrics: {
      token_count: response.trace.selection.estimated_tokens_used,
      time_to_result_ms: durationFromTrace(response),
      evidence_quality: response.evidence_health?.evidence_quality_score,
      evidence_coverage: response.evidence_health?.evidence_coverage_score,
      evidence_status: response.evidence_health?.status,
      score_status: response.adjudication?.score_status,
      hallucination_flags: response.adjudication?.hallucination_flags ?? response.synthesis_review?.unsupported_or_weak_claims ?? []
    }
  };
}

function sanitizeEvents(events: PipelineProgressEvent[]): PipelineProgressEvent[] {
  return events.map((event) => {
    if (event.type !== "final") return event;
    return {
      ...event,
      response: {
        ...event.response,
        chunks: event.response.chunks.map(sanitizeChunk) as any
      }
    };
  });
}

function sanitizeChunk(chunk: NormalizedChunk): SanitizedChunk {
  return {
    id: chunk.id,
    content: truncate(chunk.content, 2_500),
    metadata: {
      ...chunk.metadata,
      claim_graph: chunk.metadata.claim_graph.slice(0, 20)
    },
    _internal: {
      relevance_to_query: chunk._internal.relevance_to_query,
      source_weight: chunk._internal.source_weight,
      freshness_fitness: chunk._internal.freshness_fitness
    }
  };
}

function summarizeTrace(response: PipelineResponse): NonNullable<SearchDebugLogEntry["response"]>["trace_summary"] {
  const failures = Object.entries(response.trace.source_results ?? {}).flatMap(([source, result]) =>
    (result.errors ?? []).map((error) => ({ source, code: error.code, message: error.message }))
  );
  return {
    sources_queried: Object.keys(response.trace.source_results ?? {}),
    source_failures: failures,
    raw_item_count: response.trace.counts.raw_items,
    normalized_chunk_count: response.trace.counts.normalized_chunks,
    scored_chunk_count: response.trace.counts.scored_chunks,
    deduped_chunk_count: response.trace.counts.deduped_chunks,
    selected_chunk_count: response.trace.counts.selected_chunks,
    estimated_tokens_used: response.trace.selection.estimated_tokens_used
  };
}

function durationFromTrace(response: PipelineResponse): number {
  const started = Date.parse(response.trace.started_at);
  const finished = Date.parse(response.trace.finished_at);
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) return finished - started;
  return Math.round(Object.values(response.trace.stage_timings_ms ?? {}).reduce((sum, value) => sum + value, 0));
}

function provenanceForStance(stance: string): string {
  if (stance === "primary_source") return "primary";
  if (stance === "secondary_analysis") return "secondary";
  if (stance === "tertiary_summary") return "tertiary";
  if (stance === "opinion" || stance === "speculation") return "forum/opinion";
  return "unknown";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15).trimEnd()} [truncated]`;
}

async function updateLatestFeedback(stableId: string, feedback: SearchRunFeedback): Promise<void> {
  const latestPath = resolve(resolveDebugRunsDirectory(), "latest.json");
  let latest: SearchDebugLogEntry;

  try {
    latest = JSON.parse(await readFile(latestPath, "utf8")) as SearchDebugLogEntry;
  } catch {
    return;
  }

  const latestStableId = latest.response?.request_id ? sanitizeForFileName(latest.response.request_id) : undefined;
  if (latestStableId !== stableId) {
    return;
  }

  await writeDebugEntry(latestPath, { ...latest, feedback });
}

async function writeDebugEntry(path: string, entry: SearchDebugLogEntry): Promise<void> {
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

function normalizeFeedbackNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= FEEDBACK_NOTE_MAX_CHARS ? trimmed : trimmed.slice(0, FEEDBACK_NOTE_MAX_CHARS);
}

function resolveDebugRunsDirectory(): string {
  const configured = process.env.SEARCH_DEBUG_RUNS_DIR?.trim();
  return configured ? resolve(configured) : resolveWorkspacePath("data/debug-runs");
}

function resolveWorkspacePath(relativePath: string): string {
  let directory = process.cwd();
  while (true) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
      return resolve(directory, relativePath);
    }
    const parent = dirname(directory);
    if (parent === directory) return resolve(process.cwd(), relativePath);
    directory = parent;
  }
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, "_");
}
