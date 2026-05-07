# Test Matrix

| Area | Required Test | Status | Notes |
| --- | --- | --- | --- |
| Shared schemas | Valid/invalid Zod objects | Tested | `packages/shared/src/schemas.test.ts` |
| Source handlers | Mocked fetch success/failure per source | Tested | `packages/sources/src/sourceHandlers.test.ts` |
| Source query recovery | Over-specific data.gov commodity query broadens to useful public datasets | Tested | `packages/sources/src/sourceHandlers.test.ts` |
| Source failure handling | One failed source does not break router | Tested | `packages/core/src/stage3Router.test.ts`; malformed source errors and thrown handlers are normalized |
| LLM structured output | Mock provider valid output and retry fallback | Tested | `packages/llm/src/structuredCall.test.ts` |
| OpenRouter provider | Model selection, reasoning flag, response format, retry reasoning preservation | Tested | `packages/llm/src/openRouterProvider.test.ts`; live smoke run completed |
| Stage model routing | Fast/balanced/quality model decisions and escalation trace | Tested | `packages/core/src/modelRouting.test.ts`; API route smoke checks quality escalation and balanced defaults |
| Stage 1 fallback | Invalid LLM output produces safe intent and trace error | Tested | Covered through pipeline fallback paths and stage tests |
| Stage 2 allowlist | Invalid target sources rejected | Tested | Shared schema test |
| Router | Partial failure and concurrency limit behavior | Tested | Router partial failure test |
| Streaming search | POST fetch-stream progress/final events | Tested | `apps/api/src/routes/search.test.ts`; router progress events covered |
| Normalizer | RawItems become valid chunks; long text chunked | Tested | `packages/core/src/stage5Normalize.test.ts` |
| Stage 6 fallback | Invalid scoring output falls back without emptying all results | Tested | `packages/core/src/stage6Score.test.ts` |
| Dedup | Exact duplicates, near duplicates, non-duplicates, representative selection | Tested | `packages/core/src/stage7Dedup.test.ts`, embeddings tests; claim-level cluster trace covered |
| Dedup source diversity | Similar chunks from different source types are not over-collapsed by semantic dedup | Tested | `packages/core/src/stage7Dedup.test.ts` |
| Reliability | Bayesian priors, updates, selected-observation recording | Tested | `packages/core/src/reliabilityStore.test.ts` |
| Assembler | Token budget, query-type weighting, and required source-type coverage reserve | Tested | `packages/core/src/stage8Assemble.test.ts` |
| Pipeline | Mock smoke test returns valid `PipelineResponse` | Tested | `packages/core/src/pipeline/runPipeline.test.ts` |
| Evidence health | Strong/adequate/weak/insufficient formula, zero chunks, primary-source penalty, source-failure penalty | Tested | `packages/core/src/evidenceHealth.test.ts` |
| Optional synthesis | Balanced and quality modes default synthesis on | Tested | Pipeline and API smoke tests |
| Gold parser | Markdown/JSON validation | Tested | JSON load covered; markdown helper implemented |
| Gold scoring | Claim hits, source coverage, penalties | Tested | `packages/eval/src/scoreAgainstGold.test.ts` |
| Opponent fixtures | Fixture validation and missing/live/imported labels | Tested | Missing fixtures exercised by comparison smoke |
| API | `/health`, `/search`, `/compare` smoke | Tested | API tests cover health/search; compare CLI smoke covers harness |
| CLI | Search and compare smoke | Tested | `corepack pnpm --filter @agent-search/cli search ...`; OpenRouter live smoke completed |
| Frontend | `/compare` render where practical | Tested | `corepack pnpm build` generated `/compare` |
| Live API tests | Optional only with `LIVE_API_TESTS=1` | Manual | OpenRouter live CLI smoke ran with user approval; public sources showed expected rate-limit failures in trace |
