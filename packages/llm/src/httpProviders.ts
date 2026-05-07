import type { LLMProvider, LLMProviderResponse, StructuredLLMInput, TokenUsage } from "@agent-search/shared";
import { createLLMProvider } from "./provider.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  reasoningEnabled?: boolean;
  appName?: string;
  siteUrl?: string;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): LLMProvider {
  return {
    ...createLLMProvider("openai", async (input) => {
    const response = await fetch(`${options.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model ?? options.model,
        input: [
          {
            role: "system",
            content: "Return only valid JSON for the requested schema. Do not include prose or markdown."
          },
          { role: "user", content: input.prompt }
        ],
        text: { format: { type: "json_object" } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      output: extractOpenAIText(payload),
      metadata: {
        provider: "openai",
        model: stringValue(payload.model) ?? input.model ?? options.model,
        generationId: stringValue(payload.id),
        usage: normalizeOpenAIUsage(payload.usage),
        pricingSource: "unavailable"
      }
    } satisfies LLMProviderResponse;
    }),
    model: options.model
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): LLMProvider {
  return {
    ...createLLMProvider("anthropic", async (input) => {
    const response = await fetch(`${options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: input.signal,
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model ?? options.model,
        max_tokens: 4000,
        system: "Return only valid JSON for the requested schema. Do not include prose or markdown.",
        messages: [{ role: "user", content: input.prompt }]
      })
    });
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const payload = (await response.json()) as { id?: string; model?: string; usage?: unknown; content?: Array<{ type?: string; text?: string }> };
    return {
      output: payload.content?.find((part) => part.type === "text")?.text ?? "",
      metadata: {
        provider: "anthropic",
        model: payload.model ?? input.model ?? options.model,
        generationId: payload.id,
        usage: normalizeAnthropicUsage(payload.usage),
        pricingSource: "unavailable"
      }
    } satisfies LLMProviderResponse;
    }),
    model: options.model
  };
}

export function createOpenRouterProvider(options: OpenRouterProviderOptions): LLMProvider {
  const reasoningCache = new Map<string, OpenRouterMessage>();
  return {
    name: "openrouter",
    model: options.model,
    async generateStructured(input) {
      const model = input.model ?? options.model;
      const cacheKey = `${input.stage ?? input.metadata?.stage ?? input.task}:${input.schemaName}`;
      const previousAssistant = reasoningCache.get(cacheKey);
      const messages: OpenRouterMessage[] = [
        {
          role: "system",
          content:
            "Return only valid JSON for the requested schema. Do not include markdown, prose, comments, or extra keys."
        }
      ];
      if (previousAssistant && input.metadata?.structuredRetryAttempt) {
        messages.push(previousAssistant);
      }
      messages.push({ role: "user", content: input.prompt });

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      };
      if (options.siteUrl) headers["HTTP-Referer"] = options.siteUrl;
      if (options.appName) headers["X-Title"] = options.appName;

      const response = await fetch(`${options.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
        method: "POST",
        headers,
        signal: input.signal,
        body: JSON.stringify({
          model,
          messages,
          reasoning: { enabled: input.reasoningEnabled ?? options.reasoningEnabled ?? true },
          response_format: { type: "json_object" }
        })
      });
      if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);

      const payload = (await response.json()) as {
        id?: string;
        model?: string;
        usage?: unknown;
        choices?: Array<{ message?: OpenRouterMessage & { reasoning_details?: unknown } }>;
      };
      const message = payload.choices?.[0]?.message;
      const metadata = {
        provider: "openrouter",
        model: payload.model ?? model,
        generationId: payload.id,
        usage: normalizeOpenRouterUsage(payload.usage),
        costUsd: readNumber((payload.usage as Record<string, unknown> | undefined)?.cost),
        pricingSource: readNumber((payload.usage as Record<string, unknown> | undefined)?.cost) !== undefined ? "provider_usage" : undefined
      } satisfies LLMProviderResponse["metadata"];
      if (!message) return { output: "", metadata } satisfies LLMProviderResponse;
      if (message.reasoning_details) {
        reasoningCache.set(cacheKey, {
          role: "assistant",
          content: message.content ?? "",
          reasoning_details: message.reasoning_details
        });
      }
      return { output: message.content ?? "", metadata } satisfies LLMProviderResponse;
    }
  };
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning_details?: unknown;
}

function extractOpenAIText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = payload.output;
  if (!Array.isArray(output)) return JSON.stringify(payload);
  for (const item of output as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
    const text = item.content?.find((part) => part.type === "output_text" || part.type === "text")?.text;
    if (text) return text;
  }
  return JSON.stringify(payload);
}

function normalizeOpenRouterUsage(value: unknown): Partial<TokenUsage> | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  const promptDetails = objectValue(usage.prompt_tokens_details);
  const completionDetails = objectValue(usage.completion_tokens_details);
  return stripUndefined({
    prompt_tokens: readNumber(usage.prompt_tokens),
    completion_tokens: readNumber(usage.completion_tokens),
    total_tokens: readNumber(usage.total_tokens),
    reasoning_tokens: readNumber(completionDetails?.reasoning_tokens),
    cached_tokens: readNumber(promptDetails?.cached_tokens),
    cache_read_tokens: readNumber(promptDetails?.cache_read_tokens),
    cache_write_tokens: readNumber(promptDetails?.cache_write_tokens)
  });
}

function normalizeOpenAIUsage(value: unknown): Partial<TokenUsage> | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  const promptDetails = objectValue(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const completionDetails = objectValue(usage.output_tokens_details ?? usage.completion_tokens_details);
  const promptTokens = readNumber(usage.input_tokens ?? usage.prompt_tokens);
  const completionTokens = readNumber(usage.output_tokens ?? usage.completion_tokens);
  return stripUndefined({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: readNumber(usage.total_tokens) ?? sumDefined(promptTokens, completionTokens),
    reasoning_tokens: readNumber(completionDetails?.reasoning_tokens),
    cached_tokens: readNumber(promptDetails?.cached_tokens)
  });
}

function normalizeAnthropicUsage(value: unknown): Partial<TokenUsage> | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  const promptTokens = readNumber(usage.input_tokens);
  const completionTokens = readNumber(usage.output_tokens);
  return stripUndefined({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: sumDefined(promptTokens, completionTokens),
    cache_read_tokens: readNumber(usage.cache_read_input_tokens),
    cache_write_tokens: readNumber(usage.cache_creation_input_tokens)
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function stripUndefined(value: Partial<TokenUsage>): Partial<TokenUsage> | undefined {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
