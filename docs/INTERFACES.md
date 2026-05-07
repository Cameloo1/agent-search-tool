# Interfaces

This document is the implementation contract for the Day 1 MVP. TypeScript/Zod definitions live in `packages/shared/src`.

## Source IDs

Built-in source names are:

`wikipedia`, `arxiv`, `semantic_scholar`, `pubmed`, `openalex`, `core`, `crossref`, `stack_exchange`, `hacker_news`, `github`, `wikidata`, `sec_edgar`, `data_gov`, `official_docs`.

Third-party source plugins may add source ids matching `^[a-z][a-z0-9_:-]{1,63}$`. Built-in source ids remain valid and cannot be spoofed by plugins unless a host explicitly opts into overriding.

## IntentObject

- `core_intent: string`
- `query_type: ("multi-hop" | "fresh-fact" | "source-attribution" | "adversarial" | "dedup-prone" | "cultural" | "academic")[]`
- `entities: string[]`
- `temporal_constraints: string | null`
- `required_source_types: ("academic" | "news" | "primary-document" | "encyclopedic" | "forum" | "code" | "filing" | "government" | "medical")[]`

## SubQuery

- `sub_query: string`
- `target_sources: SourceName[]`
- `retrieval_intent: "primary_evidence" | "corroborating" | "contrarian" | "definitional" | "temporal"`
- `max_results: number` from 1 through 10

## RawItem

- `id: string`
- `source: SourceName`
- `source_type: "academic" | "encyclopedic" | "filing" | "forum" | "code" | "government" | "medical" | "structured_fact" | "tech_discussion" | "other"`
- `url: string`
- `title: string | null`
- `author: string | null`
- `publish_date: string | null`
- `text: string`
- `summary: string | null`
- `metadata: Record<string, unknown>`

## SourceError

- `code: string`
- `message: string`
- `retryable: boolean`

## SourceFetchResult

- Success: `{ source, ok: true, items, error: null, timing_ms }`
- Failure: `{ source, ok: false, items: [], error, timing_ms }`

## FetchOptions

- `timeoutMs: number`
- `maxResults: number`
- `apiKeys?: { core?: string; github?: string }`
- `secUserAgent?: string`
- `signal?: AbortSignal`

## NormalizedChunk

- `id: string`
- `content: string`
- `metadata.url`
- `metadata.source_name`
- `metadata.source_type`
- `metadata.title`
- `metadata.publish_date`
- `metadata.author`
- `metadata.confidence_score`
- `metadata.summary`
- `metadata.claim_graph`
- `metadata.epistemic_stance`
- `metadata.surprise_score`
- `_internal.relevance_to_query`
- `_internal.source_weight`
- `_internal.freshness_fitness`
- `_internal.embedding`

Embeddings are internal and omitted from API responses unless debug internals are enabled.

## PipelineRequest

- `query: string`
- `chat_history?: { role: "user" | "assistant" | "system"; content: string }[]`
- `memory_snippet?: string`
- `token_budget?: number`
- `quality_mode?: "fast" | "balanced" | "quality"`
- `synthesize_answer?: boolean`
- `debug?: boolean`

If `synthesize_answer` is omitted, the backend defaults it to `true` for balanced and quality modes and `false` for fast mode.

## EvidenceHealth

- `status: "strong" | "adequate" | "weak" | "insufficient"`
- `evidence_quality_score: number` from 0 through 100
- `evidence_coverage_score: number` from 0 through 100
- `components.relevance_confidence`
- `components.source_authority`
- `components.coverage_diversity`
- `components.freshness_failure`
- `reasons: string[]`
- `warnings: string[]`
- `details` with selected chunk/claim counts, source diversity, primary-source count, source failures, averages, non-redundancy, matched/missing required source types, and failed important sources

Evidence health is diagnostic. It is not a replacement for gold benchmark scoring.

## PipelineResponse

- `query`
- `intent`
- `sub_queries_executed`
- `chunks`
- `synthesized_answer?: string`
- `evidence_health?: EvidenceHealth`
- `trace`

## Trace

- `request_id`
- `started_at`
- `finished_at`
- `stage_timings_ms`
- `source_results`
- `errors`
- `warnings`
- `evidence_health`
- `counts`
- `selection`

Trace must expose sources queried, failures, selected chunks, rejected chunks, timings, counts, and selection reasons.

## PipelineProgressEvent

`POST /search/stream` emits SSE-formatted events over a fetch stream:

- `stage_start`
- `stage_complete`
- `stage_error`
- `source_start`
- `source_complete`
- `counts`
- `final`
- `fatal`

The stream keeps no server-side job state. Client disconnects abort source and LLM fetches through `AbortSignal` where supported.

## SourceHandler

```ts
interface SourceHandler {
  name: SourceName;
  fetch(subQuery: SubQuery, options: FetchOptions): Promise<SourceFetchResult>;
}
```

Handlers swallow exceptions and return `SourceFetchResult` failures.

## SourcePlugin

Trusted local source plugins use a TypeScript manifest plus handlers:

```ts
interface SourcePluginManifest {
  id: SourceName;
  version: string;
  entrypoint: string;
  compatibility: string;
  sources: SourceDescriptor[];
  env: { name: string; required?: boolean; description?: string }[];
  permissions: { network: string[]; filesystem: string[] };
}
```

V1 plugins may add source handlers only. They cannot replace scoring, reliability, synthesis, or trace semantics.

## LLMProvider

```ts
interface LLMProvider {
  name: string;
  generateStructured<T>(input: StructuredLLMInput): Promise<unknown>;
}
```

`structuredCall` validates provider output with Zod and retries on invalid output.

## Embedder

```ts
interface Embedder {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

Day 1 implementation is local and free. Cosine clustering is the stable dedup implementation.

## GoldQuestion / GoldAnswer

Gold artifacts contain locked question IDs, prompts, gold answers, atomic facts, required source types, penalties, methodology notes, and category metadata. Scoring is invalid unless the artifact validates.

## EvaluationResult

Includes facts hit, required source-type coverage, primary source count, hallucination flags, unsourced claims, token count, time to result, notes, and score status.

## OpponentResultFixture

Imported/manual opponent outputs include engine name, question ID, answer, cited sources, provenance labels, token count, time to result, mode (`live`, `imported`, `manual`, `missing`), and optional notes.
