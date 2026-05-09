# Agent Search Tool

[![Windows Build CI](https://github.com/Cameloo1/agent-search-tool/actions/workflows/windows-build.yml/badge.svg?branch=main)](https://github.com/Cameloo1/agent-search-tool/actions/workflows/windows-build.yml)
[![Windows Test CI](https://github.com/Cameloo1/agent-search-tool/actions/workflows/windows-test.yml/badge.svg?branch=main)](https://github.com/Cameloo1/agent-search-tool/actions/workflows/windows-test.yml)
[![ESLint](https://github.com/Cameloo1/agent-search-tool/actions/workflows/eslint.yml/badge.svg?branch=main)](https://github.com/Cameloo1/agent-search-tool/actions/workflows/eslint.yml)
[![Typechecking](https://github.com/Cameloo1/agent-search-tool/actions/workflows/typechecking.yml/badge.svg?branch=main)](https://github.com/Cameloo1/agent-search-tool/actions/workflows/typechecking.yml)
[![Automated Testing](https://github.com/Cameloo1/agent-search-tool/actions/workflows/automated-testing.yml/badge.svg?branch=main)](https://github.com/Cameloo1/agent-search-tool/actions/workflows/automated-testing.yml)

Agent Search is a source-gated evidence engine for AI applications and research agents. It turns a user query into planned source calls, extracted evidence, scored and deduplicated chunks, a cited synthesized answer, and a full trace of how the result was produced.

It can run as a local API + compare devtool, or be dropped into another TypeScript agent app as a registry-ready tool suite through `@agent-search/sdk`.

## Why It Exists

Most agent search integrations return web snippets or a black-box answer. Agent Search is designed for builders who need inspectable evidence:

- source-aware planning instead of generic crawling
- deterministic fallbacks when model calls fail
- extraction metadata and degraded-evidence handling
- pre-ranking, scoring, reliability, deduplication, and repair
- citations tied to selected chunks
- runtime, cost, source, and structured-call trace visibility
- a pluggable source registry for trusted local connectors

## What It Is Not

Agent Search is not a chatbot, SEO crawler, persistent memory system, or open-web scraper. Source handlers are explicit and gated. Third-party v1 plugins may add sources, but they do not replace scoring, reliability, synthesis, or trace semantics.

## Pipeline

```text
Query + optional context
  -> Stage 1 Intent decomposition
  -> Stage 2 Source-aware query strategy
  -> Stage 3 Source routing
  -> Stage 4 Fetch + extraction ladder
  -> Stage 5 Normalize evidence
  -> Stage 5.5 Deterministic pre-rank
  -> Stage 6 Quality/relevance scoring
  -> Stage 7 Deduplication
  -> Stage 8 Budgeted assembly
  -> Evidence health + repair + reviewed synthesis + trace
```

## Scoring Mechanism

Agent Search does not treat model confidence as the score. It uses a layered evidence scorer: deterministic source pre-rank, structured chunk scoring, extraction confidence ceilings, Bayesian-style source reliability, duplicate clustering, budgeted submodular selection, and evidence-health gates before synthesis.

At the center is a transparent scoring path:

```text
combined_score =
  relevance_to_query
  * source_weight
  * confidence_score
  * max(0.4, freshness_fitness)
```

That score is then constrained by extraction quality, source diversity, novelty, required-source coverage, and citation support. See [docs/SCORING_MECHANISM.md](docs/SCORING_MECHANISM.md) for the full math and pipeline details.

## Drop-In Agent Tool

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";

const suite = createAgentSearchToolSuite({
  defaultRequest: {
    quality_mode: "balanced",
    token_budget: 4000,
    synthesize_answer: true
  }
});

registry.tools.push(...suite.tools);
```

The suite exposes:

- `agent_search`
- `agent_search_evidence`
- `agent_search_trace`
- `agent_search_sources`
- `agent_search_source_health`
- `agent_search_cost`
- `agent_search_plugin_doctor`

Framework-shaped adapters are available in `@agent-search/adapters` for generic registries, OpenAI Agents-style tools, LangChain-style tools, and Vercel AI SDK-style tools.

See [docs/AGENT_WIRING.md](docs/AGENT_WIRING.md) for clone/drop-in wiring and source plugin authoring.

## Source Plugins

V1 source plugins are trusted local TypeScript manifest + handler modules:

```ts
import { defineSourcePlugin } from "@agent-search/sdk";

export const companyDocsPlugin = defineSourcePlugin({
  manifest: {
    id: "company_docs",
    version: "0.1.0",
    entrypoint: "./companyDocsPlugin.ts",
    sources: [
      {
        id: "company_docs",
        label: "Company Docs",
        source_type: "other",
        description: "Trusted local/company research documents."
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

Source ids must match `^[a-z][a-z0-9_:-]{1,63}$`. Built-in source ids remain valid and cannot be spoofed by plugins.

## Local Development

```powershell
corepack pnpm install
Copy-Item .env.example .env
corepack pnpm dev
```

Open:

- API: `http://localhost:3001`
- Compare/devtool UI: `http://localhost:3000/compare`

`corepack pnpm dev` starts both servers in one terminal and stops both with Ctrl+C.

## CLI

```powershell
corepack pnpm --filter @agent-search/cli exec agent-search plugins list
corepack pnpm --filter @agent-search/cli exec agent-search plugins doctor
corepack pnpm --filter @agent-search/cli exec agent-search search --quality=balanced "How should I evaluate an AI retrieval pipeline?"
```

Legacy convenience scripts are still available:

```powershell
corepack pnpm cli:search "How can I build a deduplication pipeline?"
corepack pnpm cli:compare
```

## API

`GET /health`

`POST /search`

```json
{
  "query": "How do institutions get market news quickly?",
  "chat_history": [],
  "memory_snippet": "optional per-query context",
  "token_budget": 1800,
  "quality_mode": "balanced",
  "synthesize_answer": true,
  "debug": false
}
```

`POST /search/stream` accepts the same body and returns SSE-formatted progress events plus a final response. Client disconnects abort in-flight source and LLM calls where supported.

Debug routes:

- `GET /debug/search/latest`
- `GET /debug/search/:request_id`
- `POST /debug/search/:request_id/feedback`

The debug payload includes redacted run records, events, retrieval rounds, selected chunks, synthesis review, evidence health, source results, costs, and trace summaries. Embeddings and secrets are not logged.

## Model Providers

Set `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in `.env` for OpenRouter-backed structured model calls. The local mock provider remains useful for tests and offline development.

Balanced mode is the main production-oriented path. Fast mode keeps synthesis off by default. Quality mode uses stronger reasoning/model settings where supported.

## Evaluation

The locked gold artifact lives at `packages/eval/gold/gold-answers.json`. Gold scoring validates facts hit, required source types, primary-source coverage, hallucination flags, unsourced claims, token count, and time to result. If the artifact is missing or invalid, scoring is blocked rather than faked.

Opponent comparison support includes ChatGPT search, Perplexity, Tavily API, Exa API, and vanilla Claude with web search as imported/manual/live fixtures. The `/compare` page also supports separate provider-web-search opponent buttons for OpenAI, Claude, and Gemini when keys are configured.

## Tests

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Default tests mock network fetches. Optional live source checks must be gated behind `LIVE_API_TESTS=1`.

## Repository Layout

```text
apps/api       Fastify API and debug routes
apps/web       Local compare/devtool UI
packages/core  Pipeline stages, scoring, synthesis, trace
packages/sdk   Drop-in tool suite and source plugin registry
packages/adapters Framework-shaped tool adapters
packages/sources Built-in source handlers and plugin runtime
packages/shared Zod schemas, types, constants
packages/eval  Gold artifacts and comparison scoring
packages/cli   CLI entrypoint
examples       Drop-in and adapter examples
docs           Architecture and wiring docs
```

## Known Limitations

- V1 plugins are trusted local code, not untrusted sandboxed extensions.
- No generic crawling is enabled by default.
- SEC EDGAR live calls require `SEC_USER_AGENT`.
- CORE is disabled unless `CORE_API_KEY` is present.
- Optional live APIs may rate-limit or fail; failures are visible in trace and do not silently become evidence.

## License

MIT
