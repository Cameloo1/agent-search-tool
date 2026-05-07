import {
  ALLOWED_SOURCE_NAMES,
  SourceNameSchema,
  SourcePluginManifestSchema,
  type SourceDescriptor,
  type SourceName,
  type SourcePluginManifest
} from "@agent-search/shared";
import { sourceRegistry } from "./registry.js";
import type { SourceHandler } from "./SourceHandler.js";

export type SourcePluginHandler = SourceHandler;
export type { SourcePluginManifest } from "@agent-search/shared";

export interface SourcePluginContext {
  env: Record<string, string | undefined>;
  config: Record<string, unknown>;
  sourceId: SourceName;
  signal?: AbortSignal;
}

export interface SourcePluginDefinition {
  manifest: SourcePluginManifest;
  handlers: Record<string, SourcePluginHandler>;
}

export interface SourceRegistryBuildOptions {
  plugins?: SourcePluginDefinition[];
  extraHandlers?: Record<string, SourceHandler>;
  allowBuiltInOverride?: boolean;
}

export interface SourceRegistryBuildResult {
  handlers: Record<string, SourceHandler>;
  descriptors: SourceDescriptor[];
  diagnostics: SourcePluginDiagnostic[];
}

export interface SourcePluginDiagnostic {
  plugin_id?: string;
  source_id?: string;
  level: "ok" | "warning" | "error";
  code: string;
  message: string;
}

const BUILT_IN_SOURCE_SET = new Set<string>(ALLOWED_SOURCE_NAMES);

export function defineSourcePlugin(plugin: SourcePluginDefinition): SourcePluginDefinition {
  const manifest = SourcePluginManifestSchema.parse(plugin.manifest);
  return { manifest, handlers: plugin.handlers };
}

export function createSourceRegistry(options: SourceRegistryBuildOptions = {}): SourceRegistryBuildResult {
  const diagnostics: SourcePluginDiagnostic[] = [];
  const handlers: Record<string, SourceHandler> = { ...sourceRegistry, ...(options.extraHandlers ?? {}) };
  const descriptors: SourceDescriptor[] = ALLOWED_SOURCE_NAMES.map((id) => ({
    id,
    label: id,
    built_in: true
  }));

  for (const plugin of options.plugins ?? []) {
    const parsed = SourcePluginManifestSchema.safeParse(plugin.manifest);
    if (!parsed.success) {
      diagnostics.push({
        plugin_id: plugin.manifest?.id,
        level: "error",
        code: "PLUGIN_MANIFEST_INVALID",
        message: parsed.error.message
      });
      continue;
    }

    for (const source of parsed.data.sources) {
      const existing = handlers[source.id];
      const spoofingBuiltIn = BUILT_IN_SOURCE_SET.has(source.id);
      if (existing && (spoofingBuiltIn || !options.allowBuiltInOverride)) {
        diagnostics.push({
          plugin_id: parsed.data.id,
          source_id: source.id,
          level: "error",
          code: spoofingBuiltIn ? "PLUGIN_SOURCE_SPOOFS_BUILT_IN" : "PLUGIN_SOURCE_DUPLICATE",
          message: `Source plugin ${parsed.data.id} cannot register source ${source.id}.`
        });
        continue;
      }

      const handler = plugin.handlers[source.id];
      if (!handler) {
        diagnostics.push({
          plugin_id: parsed.data.id,
          source_id: source.id,
          level: "error",
          code: "PLUGIN_SOURCE_HANDLER_MISSING",
          message: `Source plugin ${parsed.data.id} did not provide a handler for ${source.id}.`
        });
        continue;
      }

      handlers[source.id] = handler;
      descriptors.push({ ...source, built_in: false });
      diagnostics.push({
        plugin_id: parsed.data.id,
        source_id: source.id,
        level: "ok",
        code: "PLUGIN_SOURCE_REGISTERED",
        message: `Registered source ${source.id} from plugin ${parsed.data.id}.`
      });
    }
  }

  return { handlers, descriptors, diagnostics };
}

export function validateSourceId(sourceId: string): SourceName {
  return SourceNameSchema.parse(sourceId);
}
