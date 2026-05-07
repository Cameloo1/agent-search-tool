import type { RawItem, SourceError, SourceErrorCategory, SourceFetchResult, SourceName } from "@agent-search/shared";

export function stripHtml(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function toIsoDate(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function sourceError(code: unknown, message: string, retryable = false, category = classifySourceError(code, message)): SourceError {
  return { code: normalizeErrorCode(code), message, retryable, category };
}

export function disabledResult(source: SourceName, code: unknown, message: string): SourceFetchResult {
  return {
    source,
    ok: false,
    items: [],
    error: sourceError(code, message, false),
    timing_ms: 0
  };
}

export async function fetchJson<T>(url: string, timeoutMs: number, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) controller.abort(init.signal.reason);
  if (init.signal) init.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw Object.assign(new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`), {
        code: `HTTP_${response.status}`,
        retryable
      });
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onAbort);
  }
}

export async function fetchText(url: string, timeoutMs: number, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) controller.abort(init.signal.reason);
  if (init.signal) init.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw Object.assign(new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`), {
        code: `HTTP_${response.status}`,
        retryable
      });
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onAbort);
  }
}

export async function safeSourceFetch(
  source: SourceName,
  work: () => Promise<RawItem[]>
): Promise<SourceFetchResult> {
  const started = Date.now();
  try {
    const items = await work();
    return {
      source,
      ok: true,
      items,
      error: null,
      timing_ms: Date.now() - started
    };
  } catch (error) {
    const anyError = error as Error & { code?: string; retryable?: boolean; name?: string };
    const retryable = anyError.retryable ?? anyError.name === "AbortError";
    return {
      source,
      ok: false,
      items: [],
      error: sourceError(anyError.code ?? anyError.name ?? "SOURCE_FETCH_ERROR", anyError.message, retryable),
      timing_ms: Date.now() - started
    };
  }
}

export function classifySourceError(code: unknown, message = ""): SourceErrorCategory {
  const normalized = normalizeErrorCode(code).toUpperCase();
  const combined = `${normalized} ${message}`.toUpperCase();
  if (normalized.includes("MISSING") || normalized.includes("DISABLED") || combined.includes("API KEY") || combined.includes("USER_AGENT")) {
    return "missing_config";
  }
  if (normalized === "HTTP_429" || combined.includes("RATE LIMIT")) {
    return "rate_limited";
  }
  if (normalized === "HTTP_422" || normalized.includes("VALIDATION") || combined.includes("LONGER THAN 256")) {
    return "query_invalid";
  }
  if (normalized.includes("TIMEOUT") || normalized.includes("ABORT") || combined.includes("TIMED OUT")) {
    return "timeout";
  }
  if (normalized === "HTTP_403" || normalized === "HTTP_404" || normalized.includes("UNAVAILABLE")) {
    return "unavailable";
  }
  return "unknown";
}

function normalizeErrorCode(code: unknown): string {
  if (typeof code === "string" && code.trim()) return code;
  if (typeof code === "number" && Number.isFinite(code)) return `HTTP_${Math.trunc(code)}`;
  if (code instanceof Error) return code.name || "SOURCE_FETCH_ERROR";
  if (code && typeof code === "object") {
    const record = code as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) return record.code;
    if (typeof record.name === "string" && record.name.trim()) return record.name;
  }
  return "SOURCE_FETCH_ERROR";
}

export function itemId(source: SourceName, stable: string): string {
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${source}:${(hash >>> 0).toString(36)}`;
}

export function clampResults<T>(items: T[], maxResults: number): T[] {
  return items.slice(0, Math.max(0, maxResults));
}
