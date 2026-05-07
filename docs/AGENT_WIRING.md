# Agent Wiring Guide

Agent Search is packaged as a dedicated, embeddable research tool for engineers building their own agents. It is not MCP-first. The intended v1 integration is a local TypeScript module that a host app registers in its own agent/tool registry.

## Install Shapes

### NPM-style workspace install

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { toOpenAIAgentsTools } from "@agent-search/adapters";

const suite = createAgentSearchToolSuite({
  defaultRequest: { quality_mode: "balanced", token_budget: 4000 }
});

export const tools = toOpenAIAgentsTools(suite);
```

### Clone/drop-in install

1. Clone or vendor this repo into the host app, for example `vendor/agent-search-tool`.
2. Add the packages to the host workspace or import from the vendored package path.
3. Register `createAgentSearchToolSuite(config).tools` with the host agent registry.
4. Keep the compare web app as a local devtool for inspecting traces, sources, and answer quality.

## Registry Contract

The main entrypoint is:

```ts
import { createAgentSearchTool, createAgentSearchToolSuite, agentSearchPlugin } from "@agent-search/sdk";

const searchTool = createAgentSearchTool(config);
const suite = createAgentSearchToolSuite(config);
const plugin = agentSearchPlugin(config);
```

Use `createAgentSearchTool` when the host registry wants one callable tool. Use `createAgentSearchToolSuite` when the agent should also inspect traces, sources, source health, costs, and plugin readiness. Use `agentSearchPlugin` when the host app has a richer plugin registry object.

## Tool Suite

- `agent_search`: direct answer with inline citations, selected evidence, confidence, and compact trace.
- `agent_search_evidence`: selected evidence packet without forced synthesis.
- `agent_search_trace`: inspect a previous run trace by request id.
- `agent_search_sources`: list registered source ids and capabilities.
- `agent_search_source_health`: summarize source readiness and recent failures.
- `agent_search_cost`: return token, cost, and runtime metadata for a previous run.
- `agent_search_plugin_doctor`: validate plugin config, source ids, handlers, and required env vars.

## Source Plugins

V1 plugins can add sources only. They cannot replace scoring, reliability, synthesis, or trace semantics.

```ts
import { defineSourcePlugin } from "@agent-search/sdk";

export const companyDocsPlugin = defineSourcePlugin({
  manifest: {
    id: "company_docs",
    version: "0.1.0",
    entrypoint: "./companyDocs.ts",
    sources: [
      {
        id: "company_docs",
        label: "Company Docs",
        source_type: "other",
        description: "Internal research documents."
      }
    ],
    env: [{ name: "COMPANY_DOCS_TOKEN", required: true }],
    permissions: { network: ["docs.example.com"], filesystem: [] }
  },
  handlers: {
    company_docs: companyDocsHandler
  }
});
```

Source ids must match `^[a-z][a-z0-9_:-]{1,63}$`. Built-in source ids cannot be spoofed by plugins. Plugin failures are visible and non-fatal.

## Adapter Use

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { toLangChainTools, toOpenAIAgentsTools, toVercelAITools } from "@agent-search/adapters";

const suite = createAgentSearchToolSuite(config);

export const openAiTools = toOpenAIAgentsTools(suite);
export const langChainTools = toLangChainTools(suite);
export const vercelTools = toVercelAITools(suite);
```

The adapters do not hard-depend on those frameworks. They return framework-shaped specs or accept the framework's own tool factory.

## Verification

For a host repo integration, run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Then run one local query through the host agent and inspect the returned `request_id`, selected evidence, and trace summary.
