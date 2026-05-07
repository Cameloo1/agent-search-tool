import {
  DEFAULTS,
  FetchOptionsSchema,
  SourceFetchResultSchema,
  type FetchOptions,
  type PipelineProgressEvent,
  type RawItem,
  type SourceFetchResult,
  type SourceName,
  type SubQuery
} from "@agent-search/shared";
import { sourceRegistry, type SourceHandler } from "@agent-search/sources";

export interface RouterOptions {
  sourceTimeoutMs?: number;
  maxConcurrency?: number;
  apiKeys?: FetchOptions["apiKeys"];
  secUserAgent?: string;
  handlers?: Partial<Record<string, SourceHandler>>;
  abortSignal?: AbortSignal;
  onProgress?: (event: PipelineProgressEvent) => void | Promise<void>;
}

export interface RouterResult {
  rawItems: RawItem[];
  fetchResults: SourceFetchResult[];
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number, signal?: AbortSignal): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      throwIfAborted(signal);
      const index = next++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function routeSources(subQueries: SubQuery[], options: RouterOptions = {}): Promise<RouterResult> {
  const handlers: Partial<Record<string, SourceHandler>> = options.handlers ?? sourceRegistry;
  const tasks: Array<() => Promise<SourceFetchResult>> = [];

  for (const subQuery of subQueries) {
    for (const source of subQuery.target_sources) {
      const handler = handlers[source];
      if (!handler) {
        tasks.push(async () => ({
          source,
          ok: false,
          items: [],
          error: {
            code: "SOURCE_HANDLER_MISSING",
            message: `No handler registered for ${source}`,
            retryable: false,
            category: "missing_config"
          },
          timing_ms: 0
        }));
        continue;
      }

      const fetchOptions = FetchOptionsSchema.parse({
        timeoutMs: options.sourceTimeoutMs ?? DEFAULTS.sourceTimeoutMs,
        maxResults: subQuery.max_results,
        apiKeys: options.apiKeys,
        secUserAgent: options.secUserAgent,
        signal: options.abortSignal
      });
      tasks.push(async () => {
        await emit(options.onProgress, {
          type: "source_start",
          stage: "stage3_4_router_fetch",
          source,
          sub_query: subQuery.sub_query,
          at: new Date().toISOString()
        });
        try {
          throwIfAborted(options.abortSignal);
          const result = await handler.fetch(subQuery, fetchOptions);
          const normalized = normalizeFetchResult(source, result);
          await emit(options.onProgress, {
            type: "source_complete",
            stage: "stage3_4_router_fetch",
            source,
            ok: normalized.ok,
            item_count: normalized.items.length,
            timing_ms: normalized.timing_ms,
            at: new Date().toISOString(),
            error: normalized.error ?? undefined
          });
          return normalized;
        } catch (error) {
          const normalized: SourceFetchResult = {
            source,
            ok: false,
            items: [],
            error: {
              code: isAbortError(error) ? "SOURCE_FETCH_ABORTED" : "SOURCE_FETCH_EXCEPTION",
              message: error instanceof Error ? error.message : String(error),
              retryable: !isAbortError(error),
              category: isAbortError(error) ? "timeout" : "unknown"
            },
            timing_ms: 0
          };
          await emit(options.onProgress, {
            type: "source_complete",
            stage: "stage3_4_router_fetch",
            source,
            ok: false,
            item_count: 0,
            timing_ms: 0,
            at: new Date().toISOString(),
            error: normalized.error
          });
          return normalized;
        }
      });
    }
  }

  const fetchResults = await runWithConcurrency(tasks, options.maxConcurrency ?? DEFAULTS.maxConcurrency, options.abortSignal);
  return {
    fetchResults,
    rawItems: fetchResults.flatMap((result) => (result.ok ? result.items : []))
  };
}

async function emit(
  onProgress: RouterOptions["onProgress"],
  event: PipelineProgressEvent
): Promise<void> {
  if (onProgress) await onProgress(event);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Operation aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function normalizeFetchResult(source: SourceName, result: unknown): SourceFetchResult {
  const parsed = SourceFetchResultSchema.safeParse(result);
  if (parsed.success) {
    return parsed.data;
  }

  if (result && typeof result === "object") {
    const record = result as Record<string, any>;
    const error = record.error && typeof record.error === "object" ? record.error : {};
    const candidate = {
      source,
      ok: false,
      items: [],
      error: {
        code: String(error.code ?? "SOURCE_RESULT_INVALID"),
        message: String(error.message ?? parsed.error.message),
        retryable: Boolean(error.retryable),
        category: isSourceErrorCategory(error.category) ? error.category : "unknown"
      },
      timing_ms: typeof record.timing_ms === "number" && Number.isFinite(record.timing_ms) ? record.timing_ms : 0
    };
    return SourceFetchResultSchema.parse(candidate);
  }

  return {
    source,
    ok: false,
    items: [],
    error: {
      code: "SOURCE_RESULT_INVALID",
      message: parsed.error.message,
      retryable: false,
      category: "unknown"
    },
    timing_ms: 0
  };
}

function isSourceErrorCategory(value: unknown): value is NonNullable<SourceFetchResult["error"]>["category"] {
  return ["unavailable", "rate_limited", "query_invalid", "missing_config", "timeout", "unknown"].includes(String(value));
}

export function summarizeSourceResults(results: SourceFetchResult[]) {
  return results.reduce<Record<string, { queried: number; ok: number; failed: number; timing_ms: number; errors: NonNullable<SourceFetchResult["error"]>[] }>>(
    (acc, result) => {
      const current = acc[result.source] ?? { queried: 0, ok: 0, failed: 0, timing_ms: 0, errors: [] };
      current.queried += 1;
      current.ok += result.ok ? 1 : 0;
      current.failed += result.ok ? 0 : 1;
      current.timing_ms += result.timing_ms;
      if (!result.ok && result.error) current.errors.push(result.error);
      acc[result.source] = current;
      return acc;
    },
    {}
  );
}
