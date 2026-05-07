import { describe, expect, it } from "vitest";
import { NormalizedChunkSchema } from "@agent-search/shared";
import { normalizeRawItems } from "./stage5Normalize.js";

describe("stage 5 normalizer", () => {
  it("normalizes raw items into valid chunks", () => {
    const chunks = normalizeRawItems(
      [
        {
          id: "raw-1",
          source: "sec_edgar",
          source_type: "filing",
          url: "https://www.sec.gov/test",
          title: "10-K",
          author: "Example Inc.",
          publish_date: "2025-01-01T00:00:00.000Z",
          text: "<p>Revenue risk and liquidity disclosure.</p>",
          summary: null,
          metadata: {}
        }
      ],
      { targetMinTokens: 5, targetMaxTokens: 20 }
    );

    expect(chunks).toHaveLength(1);
    expect(() => NormalizedChunkSchema.parse(chunks[0])).not.toThrow();
    expect(chunks[0]?.metadata.epistemic_stance).toBe("primary_source");
  });

  it("chunks long content", () => {
    const sentence = "This paragraph explains market structure, direct feeds, latency, and risk controls.";
    const chunks = normalizeRawItems(
      [
        {
          id: "raw-2",
          source: "github",
          source_type: "code",
          url: "https://github.com/example/repo",
          title: "repo",
          author: "example",
          publish_date: null,
          text: Array.from({ length: 20 }, () => sentence).join(" "),
          summary: null,
          metadata: {}
        }
      ],
      { targetMinTokens: 15, targetMaxTokens: 35 }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves extraction metadata on normalized chunks", () => {
    const extraction = {
      canonical_url: "https://example.gov/report",
      document_type: "html",
      retrieval_method: "html_fetch",
      extraction_method: "readability_html",
      extraction_status: "full_text",
      extraction_confidence: 0.9,
      content_coverage: 0.85,
      section_path: [],
      attempts: []
    };
    const chunks = normalizeRawItems(
      [
        {
          id: "raw-extraction",
          source: "official_docs",
          source_type: "government",
          url: "https://example.gov/report",
          title: "Official report",
          author: null,
          publish_date: null,
          text: "Official extracted evidence supports the answer with enough detail.",
          summary: null,
          metadata: { extraction }
        }
      ],
      { targetMinTokens: 5, targetMaxTokens: 20 }
    );

    expect(chunks[0]?.metadata.extraction?.canonical_url).toBe("https://example.gov/report");
    expect(chunks[0]?.metadata.extraction?.extraction_status).toBe("full_text");
  });
});
