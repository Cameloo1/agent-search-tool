# File Ownership

| Path/Glob | Owning Agent | Allowed Editors | Notes |
| --- | --- | --- | --- |
| `package.json` | Agent 0 | Orchestrator, Agent 0, Agent 10 | Dependency changes must be coordinated |
| `pnpm-workspace.yaml` | Agent 0 | Orchestrator, Agent 0 | Workspace root only |
| `tsconfig.base.json` | Agent 0 | Orchestrator, Agent 0 | Shared TS settings |
| `vitest.config.ts` | Agent 0 | Orchestrator, Agent 0, Agent 10 | Test include patterns only |
| `docs/AGENT_ORCHESTRATION.md` | Orchestrator | Orchestrator | Status and integration log |
| `docs/TASK_BOARD.md` | Orchestrator | Orchestrator | Updated before/after phases |
| `docs/FILE_OWNERSHIP.md` | Orchestrator | Orchestrator | No overlapping edits |
| `docs/INTERFACES.md` | Agent 1 | Orchestrator, Agent 1 | Mirrors shared schemas |
| `docs/DECISIONS.md` | Orchestrator | Orchestrator, Agent 0, Agent 10 | Major decisions only |
| `docs/TEST_MATRIX.md` | Agent 10 | Orchestrator, Agent 10 | Test tracking |
| `docs/GOLD_QUALITY_GATE.md` | Agent 8 | Orchestrator, Agent 8, Agent 10 | Gold scoring rules |
| `docs/RUNBOOK.md` | Agent 10 | Orchestrator, Agent 10 | Operational docs |
| `docs/V2_ROADMAP.md` | Agent 10 | Orchestrator, Agent 10 | Explicit deferrals |
| `packages/shared/**` | Agent 1 | Orchestrator, Agent 1 | Schema changes require coordination |
| `packages/sources/src/SourceHandler.ts` | Agent 2F | Orchestrator, Agent 2F | Handler contract |
| `packages/sources/src/registry.ts` | Agent 2F | Orchestrator, Agent 2F | Registry imports handlers |
| `packages/sources/src/utils/**` | Agent 2F | Orchestrator, Agent 2F | Timeout/error helpers |
| `packages/sources/src/wikipedia.ts` | Agent 2A | Orchestrator, Agent 2A | Wikipedia REST API only |
| `packages/sources/src/wikidata.ts` | Agent 2A | Orchestrator, Agent 2A | SPARQL API only |
| `packages/sources/src/arxiv.ts` | Agent 2B | Orchestrator, Agent 2B | arXiv API |
| `packages/sources/src/semanticScholar.ts` | Agent 2B | Orchestrator, Agent 2B | Semantic Scholar API |
| `packages/sources/src/openAlex.ts` | Agent 2B | Orchestrator, Agent 2B | OpenAlex API |
| `packages/sources/src/crossref.ts` | Agent 2B | Orchestrator, Agent 2B | CrossRef API |
| `packages/sources/src/pubmed.ts` | Agent 2C | Orchestrator, Agent 2C | PubMed API |
| `packages/sources/src/core.ts` | Agent 2C | Orchestrator, Agent 2C | Optional CORE key |
| `packages/sources/src/stackExchange.ts` | Agent 2D | Orchestrator, Agent 2D | Stack Exchange API |
| `packages/sources/src/hackerNews.ts` | Agent 2D | Orchestrator, Agent 2D | Algolia API |
| `packages/sources/src/github.ts` | Agent 2D | Orchestrator, Agent 2D | Public GitHub API |
| `packages/sources/src/secEdgar.ts` | Agent 2E | Orchestrator, Agent 2E | SEC user-agent required live |
| `packages/sources/src/dataGov.ts` | Agent 2E | Orchestrator, Agent 2E | catalog.data.gov API |
| `packages/llm/**` | Agent 3 | Orchestrator, Agent 3 | Structured call boundary |
| `packages/core/src/stage1Intent.ts` | Agent 3 | Orchestrator, Agent 3 | LLM stage |
| `packages/core/src/stage2Strategy.ts` | Agent 3 | Orchestrator, Agent 3 | LLM stage |
| `packages/core/src/stage6Score.ts` | Agent 3 | Orchestrator, Agent 3 | LLM stage |
| `packages/core/src/stage3Router.ts` | Agent 4 | Orchestrator, Agent 4 | Deterministic router |
| `packages/core/src/stage5Normalize.ts` | Agent 4 | Orchestrator, Agent 4 | Deterministic normalizer |
| `packages/embeddings/**` | Agent 5 | Orchestrator, Agent 5 | Local embedding abstraction |
| `packages/core/src/stage7Dedup.ts` | Agent 5 | Orchestrator, Agent 5 | Cosine dedup |
| `packages/core/src/stage8Assemble.ts` | Agent 6 | Orchestrator, Agent 6 | Greedy assembler |
| `packages/core/src/pipeline/**` | Agent 7 | Orchestrator, Agent 7 | Pipeline wiring |
| `packages/core/src/trace.ts` | Agent 7 | Orchestrator, Agent 7 | Trace utilities |
| `packages/core/src/errors.ts` | Agent 7 | Orchestrator, Agent 7 | Error helpers |
| `apps/api/**` | Agent 7 | Orchestrator, Agent 7 | Fastify API |
| `packages/cli/src/search.ts` | Agent 7 | Orchestrator, Agent 7 | CLI search |
| `packages/eval/**` | Agent 8 | Orchestrator, Agent 8 | Gold/eval harness |
| `packages/cli/src/compare.ts` | Agent 8 | Orchestrator, Agent 8 | CLI compare |
| `apps/web/**` | Agent 9 | Orchestrator, Agent 9 | Next.js UI |
| `README.md` | Agent 10 | Orchestrator, Agent 10 | Final user-facing docs |
| `.env.example` | Agent 10 | Orchestrator, Agent 10 | No secrets |

## Rules

- Agents may not edit outside their ownership area.
- Shared schema changes are serialized by the Orchestrator.
- Tests may be added in owned package trees; cross-package test edits require Orchestrator coordination.
- The Orchestrator integrates and may make final compatibility patches across owned files.
