# V2 Roadmap

## Implemented In This Pass

- OpenRouter live provider with reasoning enabled and preserved `reasoning_details` for structured retry calls.
- Stage-specific model routing:
  - `openai/gpt-5.4-mini` for default, intent, strategy, and scoring in fast mode.
  - `openai/gpt-5.5` for synthesis and adjudication.
  - Balanced mode uses `~openai/gpt-mini-latest` for intent/strategy, `~google/gemini-flash-latest` for scoring, and `openai/gpt-5.5` for synthesis.
  - Quality mode escalates strategy and scoring to `openai/gpt-5.5`.
- Frontend fast/balanced/quality mode control persisted in browser local storage.
- Document, chunk, claim, and semantic duplicate-level detection.
- Jensen-Shannon novelty/divergence trace metadata.
- Bayesian source reliability with deterministic source-type priors and source/domain updates.
- SQLite persistence through `node:sqlite` when available, with in-memory fallback.
- LLM answer synthesis and adjudicator hooks for the comparison harness.
- Stage 5.5 deterministic pre-ranking before LLM scoring, including exact duplicate grouping and source/facet diversity.
- Evidence-gated retrieval repair with Stage 8.5 gap analysis, broadened repair rounds, a default four-round cap, and a repair time budget.
- Cautious synthesis review for weak evidence, including source-backed versus weak/model-prior notes.
- Redacted full run debug logs with SSE events, retrieval rounds, selected chunks, synthesis, provenance, gap analysis, and evidence health.
- Constrained `official_docs` source handler for high-quality official/public references without generic crawling.
- Live OpenAI, Claude, and Gemini provider-web-search opponents that stay separate from Agent Search.

## Still Future Work

- Stronger uncapped "until strong" adaptive retrieval mode beyond the current repair-round and time budgets.
- Correlated-source and syndication-aware reliability updates.
- Primary-source override logic in reliability updates beyond current static priors.
- Optional merged cluster synthesis after deduplication.
- Learned domain-specific duplicate classifiers.
- Stateful user memory, outside the stateless search-engine contract.
- Production cache infrastructure.
- Production observability.
- Rate-limit-aware source queues and per-source backoff.
- Gated source registry extension for open-source contributors.
- Additional live opponent integrations and benchmark-post data import workflow.
