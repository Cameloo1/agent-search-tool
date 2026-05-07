import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

const RATE_LIMIT_RETRY_INTERVAL_MS = 2_000;
const RATE_LIMIT_RETRY_BUDGET_MS = 12_000;

interface SemanticScholarResponse {
  data?: Array<{
    paperId: string;
    title?: string;
    abstract?: string;
    url?: string;
    year?: number;
    publicationDate?: string;
    authors?: Array<{ name?: string }>;
  }>;
}

export const semanticScholarHandler: SourceHandler = {
  name: "semantic_scholar",
  async fetch(subQuery, options) {
    return safeSourceFetch("semantic_scholar", async () => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "agent-search-tool/0.1"
      };
      if (options.apiKeys?.semanticScholar) headers["x-api-key"] = options.apiKeys.semanticScholar;
      const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
        subQuery.sub_query
      )}&limit=${options.maxResults}&fields=title,abstract,url,authors,year,publicationDate`;
      const { data, rateLimitRetryCount } = await fetchWithRateLimitRetry(url, options.timeoutMs, {
        headers,
        signal: options.signal
      });
      return clampResults(data.data ?? [], options.maxResults).map<RawItem>((paper) => ({
        id: itemId("semantic_scholar", paper.paperId),
        source: "semantic_scholar",
        source_type: "academic",
        url: paper.url ?? `https://www.semanticscholar.org/paper/${paper.paperId}`,
        title: paper.title ?? null,
        author: paper.authors?.map((a) => a.name).filter(Boolean).join(", ") || null,
        publish_date: toIsoDate(paper.publicationDate ?? (paper.year ? `${paper.year}-01-01` : undefined)),
        text: [paper.title, paper.abstract].filter(Boolean).join("\n\n"),
        summary: paper.abstract ?? null,
        metadata: {
          paper_id: paper.paperId,
          year: paper.year,
          api_key_configured: Boolean(options.apiKeys?.semanticScholar),
          rate_limit_retry_count: rateLimitRetryCount
        }
      }));
    });
  }
};

async function fetchWithRateLimitRetry(
  url: string,
  timeoutMs: number,
  init: RequestInit
): Promise<{ data: SemanticScholarResponse; rateLimitRetryCount: number }> {
  const startedAt = Date.now();
  let rateLimitRetryCount = 0;
  let lastRateLimitError: unknown;

  while (true) {
    throwIfAborted(init.signal);
    const elapsedMs = Date.now() - startedAt;
    if (rateLimitRetryCount > 0 && elapsedMs >= RATE_LIMIT_RETRY_BUDGET_MS) {
      throw lastRateLimitError;
    }

    const remainingBudgetMs = RATE_LIMIT_RETRY_BUDGET_MS - elapsedMs;
    const attemptTimeoutMs =
      rateLimitRetryCount > 0 ? Math.max(500, Math.min(timeoutMs, remainingBudgetMs)) : timeoutMs;

    try {
      return {
        data: await fetchJson<SemanticScholarResponse>(url, attemptTimeoutMs, init),
        rateLimitRetryCount
      };
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      lastRateLimitError = error;
      rateLimitRetryCount += 1;

      const remainingAfterErrorMs = RATE_LIMIT_RETRY_BUDGET_MS - (Date.now() - startedAt);
      if (remainingAfterErrorMs <= 0) throw error;
      await sleep(Math.min(RATE_LIMIT_RETRY_INTERVAL_MS, remainingAfterErrorMs), init.signal);
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record?.code === "string" ? record.code : "";
  const message = typeof record?.message === "string" ? record.message : "";
  return code === "HTTP_429" || /rate limit|too many requests/i.test(message);
}

function sleep(ms: number, signal: RequestInit["signal"]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: RequestInit["signal"]): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: RequestInit["signal"]): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Semantic Scholar request aborted."), { name: "AbortError" });
}
