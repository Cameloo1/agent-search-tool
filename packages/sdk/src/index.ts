import {
  ChatMessageSchema,
  PipelineRequestSchema,
  SourceNameSchema,
  type Embedder,
  type FetchOptions,
  type LLMProvider,
  type NormalizedChunk,
  type PipelineProgressEvent,
  type PipelineRequest,
  type PipelineResponse,
  type QualityMode,
  type SourceDescriptor,
  type SourceName,
  type Trace
} from "@agent-search/shared";
import { runPipeline, type PipelineOptions } from "@agent-search/core";
import {
  createSourceRegistry,
  defineSourcePlugin,
  type SourceHandler,
  type SourcePluginDefinition,
  type SourcePluginDiagnostic
} from "@agent-search/sources";

export { defineSourcePlugin };
export type {
  SourceHandler,
  SourcePluginDefinition,
  SourcePluginDiagnostic,
  SourcePluginHandler,
  SourcePluginManifest,
  SourcePluginContext
} from "@agent-search/sources";
export type { SourceDescriptor, SourceId, SourceName } from "@agent-search/shared";

export type AgentSearchOutputMode = "answer_evidence" | "evidence" | "raw";

export interface AgentSearchToolConfig {
  sourcePlugins?: SourcePluginDefinition[];
  sourceHandlers?: Record<string, SourceHandler>;
  sourceDescriptors?: SourceDescriptor[];
  llmProvider?: LLMProvider;
  embedder?: Embedder;
  credentials?: FetchOptions["apiKeys"] & Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
  defaultRequest?: Partial<PipelineRequest>;
  defaultOutputMode?: AgentSearchOutputMode;
  pipelineOptions?: Omit<
    PipelineOptions,
    "llmProvider" | "embedder" | "sourceHandlers" | "sourceDescriptors" | "preferredSourceIds" | "onProgress"
  >;
  onProgress?: (event: PipelineProgressEvent) => void | Promise<void>;
}

export interface AgentSearchToolInput {
  query: string;
  quality_mode?: QualityMode;
  token_budget?: number;
  synthesize_answer?: boolean;
  output?: AgentSearchOutputMode;
  sources?: string[];
  memory_snippet?: string;
  chat_history?: PipelineRequest["chat_history"];
  debug?: boolean;
}

export interface AgentSearchCitation {
  chunk_id: string;
  source_name: string;
  source_type: string;
  title: string | null;
  url: string;
}

export interface AgentSearchEvidenceItem extends AgentSearchCitation {
  content: string;
  confidence_score: number;
  publish_date: string | null;
}

export interface AgentSearchTraceSummary {
  request_id: string;
  total_time_ms: number;
  counts: Trace["counts"];
  stage_timings_ms: Trace["stage_timings_ms"];
  source_results: Trace["source_results"];
  warnings: string[];
  errors: Trace["errors"];
}

export interface AgentSearchToolResult {
  request_id: string;
  query: string;
  answer: string;
  citations: AgentSearchCitation[];
  evidence: AgentSearchEvidenceItem[];
  confidence: {
    status: string;
    quality_score: number;
    coverage_score: number;
  } | null;
  trace_summary: AgentSearchTraceSummary;
  cost_summary?: Trace["cost_summary"];
  raw_response?: PipelineResponse;
}

export interface AgentSearchEvidenceResult {
  request_id: string;
  query: string;
  evidence: AgentSearchEvidenceItem[];
  citations: AgentSearchCitation[];
  confidence: AgentSearchToolResult["confidence"];
  trace_summary: AgentSearchTraceSummary;
  raw_response?: PipelineResponse;
}

export interface AgentSearchRegistryTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: Input): Promise<Output>;
}

export interface AgentSearchToolSuite {
  tools: AgentSearchRegistryTool[];
  registry: AgentSearchResolvedRegistry;
  store: AgentSearchRunStore;
}

export interface AgentSearchPlugin {
  id: "agent-search";
  tools: AgentSearchRegistryTool[];
  config: AgentSearchToolConfig;
  register(registry: ToolRegistryLike): void;
}

export interface AgentSearchResolvedRegistry {
  handlers: Record<string, SourceHandler>;
  descriptors: SourceDescriptor[];
  diagnostics: SourcePluginDiagnostic[];
}

export interface AgentSearchRunStore {
  get(requestId: string): PipelineResponse | undefined;
  list(): PipelineResponse[];
}

export type ToolRegistryLike =
  | { registerTool(tool: AgentSearchRegistryTool): void }
  | { register(tool: AgentSearchRegistryTool): void }
  | { tools: AgentSearchRegistryTool[] };

type JsonSchema = Record<string, unknown>;

export function defineAgentSearchConfig(config: AgentSearchToolConfig): AgentSearchToolConfig {
  return config;
}

export function createAgentSearchTool(
  config: AgentSearchToolConfig = {}
): AgentSearchRegistryTool<AgentSearchToolInput, AgentSearchToolResult | AgentSearchEvidenceResult | PipelineResponse> {
  return createAgentSearchToolSuite(config).tools[0] as AgentSearchRegistryTool<
    AgentSearchToolInput,
    AgentSearchToolResult | AgentSearchEvidenceResult | PipelineResponse
  >;
}

export function createAgentSearchToolSuite(config: AgentSearchToolConfig = {}): AgentSearchToolSuite {
  const registry = resolveAgentSearchRegistry(config);
  const runs = new Map<string, PipelineResponse>();
  const store: AgentSearchRunStore = {
    get: (requestId) => runs.get(requestId),
    list: () => Array.from(runs.values())
  };

  const executeSearch = async (rawInput: AgentSearchToolInput, forcedOutput?: AgentSearchOutputMode): Promise<PipelineResponse> => {
    const input = parseSearchToolInput(rawInput);
    const preferredSourceIds = normalizePreferredSources(input.sources, registry.descriptors);
    const request = PipelineRequestSchema.parse({
      ...config.defaultRequest,
      query: input.query,
      quality_mode: input.quality_mode ?? config.defaultRequest?.quality_mode ?? "balanced",
      token_budget: input.token_budget ?? config.defaultRequest?.token_budget,
      synthesize_answer:
        input.synthesize_answer ??
        config.defaultRequest?.synthesize_answer ??
        ((forcedOutput ?? input.output ?? config.defaultOutputMode ?? "answer_evidence") !== "evidence"),
      memory_snippet: input.memory_snippet ?? config.defaultRequest?.memory_snippet,
      chat_history: input.chat_history ?? config.defaultRequest?.chat_history,
      debug: input.debug ?? config.defaultRequest?.debug
    });

    const response = await runPipeline(request, {
      ...(config.pipelineOptions ?? {}),
      llmProvider: config.llmProvider,
      embedder: config.embedder,
      sourceHandlers: registry.handlers,
      sourceDescriptors: registry.descriptors,
      preferredSourceIds,
      apiKeys: normalizeApiKeys(config),
      onProgress: config.onProgress
    });
    runs.set(response.trace.request_id, response);
    return response;
  };

  const tools: AgentSearchRegistryTool[] = [
    {
      name: "agent_search",
      description: "Run Agent Search and return a direct cited answer with selected evidence and compact trace metadata.",
      inputSchema: searchToolJsonSchema(),
      execute: async (input: unknown) => {
        const parsed = parseSearchToolInput(input as AgentSearchToolInput);
        const response = await executeSearch(parsed);
        const mode = parsed.output ?? config.defaultOutputMode ?? "answer_evidence";
        if (mode === "raw") return response;
        if (mode === "evidence") return toEvidenceResult(response);
        return toAnswerResult(response);
      }
    },
    {
      name: "agent_search_evidence",
      description: "Run Agent Search and return the selected evidence packet without requiring answer synthesis.",
      inputSchema: searchToolJsonSchema(),
      execute: async (input: unknown) => toEvidenceResult(await executeSearch({ ...(input as AgentSearchToolInput), synthesize_answer: false }, "evidence"))
    },
    {
      name: "agent_search_trace",
      description: "Inspect the compact trace summary for a previous Agent Search run.",
      inputSchema: requestIdJsonSchema(),
      execute: async (input: unknown) => {
        const { request_id } = parseRequestIdInput(input);
        const response = runs.get(request_id);
        return response ? toTraceSummary(response.trace) : { request_id, error: "Run not found." };
      }
    },
    {
      name: "agent_search_sources",
      description: "List registered Agent Search source ids, labels, descriptions, and source types.",
      inputSchema: emptyJsonSchema(),
      execute: async () => ({ sources: registry.descriptors, diagnostics: registry.diagnostics })
    },
    {
      name: "agent_search_source_health",
      description: "Summarize registered source readiness and recent source failures from local runs.",
      inputSchema: emptyJsonSchema(),
      execute: async () => sourceHealth(registry, store.list())
    },
    {
      name: "agent_search_cost",
      description: "Return cost, token, and runtime metadata for a previous Agent Search run.",
      inputSchema: requestIdJsonSchema(),
      execute: async (input: unknown) => {
        const { request_id } = parseRequestIdInput(input);
        const response = runs.get(request_id);
        return response
          ? { request_id, cost_summary: response.trace.cost_summary ?? null, trace_summary: toTraceSummary(response.trace) }
          : { request_id, error: "Run not found." };
      }
    },
    {
      name: "agent_search_plugin_doctor",
      description: "Validate Agent Search source plugin config, handlers, source ids, and required environment variables.",
      inputSchema: emptyJsonSchema(),
      execute: async () => pluginDoctor(config, registry)
    }
  ];

  return { tools, registry, store };
}

export function agentSearchPlugin(config: AgentSearchToolConfig = {}): AgentSearchPlugin {
  const suite = createAgentSearchToolSuite(config);
  return {
    id: "agent-search",
    tools: suite.tools,
    config,
    register(registry: ToolRegistryLike) {
      registerAgentSearchTools(registry, suite.tools);
    }
  };
}

export function registerAgentSearchTools(registry: ToolRegistryLike, toolsOrSuite: AgentSearchToolSuite | AgentSearchRegistryTool[]): void {
  const tools = Array.isArray(toolsOrSuite) ? toolsOrSuite : toolsOrSuite.tools;
  for (const tool of tools) {
    if ("registerTool" in registry && typeof registry.registerTool === "function") registry.registerTool(tool);
    else if ("register" in registry && typeof registry.register === "function") registry.register(tool);
    else if ("tools" in registry && Array.isArray(registry.tools)) registry.tools.push(tool);
  }
}

function resolveAgentSearchRegistry(config: AgentSearchToolConfig): AgentSearchResolvedRegistry {
  const result = createSourceRegistry({
    plugins: config.sourcePlugins,
    extraHandlers: config.sourceHandlers,
    allowBuiltInOverride: false
  });
  const descriptorById = new Map(result.descriptors.map((descriptor) => [descriptor.id, descriptor]));
  for (const descriptor of config.sourceDescriptors ?? []) {
    descriptorById.set(descriptor.id, descriptor);
  }
  for (const sourceId of Object.keys(config.sourceHandlers ?? {})) {
    if (!descriptorById.has(sourceId)) descriptorById.set(sourceId, { id: sourceId, label: sourceId, built_in: false });
  }
  return { ...result, descriptors: Array.from(descriptorById.values()) };
}

function normalizePreferredSources(sources: string[] | undefined, descriptors: SourceDescriptor[]): SourceName[] {
  if (!sources || sources.length === 0) return [];
  const allowed = new Set(descriptors.map((descriptor) => descriptor.id));
  return Array.from(
    new Set(
      sources.flatMap((source) => {
        const parsed = SourceNameSchema.safeParse(source);
        return parsed.success && allowed.has(parsed.data) ? [parsed.data] : [];
      })
    )
  );
}

function parseSearchToolInput(input: AgentSearchToolInput): AgentSearchToolInput {
  if (!input || typeof input !== "object") throw new Error("Agent Search input must be an object.");
  if (typeof input.query !== "string" || input.query.trim().length === 0) throw new Error("Agent Search input requires a non-empty query.");
  if (input.quality_mode && !["fast", "balanced", "quality"].includes(input.quality_mode)) throw new Error("quality_mode must be fast, balanced, or quality.");
  if (input.output && !["answer_evidence", "evidence", "raw"].includes(input.output)) throw new Error("output must be answer_evidence, evidence, or raw.");
  if (input.token_budget !== undefined && (!Number.isInteger(input.token_budget) || input.token_budget <= 0)) throw new Error("token_budget must be a positive integer.");
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.some((source) => typeof source !== "string"))) {
    throw new Error("sources must be an array of source id strings.");
  }
  if (input.chat_history !== undefined) {
    for (const message of input.chat_history) ChatMessageSchema.parse(message);
  }
  return input;
}

function parseRequestIdInput(input: unknown): { request_id: string } {
  if (!input || typeof input !== "object") throw new Error("Tool input must be an object.");
  const requestId = (input as Record<string, unknown>).request_id;
  if (typeof requestId !== "string" || requestId.length === 0) throw new Error("request_id is required.");
  return { request_id: requestId };
}

function normalizeApiKeys(config: AgentSearchToolConfig): PipelineOptions["apiKeys"] {
  const credentials = config.credentials ?? {};
  return {
    ...config.pipelineOptions?.apiKeys,
    core: credentials.core ?? config.pipelineOptions?.apiKeys?.core,
    github: credentials.github ?? config.pipelineOptions?.apiKeys?.github,
    semanticScholar: credentials.semanticScholar ?? config.pipelineOptions?.apiKeys?.semanticScholar
  };
}

function toAnswerResult(response: PipelineResponse): AgentSearchToolResult {
  const evidence = response.chunks.map(toEvidenceItem);
  return {
    request_id: response.trace.request_id,
    query: response.query,
    answer: response.synthesized_answer ?? evidence.map((item) => `${item.content} [${item.chunk_id}]`).join("\n\n"),
    citations: evidence.map(toCitation),
    evidence,
    confidence: toConfidence(response),
    trace_summary: toTraceSummary(response.trace),
    cost_summary: response.trace.cost_summary
  };
}

function toEvidenceResult(response: PipelineResponse): AgentSearchEvidenceResult {
  const evidence = response.chunks.map(toEvidenceItem);
  return {
    request_id: response.trace.request_id,
    query: response.query,
    citations: evidence.map(toCitation),
    evidence,
    confidence: toConfidence(response),
    trace_summary: toTraceSummary(response.trace)
  };
}

function toEvidenceItem(chunk: NormalizedChunk): AgentSearchEvidenceItem {
  return {
    chunk_id: chunk.id,
    source_name: chunk.metadata.source_name,
    source_type: chunk.metadata.source_type,
    title: chunk.metadata.title,
    url: chunk.metadata.url,
    content: chunk.content,
    confidence_score: chunk.metadata.confidence_score,
    publish_date: chunk.metadata.publish_date
  };
}

function toCitation(item: AgentSearchEvidenceItem): AgentSearchCitation {
  return {
    chunk_id: item.chunk_id,
    source_name: item.source_name,
    source_type: item.source_type,
    title: item.title,
    url: item.url
  };
}

function toConfidence(response: PipelineResponse): AgentSearchToolResult["confidence"] {
  if (!response.evidence_health) return null;
  return {
    status: response.evidence_health.status,
    quality_score: response.evidence_health.evidence_quality_score,
    coverage_score: response.evidence_health.evidence_coverage_score
  };
}

function toTraceSummary(trace: Trace): AgentSearchTraceSummary {
  return {
    request_id: trace.request_id,
    total_time_ms: Math.max(0, Date.parse(trace.finished_at) - Date.parse(trace.started_at)),
    counts: trace.counts,
    stage_timings_ms: trace.stage_timings_ms,
    source_results: trace.source_results,
    warnings: trace.warnings,
    errors: trace.errors
  };
}

function sourceHealth(registry: AgentSearchResolvedRegistry, runs: PipelineResponse[]) {
  const recentFailures = runs.flatMap((run) =>
    Object.entries(run.trace.source_results).flatMap(([source, result]) =>
      result.errors.map((error) => ({
        request_id: run.trace.request_id,
        source,
        code: error.code,
        message: error.message,
        category: error.category
      }))
    )
  );
  return {
    source_count: registry.descriptors.length,
    plugin_diagnostics: registry.diagnostics,
    recent_failures: recentFailures.slice(-50)
  };
}

function pluginDoctor(config: AgentSearchToolConfig, registry: AgentSearchResolvedRegistry) {
  const env = { ...process.env, ...(config.env ?? {}) };
  const missingEnv = (config.sourcePlugins ?? []).flatMap((plugin) =>
    plugin.manifest.env
      .filter((entry) => entry.required && !env[entry.name])
      .map((entry) => ({
        plugin_id: plugin.manifest.id,
        env: entry.name,
        message: `Required environment variable ${entry.name} is not configured.`
      }))
  );

  return {
    ok: registry.diagnostics.every((diagnostic) => diagnostic.level !== "error") && missingEnv.length === 0,
    diagnostics: registry.diagnostics,
    missing_env: missingEnv,
    registered_sources: registry.descriptors
  };
}

function searchToolJsonSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1 },
      quality_mode: { type: "string", enum: ["fast", "balanced", "quality"] },
      token_budget: { type: "integer", minimum: 1 },
      synthesize_answer: { type: "boolean" },
      output: { type: "string", enum: ["answer_evidence", "evidence", "raw"] },
      sources: { type: "array", items: { type: "string" } },
      memory_snippet: { type: "string" },
      chat_history: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["user", "assistant", "system"] },
            content: { type: "string", minLength: 1 }
          }
        }
      },
      debug: { type: "boolean" }
    }
  };
}

function requestIdJsonSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["request_id"],
    properties: {
      request_id: { type: "string", minLength: 1 }
    }
  };
}

function emptyJsonSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {}
  };
}
