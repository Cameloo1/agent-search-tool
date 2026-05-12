# Adding Custom Sources

This guide explains how to add your own evidence source, prepare source records before the parser, and connect the source to the Agent Search engine.

Agent Search treats sources as trusted evidence providers. A source can be a public API, a private document system, a database, a file-backed corpus, or a domain-specific search service. The source does not replace scoring, reliability, synthesis, deduplication, or trace behavior. It only provides candidate evidence.

## Mental Model

The source path is:

```text
query
  -> source-aware planning
  -> source handler fetch
  -> optional extraction and document deepening
  -> normalization into chunks
  -> pre-rank, score, deduplicate, assemble, synthesize
```

Your source enters at the handler stage. The handler returns `RawItem` records. After that, the engine decides how to extract, normalize, score, and select evidence.

## 1. Write A Source Handler

A source handler has one job: turn a planned sub-query into a valid `SourceFetchResult`.

```ts
import { defineSourcePlugin, type SourceHandler } from "@agent-search/sdk";

const companyDocsHandler: SourceHandler = {
  name: "company_docs",
  async fetch(subQuery, options) {
    const started = Date.now();

    try {
      const items = [
        {
          id: `company_docs:${encodeURIComponent(subQuery.sub_query).slice(0, 48)}`,
          source: "company_docs",
          source_type: "other",
          url: "https://docs.example.com/research",
          title: "Company research result",
          author: null,
          publish_date: null,
          text: "Replace this with retrieved evidence text.",
          summary: null,
          metadata: { plugin_id: "company_docs" }
        }
      ];

      return {
        source: "company_docs",
        ok: true,
        items,
        error: null,
        timing_ms: Date.now() - started
      };
    } catch (error) {
      return {
        source: "company_docs",
        ok: false,
        items: [],
        error: {
          code: "COMPANY_DOCS_FETCH_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          category: "unknown"
        },
        timing_ms: Date.now() - started
      };
    }
  }
};
```

Keep the returned records boring and precise. `url` must be a valid URL. `publish_date` must be an ISO datetime or `null`. `source_type` should describe the evidence, not the transport. For example, use `medical` for clinical evidence, `government` for public agency data, `filing` for SEC material, `academic` for papers, `code` for repositories, and `other` when no stronger category fits.

## 2. Add A Plugin Manifest

Wrap the handler in a trusted local source plugin.

```ts
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
        description: "Trusted internal research documents."
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

Source ids must match `^[a-z][a-z0-9_:-]{1,63}$`. Do not reuse built-in ids such as `github`, `wikipedia`, `pubmed`, `sec_edgar`, or `official_docs`. Built-in sources cannot be spoofed by plugins.

## 3. Hook Up Pre-Parsing

There is not a separate pre-parser plugin hook today. The practical pre-parser step lives inside your source handler, before it returns `RawItem` records.

Use this step to:

- query your API, database, filesystem, or search index
- parse source-specific result shapes into plain evidence records
- remove boilerplate, navigation text, or duplicated snippets
- put full useful evidence in `text`
- put short abstracts or snippets in `summary`
- preserve source-native ids, scores, section names, or document metadata in `metadata`

If your source already gives full text, return that text directly. The extraction stage will usually treat long structured text as enough evidence and avoid unnecessary deepening.

If your source only gives thin snippets but has useful canonical URLs, return the best URL you have. Stage 4 can fetch HTML or PDF, extract readable text, attach extraction metadata, and then pass the deeper evidence to normalization.

If your source is private, already fully parsed, or should not be fetched again, connect the engine with extraction disabled:

```ts
pipelineOptions: {
  enableExtraction: false
}
```

## 4. Connect Through The SDK

The SDK path is the normal host-app integration.

```ts
import { createAgentSearchToolSuite } from "@agent-search/sdk";
import { companyDocsPlugin } from "./companyDocsPlugin";

const suite = createAgentSearchToolSuite({
  sourcePlugins: [companyDocsPlugin],
  defaultRequest: {
    quality_mode: "balanced",
    token_budget: 4000,
    synthesize_answer: true
  }
});

const result = await suite.tools[0].execute({
  query: "What does our internal research say about this?",
  sources: ["company_docs"]
});
```

Passing `sources` constrains the run to the registered source ids. Without it, Stage 2 can still choose custom sources when their descriptors are available and relevant.

## 5. Connect Directly To The Engine

Use direct engine wiring when you are not using the SDK tool suite.

```ts
import { runPipeline } from "@agent-search/core";

const response = await runPipeline(
  {
    query: "What does company research say?",
    quality_mode: "balanced",
    synthesize_answer: true
  },
  {
    sourceHandlers: {
      company_docs: companyDocsHandler
    },
    sourceDescriptors: [
      {
        id: "company_docs",
        label: "Company Docs",
        source_type: "other",
        description: "Trusted internal research documents."
      }
    ],
    preferredSourceIds: ["company_docs"]
  }
);
```

`sourceHandlers` gives Stage 3 something to call. `sourceDescriptors` tells Stage 2 that the source exists and what it is good for. `preferredSourceIds` is optional, but useful when you want a run to target your source intentionally.

## API Note

The built-in Fastify API currently uses the built-in pipeline configuration from environment variables. It does not dynamically load arbitrary plugin modules from API requests. For custom sources today, use the SDK from the host app or call `runPipeline` directly with `sourceHandlers` and `sourceDescriptors`.

## Validation Checklist

- The handler returns valid `SourceFetchResult` objects for both success and failure.
- Every item has a stable `id`, valid `url`, accurate `source`, accurate `source_type`, and useful `text`.
- Missing credentials return a non-retryable `missing_config` failure.
- Rate limits return a retryable `rate_limited` failure.
- Private or already parsed sources disable extraction if refetching would be wrong.
- A smoke query returns selected evidence with your `source_name`.
- `agent_search_plugin_doctor` reports the plugin as registered and calls out any missing required env vars.

## What Not To Do

- Do not put final answers in the source handler. Return evidence, not conclusions.
- Do not hide source failures. Return structured failures so trace and source health stay honest.
- Do not overload `source_type`; it affects source weighting and evidence health.
- Do not use custom sources to bypass scoring, reliability, or synthesis review.
- Do not depend on private credentials being present without declaring them in the manifest.
