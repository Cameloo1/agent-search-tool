import { describe, expect, it } from "vitest";
import type { SourceHandler } from "@agent-search/sources";
import { routeSources, summarizeSourceResults } from "./stage3Router.js";

describe("stage 3 router", () => {
  it("preserves partial results when one source fails", async () => {
    const okHandler: SourceHandler = {
      name: "wikipedia",
      async fetch() {
        return {
          source: "wikipedia",
          ok: true,
          items: [
            {
              id: "raw-1",
              source: "wikipedia",
              source_type: "encyclopedic",
              url: "https://en.wikipedia.org/wiki/Test",
              title: "Test",
              author: null,
              publish_date: null,
              text: "Useful content",
              summary: null,
              metadata: {}
            }
          ],
          error: null,
          timing_ms: 5
        };
      }
    };
    const failHandler: SourceHandler = {
      name: "github",
      async fetch() {
        return {
          source: "github",
          ok: false,
          items: [],
          error: { code: "BOOM", message: "failed", retryable: false },
          timing_ms: 2
        };
      }
    };

    const result = await routeSources(
      [
        {
          sub_query: "test",
          target_sources: ["wikipedia", "github"],
          retrieval_intent: "definitional",
          max_results: 2
        }
      ],
      { handlers: { wikipedia: okHandler, github: failHandler }, maxConcurrency: 2 }
    );

    expect(result.rawItems).toHaveLength(1);
    expect(result.fetchResults).toHaveLength(2);
    expect(summarizeSourceResults(result.fetchResults).github?.failed).toBe(1);
  });

  it("normalizes malformed source errors instead of crashing the route", async () => {
    const malformedHandler: SourceHandler = {
      name: "openalex",
      async fetch() {
        return {
          source: "openalex",
          ok: false,
          items: [],
          error: { code: 429, message: "rate limited", retryable: true },
          timing_ms: 3
        } as any;
      }
    };

    const result = await routeSources(
      [
        {
          sub_query: "rate limit test",
          target_sources: ["openalex"],
          retrieval_intent: "corroborating",
          max_results: 1
        }
      ],
      { handlers: { openalex: malformedHandler } }
    );

    expect(result.fetchResults[0]?.ok).toBe(false);
    expect(result.fetchResults[0]?.error?.code).toBe("429");
  });

  it("converts thrown handler failures into source fetch failures", async () => {
    const throwingHandler: SourceHandler = {
      name: "crossref",
      async fetch() {
        throw new Error("network unavailable");
      }
    };

    const result = await routeSources(
      [
        {
          sub_query: "throwing source",
          target_sources: ["crossref"],
          retrieval_intent: "corroborating",
          max_results: 1
        }
      ],
      { handlers: { crossref: throwingHandler } }
    );

    expect(result.fetchResults[0]?.ok).toBe(false);
    expect(result.fetchResults[0]?.error?.code).toBe("SOURCE_FETCH_EXCEPTION");
  });

  it("emits source progress events", async () => {
    const handler: SourceHandler = {
      name: "wikipedia",
      async fetch() {
        return { source: "wikipedia", ok: true, items: [], error: null, timing_ms: 1 };
      }
    };
    const events: string[] = [];

    await routeSources(
      [
        {
          sub_query: "progress",
          target_sources: ["wikipedia"],
          retrieval_intent: "definitional",
          max_results: 1
        }
      ],
      {
        handlers: { wikipedia: handler },
        onProgress(event) {
          events.push(event.type);
        }
      }
    );

    expect(events).toEqual(["source_start", "source_complete"]);
  });
});
