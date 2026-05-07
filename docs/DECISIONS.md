# Decisions

## Stack

- Use TypeScript as the single core backend language.
- Use a pnpm workspace with `apps/*` and `packages/*`.
- Use Zod for validation and Vitest for tests.
- Use Node 20+ runtime semantics; local machine currently reports Node `v24.15.0`.

## API Framework

- Use Fastify for the API because the MVP needs small, typed JSON endpoints with low ceremony.

## LLM Provider Abstraction

- Core stages call a provider interface through `structuredCall`.
- Mock provider is the default for tests and local smoke runs.
- Live providers are isolated behind fetch-based adapters so core pipeline code does not depend on SDK-specific behavior.
- OpenRouter is supported through the chat completions API with reasoning enabled and preserved `reasoning_details` on schema-repair retries.
- Stage-specific model routing uses `openai/gpt-5.4-mini` for default/intent/strategy/scoring in fast mode and `openai/gpt-5.5` for synthesis/adjudication. Balanced mode is a separate lightweight profile using GPT Mini Latest for intent/strategy, Gemini Flash Latest for scoring, Gemini Pro Latest for synthesis, and `openai/gpt-5.5` for adjudication. Quality mode escalates strategy and scoring to `openai/gpt-5.5`.

## Embedding Strategy

- Day 1 dedup uses local, deterministic embedding vectors plus cosine clustering so tests and mock runs never call paid APIs.
- The interface is intentionally swappable for `all-MiniLM-L6-v2` or `BGE-small-en-v1.5`.
- V2 adds document, chunk, claim, and semantic duplicate levels plus Jensen-Shannon novelty trace metrics. Merged cluster synthesis remains future work.

## Source Handler Strategy

- Use only the Day 1 allowlist.
- Each handler calls a public API endpoint and maps results to `RawItem`.
- Handlers normalize errors and never throw uncaught exceptions into the router.
- CORE disables itself if `CORE_API_KEY` is missing.
- SEC EDGAR live calls require `SEC_USER_AGENT`.
- V2 adds `official_docs`, a constrained curated official-document handler for SEC, EIA, BLS, Treasury, Federal Reserve, CBO, OWASP, NIST/CISA, and selected exchange documentation. It is still a gated source, not generic web crawling.

## Frontend Strategy

- Use Next.js App Router for `/compare`.
- Keep the UI direct: side-by-side result columns, score/status badges, source lists, trace summaries, and a live query box.
- The frontend does not invent schemas; it consumes API/eval response shapes.
- The live query form includes a persisted fast/balanced/quality segmented control in browser local storage. Fast mode leaves synthesis off by default; balanced and quality modes enable it by default.
- The web UI uses `POST /search/stream` for live queries so query/context stay in the request body while progress is visible. Blocking `POST /search` remains the stable non-streaming API.

## Gold Quality Gate

- The gold answer artifact provided in the prompt is treated as the benchmark source of truth.
- Comparisons are only valid when gold JSON validates.
- Scoring is claim-level and source-type-aware, not prose similarity.

## V2 Implementation Decisions

- Source reliability uses source-type priors with Bayesian alpha/beta updates by source and inferred domain. It persists with `node:sqlite` when available and falls back to in-memory storage otherwise.
- Evidence health is diagnostic and additive. Gold benchmark scoring remains gold-only; ad-hoc queries show evidence coverage/quality instead of fabricated facts-hit metrics.
- Trace records model usage, model escalation, deduplication clusters, JS divergence, evidence health, and source reliability effects through adjusted source weights.
- Evidence-gated retrieval now pre-ranks chunks before LLM scoring, then runs up to four targeted/broadened repair rounds by default when evidence is insufficient, required source types are missing, or selected context is keyword-adjacent.
- Weak evidence synthesis is reviewed by a second structured LLM call when enabled; citations remain limited to retrieved chunks and gaps are labeled explicitly.
- Provider-web-search opponents are separate live comparison baselines and never call the Agent Search pipeline.

## Remaining Deferrals

- Stateful user memory.
- Production cache infrastructure.
- Production observability.
- Rate-limit-aware queues.
- General source registry extension.
- Correlated-source/syndication-aware reliability updates.
- Merged duplicate-cluster synthesis.
