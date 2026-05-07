import {
  CostSummarySchema,
  ModelCostLineItemSchema,
  type CostSummary,
  type LLMCallMetadata,
  type LLMProvider,
  type LLMProviderResponse,
  type LLMStageKey,
  type ModelCostLineItem,
  type QualityMode,
  type TokenUsage,
  type Trace
} from "@agent-search/shared";

export interface CostTrackingTarget {
  modelUsage: Trace["model_usage"];
  modelCostLineItems: ModelCostLineItem[];
}

export interface OpenRouterModelPricing {
  prompt: number;
  completion: number;
}

export type OpenRouterPricingCatalog = Record<string, OpenRouterModelPricing>;

export interface CostSummaryOptions {
  openRouterPricingCacheTtlMs?: number;
  pricingCatalog?: OpenRouterPricingCatalog;
  fetchPricingCatalog?: () => Promise<OpenRouterPricingCatalog>;
}

const DEFAULT_PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedOpenRouterPricing:
  | {
      fetchedAt: number;
      catalog: OpenRouterPricingCatalog;
    }
  | undefined;

export function createCostTrackingProvider(provider: LLMProvider, target: CostTrackingTarget): LLMProvider {
  return {
    ...provider,
    async generateStructured(input) {
      const started = Date.now();
      const result = await provider.generateStructured(input);
      const durationMs = Date.now() - started;
      const providerResponse = unwrapProviderResponse(result);
      const stage = normalizeStage(input.stage);
      const metadata = providerResponse.metadata;
      const usage = normalizeUsage(metadata?.usage);
      const model = metadata?.model ?? input.model ?? provider.model ?? target.modelUsage[stage]?.model ?? "unknown";
      const providerName = metadata?.provider ?? provider.name;
      const isMock = providerName.toLowerCase().includes("mock");
      const totalCost = metadata?.costUsd ?? null;
      const pricingSource =
        metadata?.pricingSource ?? (isMock ? "mock_zero" : totalCost !== null ? "provider_usage" : "unavailable");
      const warnings = [...(metadata?.warnings ?? [])];
      if (!isMock && totalCost === null) {
        warnings.push("Provider did not return a dollar cost; catalog estimate may be used if pricing is available.");
      }

      target.modelCostLineItems.push(
        ModelCostLineItemSchema.parse({
          id: `${stage}:${input.schemaName}:${target.modelCostLineItems.length + 1}`,
          stage,
          task: input.task,
          schema_name: input.schemaName,
          provider: providerName,
          model,
          quality_mode: target.modelUsage[stage]?.quality_mode ?? "fast",
          attempt: attemptFromMetadata(input.metadata),
          usage,
          input_cost_usd: metadata?.inputCostUsd ?? null,
          output_cost_usd: metadata?.outputCostUsd ?? null,
          total_cost_usd: isMock ? 0 : totalCost,
          pricing_source: pricingSource,
          generation_id: metadata?.generationId ?? null,
          duration_ms: durationMs,
          estimated: pricingSource === "catalog_estimate",
          warnings
        })
      );

      return result;
    }
  };
}

export async function summarizeModelCosts(
  lineItems: ModelCostLineItem[],
  options: CostSummaryOptions = {}
): Promise<CostSummary> {
  const warnings: string[] = [];
  const needsEstimate = lineItems.some(
    (item) => item.pricing_source === "unavailable" && item.provider === "openrouter" && item.usage.total_tokens > 0
  );
  let pricingCatalog = options.pricingCatalog;

  if (needsEstimate && !pricingCatalog) {
    try {
      pricingCatalog = options.fetchPricingCatalog
        ? await options.fetchPricingCatalog()
        : await fetchOpenRouterPricingCatalog(options.openRouterPricingCacheTtlMs);
    } catch (error) {
      warnings.push(`OpenRouter pricing catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const resolved = lineItems.map((item) => resolveCostLineItem(item, pricingCatalog, warnings));
  const summary = resolved.reduce(
    (accumulator, item) => {
      accumulator.total_cost_usd += item.total_cost_usd ?? 0;
      accumulator.total_prompt_tokens += item.usage.prompt_tokens;
      accumulator.total_completion_tokens += item.usage.completion_tokens;
      accumulator.total_reasoning_tokens += item.usage.reasoning_tokens ?? 0;
      accumulator.total_cached_tokens += item.usage.cached_tokens ?? item.usage.cache_read_tokens ?? 0;
      accumulator.total_tokens += item.usage.total_tokens;
      accumulator.estimated = accumulator.estimated || item.estimated || item.pricing_source === "unavailable";
      addGroup(accumulator.by_stage, item.stage, item);
      addGroup(accumulator.by_model, item.model, item);
      if (item.pricing_source === "unavailable") {
        warnings.push(`${item.stage} ${item.model} cost unavailable.`);
      }
      return accumulator;
    },
    {
      currency: "USD" as const,
      total_cost_usd: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_reasoning_tokens: 0,
      total_cached_tokens: 0,
      total_tokens: 0,
      estimated: false,
      by_stage: {} as CostSummary["by_stage"],
      by_model: {} as CostSummary["by_model"]
    }
  );

  return CostSummarySchema.parse({
    ...summary,
    total_cost_usd: roundCost(summary.total_cost_usd),
    pricing_source: summarizePricingSource(resolved),
    line_items: resolved,
    warnings: Array.from(new Set(warnings))
  });
}

export async function fetchOpenRouterPricingCatalog(ttlMs = DEFAULT_PRICING_CACHE_TTL_MS): Promise<OpenRouterPricingCatalog> {
  const now = Date.now();
  if (cachedOpenRouterPricing && now - cachedOpenRouterPricing.fetchedAt < ttlMs) {
    return cachedOpenRouterPricing.catalog;
  }

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`OpenRouter models HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: Array<{ id?: string; pricing?: Record<string, unknown> }> };
  const catalog: OpenRouterPricingCatalog = {};
  for (const model of payload.data ?? []) {
    const id = model.id;
    if (!id || !model.pricing) continue;
    const prompt = readNumber(model.pricing.prompt);
    const completion = readNumber(model.pricing.completion);
    if (prompt === undefined || completion === undefined) continue;
    catalog[id] = { prompt, completion };
  }

  cachedOpenRouterPricing = { fetchedAt: now, catalog };
  return catalog;
}

function resolveCostLineItem(
  item: ModelCostLineItem,
  catalog: OpenRouterPricingCatalog | undefined,
  warnings: string[]
): ModelCostLineItem {
  if (item.total_cost_usd !== null || item.pricing_source === "mock_zero") {
    return item;
  }

  if (item.provider === "openrouter" && catalog) {
    const pricing = catalog[item.model] ?? catalog[item.model.replace(/^~/, "")];
    if (pricing) {
      const inputCost = item.usage.prompt_tokens * pricing.prompt;
      const outputCost = item.usage.completion_tokens * pricing.completion;
      return ModelCostLineItemSchema.parse({
        ...item,
        input_cost_usd: roundCost(inputCost),
        output_cost_usd: roundCost(outputCost),
        total_cost_usd: roundCost(inputCost + outputCost),
        pricing_source: "catalog_estimate",
        estimated: true,
        warnings: [...item.warnings, "Cost estimated from OpenRouter model catalog pricing."]
      });
    }
    warnings.push(`OpenRouter catalog did not include pricing for ${item.model}.`);
  }

  return item;
}

function addGroup(target: CostSummary["by_stage"], key: string, item: ModelCostLineItem): void {
  const existing =
    target[key] ??
    {
      total_cost_usd: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      line_item_count: 0,
      estimated: false
    };
  existing.total_cost_usd = roundCost(existing.total_cost_usd + (item.total_cost_usd ?? 0));
  existing.prompt_tokens += item.usage.prompt_tokens;
  existing.completion_tokens += item.usage.completion_tokens;
  existing.total_tokens += item.usage.total_tokens;
  existing.line_item_count += 1;
  existing.estimated = existing.estimated || item.estimated || item.pricing_source === "unavailable";
  target[key] = existing;
}

function summarizePricingSource(lineItems: ModelCostLineItem[]): CostSummary["pricing_source"] {
  if (lineItems.length === 0) return "unavailable";
  const sources = new Set(lineItems.map((item) => item.pricing_source));
  if (sources.size === 1) return [...sources][0] === "provider_usage" ? "provider_usage" : ([...sources][0] as CostSummary["pricing_source"]);
  if (sources.has("unavailable") && [...sources].every((source) => source === "unavailable")) return "unavailable";
  return "mixed";
}

function normalizeStage(stage: LLMStageKey | undefined): LLMStageKey {
  return stage ?? "default";
}

function attemptFromMetadata(metadata: Record<string, unknown> | undefined): number {
  const retryAttempt = readNumber(metadata?.structuredRetryAttempt);
  return retryAttempt && retryAttempt > 0 ? Math.trunc(retryAttempt) : 1;
}

function normalizeUsage(usage: Partial<TokenUsage> | undefined): TokenUsage {
  const promptTokens = toNonnegativeInt(usage?.prompt_tokens);
  const completionTokens = toNonnegativeInt(usage?.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: toNonnegativeInt(usage?.total_tokens ?? promptTokens + completionTokens),
    reasoning_tokens: optionalInt(usage?.reasoning_tokens),
    cached_tokens: optionalInt(usage?.cached_tokens),
    cache_read_tokens: optionalInt(usage?.cache_read_tokens),
    cache_write_tokens: optionalInt(usage?.cache_write_tokens)
  };
}

function unwrapProviderResponse(raw: unknown): LLMProviderResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { output: raw };
  }
  const record = raw as Record<string, unknown>;
  if (!("output" in record)) {
    return { output: raw };
  }
  return {
    output: record.output,
    metadata: isLLMCallMetadata(record.metadata) ? record.metadata : undefined
  };
}

function isLLMCallMetadata(value: unknown): value is LLMCallMetadata {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { provider?: unknown }).provider === "string");
}

function optionalInt(value: number | undefined): number | undefined {
  return value === undefined ? undefined : toNonnegativeInt(value);
}

function toNonnegativeInt(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, Math.trunc(value)) : 0;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
