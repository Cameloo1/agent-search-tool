import type {
  LLMCallMetadata,
  LLMProvider,
  LLMProviderResponse,
  StructuredLLMCallTrace,
  StructuredLLMInput,
  TokenUsage
} from "@agent-search/shared";
import type { z, ZodTypeAny } from "zod";
import { errorToMessage, withTimeout } from "./provider.js";

export const DEFAULT_STRUCTURED_ATTEMPTS = 2;
export const MAX_STRUCTURED_ATTEMPTS = 4;

export type StructuredCallErrorCode = "invalid_output" | "provider_error";

export interface StructuredCallError {
  attempt: number;
  code: StructuredCallErrorCode;
  message: string;
  issues: string[];
}

export interface StructuredCallOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  repairInstructions?: string;
  coerceOutput?: (raw: unknown) => unknown;
}

export type StructuredCallResult<T> =
  | {
      ok: true;
      value: T;
      attempts: number;
      providerName: string;
      raw: unknown;
      rawOutputs: unknown[];
      metadata: LLMCallMetadata[];
      attemptDiagnostics: StructuredLLMCallTrace[];
      errors: StructuredCallError[];
    }
  | {
      ok: false;
      attempts: number;
      providerName: string;
      rawOutputs: unknown[];
      metadata: LLMCallMetadata[];
      attemptDiagnostics: StructuredLLMCallTrace[];
      lastRaw?: unknown;
      errors: StructuredCallError[];
    };

export async function structuredCall<TSchema extends ZodTypeAny>(
  provider: LLMProvider,
  input: StructuredLLMInput,
  schema: TSchema,
  options: StructuredCallOptions = {}
): Promise<StructuredCallResult<z.infer<TSchema>>> {
  const maxAttempts = clampAttempts(options.maxAttempts);
  const rawOutputs: unknown[] = [];
  const metadata: LLMCallMetadata[] = [];
  const attemptDiagnostics: StructuredLLMCallTrace[] = [];
  const errors: StructuredCallError[] = [];
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    const attemptInput =
      attempt === 1
        ? withTimeoutMetadata(input, options.timeoutMs)
        : buildRetryInput(input, attempt, lastIssues, options);

    const started = Date.now();
    try {
      const raw = await generateStructuredWithAbortableTimeout(
        provider,
        attemptInput,
        options.timeoutMs ?? attemptInput.timeoutMs,
        `${provider.name}:${input.schemaName}`
      );
      const durationMs = Date.now() - started;
      const providerResponse = unwrapProviderResponse(raw);
      rawOutputs.push(providerResponse.output);
      if (providerResponse.metadata) {
        metadata.push(providerResponse.metadata);
      }

      const parsedRaw = options.coerceOutput
        ? options.coerceOutput(coerceStructuredOutput(providerResponse.output))
        : coerceStructuredOutput(providerResponse.output);
      const parsed = schema.safeParse(parsedRaw);

      if (parsed.success) {
        attemptDiagnostics.push(
          makeAttemptDiagnostic({
            input: attemptInput,
            provider,
            metadata: providerResponse.metadata,
            attempt,
            durationMs,
            ok: true,
            rawOutput: providerResponse.output
          })
        );
        return {
          ok: true,
          value: parsed.data,
          attempts: attempt,
          providerName: provider.name,
          raw: providerResponse.output,
          rawOutputs,
          metadata,
          attemptDiagnostics,
          errors
        };
      }

      lastIssues = formatZodIssues(parsed.error);
      attemptDiagnostics.push(
        makeAttemptDiagnostic({
          input: attemptInput,
          provider,
          metadata: providerResponse.metadata,
          attempt,
          durationMs,
          ok: false,
          validationIssues: lastIssues,
          rawOutput: providerResponse.output,
          errorCode: "invalid_output",
          errorMessage: `Provider output failed ${input.schemaName} validation`
        })
      );
      errors.push({
        attempt,
        code: "invalid_output",
        message: `Provider output failed ${input.schemaName} validation`,
        issues: lastIssues
      });
    } catch (error) {
      throwIfAborted(input.signal);
      const message = errorToMessage(error);
      lastIssues = [message];
      attemptDiagnostics.push(
        makeAttemptDiagnostic({
          input: attemptInput,
          provider,
          attempt,
          durationMs: Date.now() - started,
          ok: false,
          errorCode: "provider_error",
          errorMessage: message,
          validationIssues: [message],
          timeout: /timed out/i.test(message)
        })
      );
      errors.push({
        attempt,
        code: "provider_error",
        message,
        issues: [message]
      });
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    providerName: provider.name,
    rawOutputs,
    metadata,
    attemptDiagnostics,
    lastRaw: rawOutputs.at(-1),
    errors
  };
}

function makeAttemptDiagnostic(input: {
  input: StructuredLLMInput;
  provider: LLMProvider;
  metadata?: LLMCallMetadata;
  attempt: number;
  durationMs: number;
  ok: boolean;
  validationIssues?: string[];
  rawOutput?: unknown;
  errorCode?: string;
  errorMessage?: string;
  timeout?: boolean;
}): StructuredLLMCallTrace {
  return {
    stage: input.input.stage ?? String(input.input.metadata?.stage ?? "default"),
    task: input.input.task,
    schema_name: input.input.schemaName,
    provider: input.metadata?.provider ?? input.provider.name,
    model: input.metadata?.model ?? input.input.model ?? input.provider.model ?? null,
    attempt: input.attempt,
    duration_ms: Math.max(0, input.durationMs),
    ok: input.ok,
    usage: input.metadata?.usage ? normalizeUsage(input.metadata.usage) : undefined,
    cost_usd: input.metadata?.costUsd ?? undefined,
    pricing_source: input.metadata?.pricingSource,
    generation_id: input.metadata?.generationId ?? undefined,
    validation_issues: input.validationIssues ?? [],
    error_code: input.errorCode,
    error_message: input.errorMessage,
    raw_output_snippet: input.rawOutput === undefined ? undefined : truncateSnippet(input.rawOutput),
    timeout: input.timeout ?? false,
    reasoning_enabled: input.input.reasoningEnabled
  };
}

function normalizeUsage(usage: Partial<TokenUsage>): TokenUsage {
  const promptTokens = toNonnegativeInt(usage.prompt_tokens);
  const completionTokens = toNonnegativeInt(usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: toNonnegativeInt(usage.total_tokens ?? promptTokens + completionTokens),
    reasoning_tokens: optionalInt(usage.reasoning_tokens),
    cached_tokens: optionalInt(usage.cached_tokens),
    cache_read_tokens: optionalInt(usage.cache_read_tokens),
    cache_write_tokens: optionalInt(usage.cache_write_tokens)
  };
}

function optionalInt(value: number | undefined): number | undefined {
  return value === undefined ? undefined : toNonnegativeInt(value);
}

function toNonnegativeInt(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, Math.trunc(value)) : 0;
}

function truncateSnippet(value: unknown, maxChars = 900): string {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nested) => {
          if (Array.isArray(nested) && nested.length > 20) return [...nested.slice(0, 20), "[truncated]"];
          return nested;
        });
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 15).trimEnd()} [truncated]`;
}

export function unwrapProviderResponse(raw: unknown): LLMProviderResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { output: raw };
  }

  const record = raw as Record<string, unknown>;
  if (!("output" in record) || !("metadata" in record)) {
    return { output: raw };
  }

  return {
    output: record.output,
    metadata: isLLMCallMetadata(record.metadata) ? record.metadata : undefined
  };
}

function isLLMCallMetadata(value: unknown): value is LLMCallMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.provider === "string";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }
}

export function coerceStructuredOutput(raw: unknown): unknown {
  if (typeof raw === "string") {
    return parsePossiblyFencedJson(raw);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.content === "string" && Object.keys(record).length <= 3) {
    return parsePossiblyFencedJson(record.content);
  }

  if (typeof record.text === "string" && Object.keys(record).length <= 3) {
    return parsePossiblyFencedJson(record.text);
  }

  return raw;
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function clampAttempts(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_STRUCTURED_ATTEMPTS;
  }

  return Math.min(MAX_STRUCTURED_ATTEMPTS, Math.max(1, Math.trunc(value)));
}

function withTimeoutMetadata(input: StructuredLLMInput, timeoutMs: number | undefined): StructuredLLMInput {
  return timeoutMs ? { ...input, timeoutMs } : input;
}

function buildRetryInput(
  input: StructuredLLMInput,
  attempt: number,
  issues: string[],
  options: StructuredCallOptions
): StructuredLLMInput {
  const issueText = issues.length > 0 ? issues.map((issue) => `- ${issue}`).join("\n") : "- Unknown validation error";
  const repairInstructions =
    options.repairInstructions ??
    "Return only JSON that satisfies the requested schema. Do not include markdown, prose, comments, or extra keys.";

  return {
    ...withTimeoutMetadata(input, options.timeoutMs),
    task: `${input.task} (schema repair attempt ${attempt})`,
    prompt: `${input.prompt}

The previous response failed validation and was rejected by schema validation for ${input.schemaName}.
Validation issues:
${issueText}

${repairInstructions}`,
    metadata: {
      ...input.metadata,
      structuredRetryAttempt: attempt,
      previousValidationIssues: issues
    }
  };
}

async function generateStructuredWithAbortableTimeout(
  provider: LLMProvider,
  input: StructuredLLMInput,
  timeoutMs: number | undefined,
  label: string
): Promise<unknown> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return provider.generateStructured(input);
  }

  const controller = new AbortController();
  const parentSignal = input.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const timeoutId = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    return await withTimeout(
      provider.generateStructured({ ...input, signal: controller.signal }),
      timeoutMs,
      label
    );
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function parsePossiblyFencedJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstObject = withoutFence.indexOf("{");
    const firstArray = withoutFence.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    const end = Math.max(withoutFence.lastIndexOf("}"), withoutFence.lastIndexOf("]"));

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        return text;
      }
    }

    return text;
  }
}
