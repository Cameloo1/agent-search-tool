import type { FastifyInstance } from "fastify";
import { getEnv } from "../env.js";

type ProviderName = "openai" | "claude" | "gemini";

interface ProviderAnswer {
  finalAnswer: string;
  sources: Array<{
    url?: string;
    title?: string | null;
    source_name?: string;
    provenance: "primary" | "secondary" | "tertiary" | "forum/opinion" | "unknown";
  }>;
}

function parseProviderSearchRequest(body: unknown):
  | { ok: true; provider: ProviderName; query: string }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be an object." };
  const provider = body.provider;
  const query = body.query;
  if (provider !== "openai" && provider !== "claude" && provider !== "gemini") {
    return { ok: false, error: "provider must be one of: openai, claude, gemini." };
  }
  if (typeof query !== "string" || !query.trim()) {
    return { ok: false, error: "query is required." };
  }
  return { ok: true, provider, query: query.trim() };
}

export async function registerOpponentRoutes(app: FastifyInstance) {
  app.post("/opponents/provider-search", async (request, reply) => {
    const parsed = parseProviderSearchRequest(request.body);
    if (!parsed.ok) {
      return reply.status(400).send({ ok: false, error: parsed.error });
    }

    const started = Date.now();
    const env = getEnv();
    const provider = parsed.provider;
    const missing = missingProviderReason(provider, env);
    if (missing) {
      return providerResult({
        provider,
        query: parsed.query,
        finalAnswer: "",
        sources: [],
        mode: "missing",
        elapsedMs: Date.now() - started,
        notes: [missing]
      });
    }

    try {
      const answer = await runProviderSearch(provider, parsed.query, env);
      return providerResult({
        provider,
        query: parsed.query,
        finalAnswer: answer.finalAnswer,
        sources: answer.sources,
        mode: "live",
        elapsedMs: Date.now() - started,
        notes: ["Live provider web-search opponent. This result did not use the Agent Search pipeline."]
      });
    } catch (error) {
      return providerResult({
        provider,
        query: parsed.query,
        finalAnswer: "",
        sources: [],
        mode: "missing",
        elapsedMs: Date.now() - started,
        notes: [`${providerLabel(provider)} web-search opponent failed: ${error instanceof Error ? error.message : String(error)}`]
      });
    }
  });
}

async function runProviderSearch(provider: ProviderName, query: string, env: ReturnType<typeof getEnv>): Promise<ProviderAnswer> {
  if (provider === "openai") {
    return runOpenAIWebSearch(query, env.openaiApiKey!, env.providerSearchOpenAIModel, env.llmTimeoutMs);
  }
  if (provider === "claude") {
    return runClaudeWebSearch(query, env.anthropicApiKey!, env.providerSearchClaudeModel, env.llmTimeoutMs);
  }
  return runGeminiWebSearch(query, env.geminiApiKey!, env.providerSearchGeminiModel, env.llmTimeoutMs);
}

async function runOpenAIWebSearch(query: string, apiKey: string, model: string, timeoutMs: number): Promise<ProviderAnswer> {
  const payload = await fetchJson(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: query,
        tools: [{ type: "web_search_preview" }]
      })
    },
    timeoutMs,
    "OpenAI web search"
  );
  const finalAnswer = extractOpenAIResponseText(payload);
  return { finalAnswer, sources: extractUrlSources(payload, "OpenAI") };
}

async function runClaudeWebSearch(query: string, apiKey: string, model: string, timeoutMs: number): Promise<ProviderAnswer> {
  const payload = await fetchJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: query }]
      })
    },
    timeoutMs,
    "Claude web search"
  );
  const finalAnswer = extractAnthropicText(payload);
  return { finalAnswer, sources: extractUrlSources(payload, "Claude") };
}

async function runGeminiWebSearch(query: string, apiKey: string, model: string, timeoutMs: number): Promise<ProviderAnswer> {
  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ google_search: {} }]
      })
    },
    timeoutMs,
    "Gemini Google Search grounding"
  );
  const finalAnswer = extractGeminiText(payload);
  return { finalAnswer, sources: extractUrlSources(payload, "Gemini") };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function missingProviderReason(provider: ProviderName, env: ReturnType<typeof getEnv>): string | undefined {
  if (provider === "openai" && !env.openaiApiKey) return "OpenAI opponent unavailable: OPENAI_API_KEY is not configured.";
  if (provider === "claude" && !env.anthropicApiKey) return "Claude opponent unavailable: ANTHROPIC_API_KEY is not configured.";
  if (provider === "gemini" && !env.geminiApiKey) return "Gemini opponent unavailable: GEMINI_API_KEY is not configured.";
  return undefined;
}

function providerResult(input: {
  provider: ProviderName;
  query: string;
  finalAnswer: string;
  sources: ProviderAnswer["sources"];
  mode: "live" | "missing";
  elapsedMs: number;
  notes: string[];
}) {
  const engineName = `${providerLabel(input.provider)} Web Search`;
  const tokenCount = estimateTokens(input.finalAnswer);
  return {
    id: `${input.provider}-web-search-ad-hoc`,
    engine_name: engineName,
    question_id: "ad-hoc",
    final_answer: input.finalAnswer,
    sources_cited: input.sources,
    token_count: tokenCount,
    time_to_result_ms: input.elapsedMs,
    mode: input.mode,
    evaluation: {
      engine_name: engineName,
      question_id: "ad-hoc",
      score_status: "scoring_unavailable",
      facts_hit: 0,
      facts_total: 0,
      required_source_types_hit: 0,
      required_source_types_total: 0,
      primary_source_count: 0,
      hallucination_flags: [],
      unsourced_claims: [],
      token_count: tokenCount,
      time_to_result_ms: input.elapsedMs,
      notes: input.notes
    },
    notes: input.notes
  };
}

function extractOpenAIResponseText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") return payload.output_text;
  return findText(payload).join("\n\n").trim();
}

function extractAnthropicText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return findText(payload).join("\n\n").trim();
  return payload.content
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

function extractGeminiText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return findText(payload).join("\n\n").trim();
  return payload.candidates
    .flatMap((candidate) => {
      if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return [];
      return candidate.content.parts.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []));
    })
    .join("\n\n")
    .trim();
}

function extractUrlSources(payload: unknown, sourceName: string): ProviderAnswer["sources"] {
  const seen = new Set<string>();
  const sources: ProviderAnswer["sources"] = [];
  visit(payload, (value) => {
    if (!isRecord(value)) return;
    const url = stringField(value, ["url", "uri"]);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    sources.push({
      url,
      title: stringField(value, ["title", "name"]) ?? url,
      source_name: sourceName,
      provenance: "unknown"
    });
  });
  return sources.slice(0, 12);
}

function findText(value: unknown): string[] {
  const texts: string[] = [];
  visit(value, (entry) => {
    if (isRecord(entry) && typeof entry.text === "string" && entry.text.length > 40) {
      texts.push(entry.text);
    }
  });
  return [...new Set(texts)].slice(0, 4);
}

function visit(value: unknown, callback: (value: unknown) => void): void {
  callback(value);
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, callback));
  } else if (isRecord(value)) {
    Object.values(value).forEach((item) => visit(item, callback));
  }
}

function stringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const direct = value[field];
    if (typeof direct === "string") return direct;
  }
  return undefined;
}

function providerLabel(provider: ProviderName): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "claude") return "Claude";
  return "Gemini";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.33);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
