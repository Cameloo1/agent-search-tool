# Runbook

## Local Dev Startup

```powershell
corepack pnpm install
Copy-Item .env.example .env
corepack pnpm dev
```

API defaults to `http://localhost:3001`; web defaults to `http://localhost:3000/compare`. The bootstrap command streams API and web logs in one terminal and stops both servers with Ctrl+C.

## Mock Mode

Set `LLM_PROVIDER=mock`. The pipeline uses deterministic mock source items and a rule-based mock LLM provider. This is the default for tests and local smoke runs.

## Live Mode

Set `LLM_PROVIDER=openrouter` and provide `OPENROUTER_API_KEY` for the recommended V2 path. The API and CLI read the root `.env` even when commands are launched from workspace packages.

Stage defaults:

- `LLM_MODEL_DEFAULT=openai/gpt-5.4-mini`
- `LLM_MODEL_INTENT=openai/gpt-5.4-mini`
- `LLM_MODEL_STRATEGY=openai/gpt-5.4-mini`
- `LLM_MODEL_SCORING=openai/gpt-5.4-mini`
- `LLM_MODEL_SYNTHESIS=openai/gpt-5.5`
- `LLM_MODEL_ADJUDICATOR=openai/gpt-5.5`

Balanced mode has its own optional env prefix and does not change the original fast/quality profile:

- `LLM_MODEL_BALANCED_DEFAULT=~openai/gpt-mini-latest`
- `LLM_MODEL_BALANCED_INTENT=~openai/gpt-mini-latest`
- `LLM_MODEL_BALANCED_STRATEGY=~openai/gpt-mini-latest`
- `LLM_MODEL_BALANCED_SCORING=google/gemini-3.1-flash-lite`
- `LLM_MODEL_BALANCED_SYNTHESIS=openai/gpt-5.5`
- `LLM_MODEL_BALANCED_ADJUDICATOR=openai/gpt-5.5`

Quality mode escalates strategy and scoring to `openai/gpt-5.5`. Balanced mode uses the lightweight profile above without quality escalation. The `/compare` UI saves the fast/balanced/quality setting in browser local storage. Fast mode leaves answer synthesis off by default; balanced and quality modes turn it on by default. Gemma can be tested through manual balanced env overrides, but it is not the default because schema reliability is riskier. The CLI supports:

```powershell
corepack pnpm --filter @agent-search/cli search -- --provider=openrouter --quality=quality "your query"
corepack pnpm --filter @agent-search/cli search -- --provider=openrouter --quality=balanced "your query"
```

`LLM_PROVIDER=openai` and `LLM_PROVIDER=anthropic` are still supported provider modes when their keys are present. Live source handlers use only allowlisted public APIs. Optional keys:

- `CORE_API_KEY` enables CORE.
- `GITHUB_TOKEN` raises GitHub public API limits.
- `SEC_USER_AGENT` is required for SEC EDGAR live calls. Use a descriptive app/contact identity, for example `AgentSearchTool/0.1 (contact: your-email@example.com)`.
- `SEMANTIC_SCHOLAR_API_KEY` sends Semantic Scholar's `x-api-key` header and raises the effective rate limit for academic searches. `S2_API_KEY` is also accepted as a fallback env name.
- `MAX_REPAIR_ROUNDS` defaults to `4` and caps evidence-gated retrieval repair rounds.
- `REPAIR_TIME_BUDGET_MS` defaults to `120000` and caps total repair-loop time.
- `PRERANK_MAX_LLM_CHUNKS` defaults to `18` and limits how many pre-ranked chunks go to Stage 6 per round.

Provider-web-search opponents are separate from Agent Search. Configure `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` to enable the OpenAI, Claude, or Gemini opponent buttons on `/compare`. Missing keys show an unavailable opponent result rather than falling back to Agent Search.

## Troubleshooting Source Failures

Source failures are expected to be partial. Inspect `trace.source_results` and `trace.errors`. A failed source should not crash the pipeline.

The API also writes local redacted debug artifacts for each search run under `data/debug-runs/`. The latest run is available at `data/debug-runs/latest.json` and through `GET /debug/search/latest`; a specific run is available through `GET /debug/search/:request_id`. These debug records include request shape, SSE events, intent, executed subqueries, retrieval rounds, source outcomes, gap analysis, counts, evidence health, selected chunks, synthesized answer, reviewer notes, provenance summaries, and stage errors without API keys, embeddings, or environment secrets.

## Troubleshooting LLM Schema Failures

Structured LLM calls retry invalid output. If retries fail, the stage records a trace error and uses a deterministic fallback rather than crashing.

## Troubleshooting Gold Scoring

Validate `packages/eval/gold/gold-answers.json`. Missing or invalid gold answers mark scoring as blocked/unavailable. Custom queries are not benchmark scored.

## Troubleshooting Evidence Health

Ad-hoc queries show `evidence_health` instead of gold facts-hit scoring. `insufficient` means no selected chunks or evidence too thin for confident synthesis. `weak` often means the pipeline found relevant material but missed primary/required source types, had important source failures, or selected redundant evidence.

## Streaming Search

The web UI calls `POST /search/stream` with the same body as `/search`. It reads SSE-formatted events from the fetch response body. Canceling in the browser aborts the fetch; the API passes the abort signal through LLM and source fetches where supported. The blocking `POST /search` endpoint remains available for CLI and simple API clients.

## Interpreting Trace Output

Trace includes stage timings, source results, errors, warnings, raw/normalized/scored/filtered/deduped/selected counts, selected chunk IDs, rejected chunk IDs, and selection reasons.
V2 traces also include `model_usage`, `escalations`, `pre_rank`, `evidence_health`, `retrieval_rounds`, `gap_analysis`, optional `synthesis_review`, and deduplication cluster metadata with duplicate level, novelty score, and JS divergence. When evidence is weak, the pipeline can run targeted and then broadened repair rounds before synthesis. If it still cannot reach adequate evidence, the synthesis reviewer labels gaps and keyword-only context rather than fabricating source support.

## Reliability Store

Set `RELIABILITY_DB_PATH=./data/source-reliability.sqlite` to persist source reliability updates. On runtimes without `node:sqlite`, the pipeline falls back to an in-memory reliability store and continues running.
