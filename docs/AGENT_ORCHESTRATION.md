# Agent Orchestration

This project is built under the "Search Engine for LLMs -- Build Sheet" contract.

## Final Integration Status

- Orchestrator completed and integrated the MVP after parallel workers timed out.
- `corepack pnpm test` passed: 12 test files, 24 tests.
- `corepack pnpm build` passed, including the Next.js `/compare` route.
- Gold artifact is present at `packages/eval/gold/gold-answers.json`.
- Opponent integrations are fixture/manual/missing by default; missing opponents are labeled and not scored as valid answers.

## Agent Roster

| Agent | Responsibility | Deliverables | Owned Files | Dependencies | Status | Blockers | Integration Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Orchestrator | Plan, serialize shared contracts, integrate, test, docs | Working MVP and final build report | Cross-cutting integration files | User build sheet | In Progress | None | Empty repo bootstrapped as TypeScript pnpm workspace |
| Agent 0 Repo Auditor + Bootstrap | Repo audit, workspace setup, coordination docs | Root config, docs | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `docs/**` | None | In Progress | `pnpm` not installed on PATH yet | Orchestrator performed initial audit |
| Agent 1 Schema + Contracts | Shared schemas/types/constants | Zod schemas and interface docs | `packages/shared/**`, `docs/INTERFACES.md` | Bootstrap | Not Started | None | Shared schemas gate all downstream work |
| Agent 2A Encyclopedic + Structured | Wikipedia, Wikidata handlers | Source adapters and tests | `packages/sources/src/wikipedia.ts`, `packages/sources/src/wikidata.ts` | Shared schemas, source interface | Not Started | None | Must use mocked fetch in default tests |
| Agent 2B Academic | arXiv, Semantic Scholar, OpenAlex, CrossRef | Source adapters and tests | `packages/sources/src/arxiv.ts`, `packages/sources/src/semanticScholar.ts`, `packages/sources/src/openAlex.ts`, `packages/sources/src/crossref.ts` | Shared schemas, source interface | Not Started | None | XML parsing must be bounded and graceful |
| Agent 2C Medical + OA | PubMed, CORE | Source adapters and tests | `packages/sources/src/pubmed.ts`, `packages/sources/src/core.ts` | Shared schemas, source interface | Not Started | None | CORE disabled without `CORE_API_KEY` |
| Agent 2D Technical + Code | Stack Exchange, HN Algolia, GitHub | Source adapters and tests | `packages/sources/src/stackExchange.ts`, `packages/sources/src/hackerNews.ts`, `packages/sources/src/github.ts` | Shared schemas, source interface | Not Started | None | GitHub token optional |
| Agent 2E Filing + Government | SEC EDGAR, data.gov | Source adapters and tests | `packages/sources/src/secEdgar.ts`, `packages/sources/src/dataGov.ts` | Shared schemas, source interface | Not Started | None | SEC requires explicit user agent for live calls |
| Agent 2F Source Registry | Handler interface, registry, fetch utilities | Registry and utilities | `packages/sources/src/SourceHandler.ts`, `packages/sources/src/registry.ts`, `packages/sources/src/utils/**` | Shared schemas | Not Started | None | Router imports only registry |
| Agent 3 LLM Structured Prompt | Provider abstraction and stages 1/2/6 | Structured calls, prompts, mock provider | `packages/llm/**`, `packages/core/src/stage1Intent.ts`, `packages/core/src/stage2Strategy.ts`, `packages/core/src/stage6Score.ts` | Shared schemas | Not Started | None | Must retry invalid structured output |
| Agent 4 Router + Normalizer | Stages 3 and 5 | Router, text cleanup, chunking | `packages/core/src/stage3Router.ts`, `packages/core/src/stage5Normalize.ts` | Sources, shared schemas | Not Started | None | Partial source failures are normal |
| Agent 5 Embedding + Dedup | Local embeddings and stage 7 | Cosine clustering, dedup tests | `packages/embeddings/**`, `packages/core/src/stage7Dedup.ts` | Shared schemas | Not Started | None | V2 novelty notes required |
| Agent 6 Final Assembler | Stage 8 greedy selection | Budgeted assembler and tests | `packages/core/src/stage8Assemble.ts` | Shared schemas, dedup output | Not Started | None | Selection/rejection trace required |
| Agent 7 Pipeline + API + CLI | Pipeline, Fastify API, CLI search | Runnable API and CLI | `packages/core/src/pipeline/runPipeline.ts`, `packages/core/src/trace.ts`, `packages/core/src/errors.ts`, `apps/api/**`, `packages/cli/src/search.ts` | Stages 1-8 | Not Started | None | Mock mode must run end to end |
| Agent 8 Gold QA + Eval | Gold ingestion/scoring/comparison | Gold schema, parser, scorer, compare CLI | `packages/eval/**`, `packages/cli/src/compare.ts`, `docs/GOLD_QUALITY_GATE.md` | Shared schemas, pipeline response | Not Started | Gold content provided in prompt | No fake wins; score status explicit |
| Agent 9 Frontend | Next.js comparison page | `/compare` UI and live query form | `apps/web/**` | API/eval result shapes | Not Started | None | Frontend imports shared-facing types only |
| Agent 10 QA + Security + Docs | QA pass, docs, env | README, runbook, env, roadmap | `README.md`, `.env.example`, `docs/RUNBOOK.md`, `docs/V2_ROADMAP.md`, tests coordinated | Integrated build | Not Started | None | Final limitations must be honest |

## Operating Rules

- Shared schemas are serialized through Agent 1 / Orchestrator.
- Source handlers conform to `SourceHandler` and never invent result shapes.
- Frontend consumes API/eval shapes and does not define new pipeline contracts.
- Evaluation scoring is blocked unless the gold artifact validates.
- All source failures are normalized into traceable errors.
