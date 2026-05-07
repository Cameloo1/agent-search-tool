# @agent-search/adapters

Framework adapter helpers for Agent Search tool suites.

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { toOpenAIAgentsTools, toLangChainTools, toVercelAITools } from "@agent-search/adapters";

const suite = createAgentSearchToolSuite(config);

const openAiTools = toOpenAIAgentsTools(suite);
const langChainTools = toLangChainTools(suite);
const vercelTools = toVercelAITools(suite);
```

The adapters intentionally avoid hard runtime dependencies on agent frameworks.
