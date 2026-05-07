# @agent-search/sdk

Drop-in SDK for registering Agent Search as a dedicated evidence/research tool inside an agent app.

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";

const suite = createAgentSearchToolSuite({
  defaultRequest: { quality_mode: "balanced", token_budget: 4000 }
});

registry.tools.push(...suite.tools);
```

Use `defineSourcePlugin` for trusted local source plugins.
