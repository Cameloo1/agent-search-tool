import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { toLangChainTools } from "@agent-search/adapters";

const suite = createAgentSearchToolSuite({
  defaultRequest: { quality_mode: "balanced", token_budget: 4000 }
});

export const tools = toLangChainTools(suite);
