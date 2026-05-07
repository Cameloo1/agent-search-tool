import type { AgentSearchRegistryTool, AgentSearchToolSuite } from "@agent-search/sdk";

export interface OpenAIAgentsToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: AgentSearchRegistryTool["execute"];
}

export interface LangChainToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  func: AgentSearchRegistryTool["execute"];
}

export interface VercelAIToolSpec {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: AgentSearchRegistryTool["execute"];
}

export type OpenAIAgentsToolFactory<T> = (spec: OpenAIAgentsToolSpec) => T;
export type LangChainToolFactory<T> = (func: AgentSearchRegistryTool["execute"], options: Omit<LangChainToolSpec, "func">) => T;

export function toGenericRegistryTools(suiteOrTools: AgentSearchToolSuite | AgentSearchRegistryTool[]): AgentSearchRegistryTool[] {
  return Array.isArray(suiteOrTools) ? suiteOrTools : suiteOrTools.tools;
}

export function toOpenAIAgentsTools<T = OpenAIAgentsToolSpec>(
  suiteOrTools: AgentSearchToolSuite | AgentSearchRegistryTool[],
  factory?: OpenAIAgentsToolFactory<T>
): Array<T | OpenAIAgentsToolSpec> {
  return toGenericRegistryTools(suiteOrTools).map((tool) => {
    const spec: OpenAIAgentsToolSpec = {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: tool.execute
    };
    return factory ? factory(spec) : spec;
  });
}

export function toLangChainTools<T = LangChainToolSpec>(
  suiteOrTools: AgentSearchToolSuite | AgentSearchRegistryTool[],
  factory?: LangChainToolFactory<T>
): Array<T | LangChainToolSpec> {
  return toGenericRegistryTools(suiteOrTools).map((tool) => {
    const options = {
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema
    };
    return factory ? factory(tool.execute, options) : { ...options, func: tool.execute };
  });
}

export function toVercelAITools(suiteOrTools: AgentSearchToolSuite | AgentSearchRegistryTool[]): Record<string, VercelAIToolSpec> {
  return Object.fromEntries(
    toGenericRegistryTools(suiteOrTools).map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute
      }
    ])
  );
}

