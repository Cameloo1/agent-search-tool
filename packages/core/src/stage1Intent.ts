import { IntentObjectSchema, type IntentObject, type LLMProvider, type PipelineRequest, type StructuredLLMCallTrace } from "@agent-search/shared";
import { buildStage1IntentPrompt, structuredCall } from "@agent-search/llm";
import { stageError, type StageError } from "./errors.js";

export interface Stage1Result {
  intent: IntentObject;
  errors: StageError[];
  warnings: string[];
  structuredLlmCalls: StructuredLLMCallTrace[];
}

export async function decomposeIntent(
  request: PipelineRequest,
  provider: LLMProvider,
  options: { timeoutMs?: number; maxAttempts?: number; now?: Date | string; signal?: AbortSignal; reasoningEnabled?: boolean } = {}
): Promise<Stage1Result> {
  const result = await structuredCall(
    provider,
    {
      task: "stage1_intent_decomposer",
      prompt: buildStage1IntentPrompt({ request, now: options.now }),
      schemaName: "IntentObject",
      stage: "intent",
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      reasoningEnabled: options.reasoningEnabled,
      metadata: { stage: "stage1", query: request.query }
    },
    IntentObjectSchema,
    { maxAttempts: options.maxAttempts ?? 2, timeoutMs: options.timeoutMs }
  );

  if (result.ok) {
    return {
      intent: normalizeIntent(result.value, request.query),
      errors: [],
      warnings: result.errors.length > 0 ? ["Stage 1 needed a structured repair attempt before validation succeeded."] : [],
      structuredLlmCalls: result.attemptDiagnostics
    };
  }

  return {
    intent: fallbackIntent(request.query),
    errors: [
      stageError("stage1_intent", "LLM_SCHEMA_INVALID", "Intent decomposer failed schema validation; safe fallback intent used.", {
        attempts: result.attempts,
        provider: result.providerName,
        errors: result.errors
      })
    ],
    warnings: ["Stage 1 used deterministic fallback intent."],
    structuredLlmCalls: result.attemptDiagnostics
  };
}

function normalizeIntent(intent: IntentObject, query: string): IntentObject {
  const lower = query.toLowerCase();
  const required = new Set(intent.required_source_types);
  if (required.has("news") && !/\b(news|headline|headlines|article|articles|press)\b/.test(lower)) {
    required.delete("news");
    required.add("government");
    required.add("academic");
  }
  if (/(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel|commodity|commodities)/.test(lower)) {
    required.add("government");
    required.add("academic");
    required.add("encyclopedic");
  }
  if (intent.query_type.includes("fresh-fact") && required.size === 0) {
    required.add("government");
    required.add("academic");
  }

  return IntentObjectSchema.parse({
    ...intent,
    required_source_types: Array.from(required).slice(0, 6)
  });
}

export function fallbackIntent(query: string): IntentObject {
  const lower = query.toLowerCase();
  const queryTypes: IntentObject["query_type"] = [];
  const sourceTypes: IntentObject["required_source_types"] = [];

  if (/(debt|inflation|deficit|spending|fiscal|geopolitic|market downturn|crash)/.test(lower)) {
    queryTypes.push("multi-hop", "fresh-fact");
    sourceTypes.push("government", "academic");
  }
  if (/(source|cite|attribution|edgar|filing|legal|insider|owasp|nist|cisa)/.test(lower)) {
    queryTypes.push("source-attribution", "adversarial");
    sourceTypes.push("primary-document");
  }
  if (/(duplicate|dedup|submodular|bayesian|embedding|similarity|pipeline)/.test(lower)) {
    queryTypes.push("multi-hop", "academic", "source-attribution");
    sourceTypes.push("academic", "code");
  }
  if (/(vibecode|appsec|security|pre-production|webhook|sast|dast)/.test(lower)) {
    queryTypes.push("source-attribution", "adversarial");
    sourceTypes.push("code", "primary-document");
  }
  if (/(retail|institution|trader|bank|news|market)/.test(lower)) {
    queryTypes.push("multi-hop", "source-attribution");
    sourceTypes.push("filing", "government");
  }
  if (/(oil|crude|wti|brent|opec|gasoline|energy|petroleum|fuel|commodity|commodities)/.test(lower)) {
    queryTypes.push("fresh-fact", "multi-hop");
    sourceTypes.push("government", "academic", "encyclopedic");
  }

  return IntentObjectSchema.parse({
    core_intent: query.slice(0, 280),
    query_type: Array.from(new Set(queryTypes)).slice(0, 4).length ? Array.from(new Set(queryTypes)).slice(0, 4) : ["multi-hop"],
    entities: extractCapitalizedEntities(query),
    temporal_constraints: lower.includes("current") || lower.includes("present") || lower.includes("currently") ? "current" : null,
    required_source_types: Array.from(new Set(sourceTypes)).slice(0, 5)
  });
}

function extractCapitalizedEntities(query: string): string[] {
  return Array.from(new Set(query.match(/\b[A-Z][A-Za-z0-9.-]*(?:\s+[A-Z][A-Za-z0-9.-]*){0,3}\b/g) ?? [])).slice(0, 10);
}
