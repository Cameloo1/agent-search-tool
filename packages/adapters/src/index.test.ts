import { describe, expect, it } from "vitest";
import type { AgentSearchRegistryTool } from "@agent-search/sdk";
import { toGenericRegistryTools, toLangChainTools, toOpenAIAgentsTools, toVercelAITools } from "./index.js";

const tools: AgentSearchRegistryTool[] = [
  {
    name: "agent_search",
    description: "Search",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    execute: async (input) => ({ input })
  }
];

describe("agent search adapters", () => {
  it("returns generic tools unchanged", () => {
    expect(toGenericRegistryTools(tools)[0]?.name).toBe("agent_search");
  });

  it("maps tools to OpenAI Agents-style specs", () => {
    const [tool] = toOpenAIAgentsTools(tools);
    expect(tool).toMatchObject({ name: "agent_search", parameters: tools[0]?.inputSchema });
  });

  it("maps tools through a LangChain tool factory", () => {
    const [tool] = toLangChainTools(tools, (func, options) => ({ ...options, func, wrapped: true }));
    expect(tool).toMatchObject({ name: "agent_search", wrapped: true });
  });

  it("maps tools to Vercel AI SDK-style keyed tools", () => {
    const mapped = toVercelAITools(tools);
    expect(mapped.agent_search?.inputSchema).toEqual(tools[0]?.inputSchema);
  });
});

