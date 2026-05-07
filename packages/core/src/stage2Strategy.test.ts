import { describe, expect, it } from "vitest";
import { createMockLLMProvider } from "@agent-search/llm";
import type { IntentObject } from "@agent-search/shared";
import { buildQueryStrategy, fallbackSubQueries } from "./stage2Strategy.js";

describe("stage 2 strategy", () => {
  it("coerces common off-allowlist source aliases into allowlisted handlers", async () => {
    const result = await buildQueryStrategy(
      { query: "when will oil prices come down" },
      oilIntent,
      createMockLLMProvider([
        {
          sub_queries: [
            {
              sub_query: "EIA crude oil price forecast Brent WTI",
              target_sources: ["EIA", "FRED", "Google Scholar", "Wikipedia"],
              retrieval_intent: "temporal",
              max_results: 5
            }
          ]
        }
      ])
    );

    expect(result.errors).toHaveLength(0);
    expect(result.subQueries[0]?.target_sources).toEqual(["data_gov", "semantic_scholar", "openalex", "wikipedia"]);
  });

  it("broadens stingy valid LLM strategies for short market queries", async () => {
    const result = await buildQueryStrategy(
      { query: "when will oil prices come down" },
      oilIntent,
      createMockLLMProvider({
        sub_queries: [
          {
            sub_query: "latest EIA crude oil price forecast",
            target_sources: ["data_gov"],
            retrieval_intent: "temporal",
            max_results: 3
          }
        ]
      })
    );

    const sourceFamilies = result.subQueries.flatMap((subQuery) => subQuery.target_sources);
    expect(sourceFamilies).toContain("data_gov");
    expect(sourceFamilies).toContain("wikipedia");
    expect(sourceFamilies).toContain("wikidata");
    expect(sourceFamilies).toContain("openalex");
    expect(result.subQueries.length).toBeGreaterThan(1);
  });

  it("normalizes a bare array strategy response without forcing an LLM retry", async () => {
    const provider = createMockLLMProvider([
      [
        {
          sub_query: "EIA crude oil price forecast Brent WTI",
          target_sources: ["data_gov"],
          retrieval_intent: "temporal",
          max_results: 5
        }
      ]
    ]);
    const result = await buildQueryStrategy({ query: "when will oil prices come down" }, oilIntent, provider);

    expect(result.errors).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
    expect(result.subQueries[0]?.sub_query).toContain("EIA");
    expect(result.structuredLlmCalls[0]?.ok).toBe(true);
  });

  it("keeps host-registered plugin sources when they are available and preferred", async () => {
    const result = await buildQueryStrategy(
      { query: "what do company docs say about model evals" },
      oilIntent,
      createMockLLMProvider({
        sub_queries: [
          {
            sub_query: "company model evaluation research notes",
            target_sources: ["company_docs"],
            retrieval_intent: "primary_evidence",
            max_results: 4
          }
        ]
      }),
      {
        sourceDescriptors: [{ id: "company_docs", label: "Company Docs", source_type: "other" }],
        preferredSourceIds: ["company_docs"]
      }
    );

    expect(result.subQueries[0]?.target_sources).toEqual(["company_docs"]);
  });

  it("routes oil fallback queries to non-filing evidence sources", () => {
    const subQueries = fallbackSubQueries("when will oil prices come down", oilIntent);
    const sources = subQueries.flatMap((subQuery) => subQuery.target_sources);

    expect(sources).toContain("wikipedia");
    expect(sources).toContain("data_gov");
    expect(sources).toContain("openalex");
    expect(subQueries[0]?.sub_query).toContain("Brent WTI");
    expect(subQueries.length).toBeGreaterThan(2);
  });
});

const oilIntent: IntentObject = {
  core_intent: "Find oil price outlook evidence",
  query_type: ["fresh-fact", "source-attribution"],
  entities: ["oil"],
  temporal_constraints: "current",
  required_source_types: ["government", "academic", "primary-document"]
};
