import { createAgentSearchToolSuite, defineAgentSearchConfig } from "@agent-search/sdk";

export const agentSearch = createAgentSearchToolSuite(
  defineAgentSearchConfig({
    defaultRequest: {
      quality_mode: "balanced",
      token_budget: 4000,
      synthesize_answer: true
    }
  })
);

export const tools = agentSearch.tools;
