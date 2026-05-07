import { describe, expect, it } from "vitest";
import { MockEmbedder } from "@agent-search/embeddings";
import type { NormalizedChunk } from "@agent-search/shared";
import { deduplicateChunks } from "./stage7Dedup.js";

function chunk(id: string, content: string, score: number): NormalizedChunk {
  return {
    id,
    content,
    metadata: {
      url: `https://example.com/${id}`,
      source_name: score > 0.8 ? "sec_edgar" : "wikipedia",
      source_type: score > 0.8 ? "filing" : "encyclopedic",
      title: id,
      publish_date: null,
      author: null,
      confidence_score: score,
      summary: null,
      claim_graph: [{ claim: content, claim_type: "asserted", supporting_text_offset: [0, content.length] }],
      epistemic_stance: score > 0.8 ? "primary_source" : "tertiary_summary",
      surprise_score: 0.5
    },
    _internal: {
      relevance_to_query: score,
      source_weight: score,
      freshness_fitness: score,
      embedding: []
    }
  };
}

describe("stage 7 dedup", () => {
  it("clusters exact duplicates and chooses the strongest representative", async () => {
    const result = await deduplicateChunks(
      [
        chunk("weak", "same content about debt interest costs", 0.5),
        chunk("strong", "same content about debt interest costs", 0.95)
      ],
      new MockEmbedder(),
      { threshold: 0.9 }
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.id).toBe("strong");
    expect(result.rejectedChunkIds).toContain("weak");
    expect(result.chunks[0]?._internal.embedding).toEqual([]);
  });

  it("keeps non-duplicates", async () => {
    const result = await deduplicateChunks(
      [
        chunk("a", "market crash liquidity leverage central bank policy", 0.8),
        chunk("b", "application security webhook signature secret scanning", 0.8)
      ],
      new MockEmbedder(),
      { threshold: 0.85 }
    );

    expect(result.chunks).toHaveLength(2);
  });

  it("does not over-collapse merely similar chunks across source types", async () => {
    const government = chunk("government", "crude oil prices supply demand forecast inventory", 0.72);
    government.metadata.claim_graph = [
      { claim: "Official weekly petroleum data tracks inventories.", claim_type: "asserted", supporting_text_offset: [0, 40] }
    ];
    government.metadata.source_name = "data_gov";
    government.metadata.source_type = "government";
    government.metadata.epistemic_stance = "primary_source";
    government._internal.source_weight = 0.9;
    const academic = chunk("academic", "crude oil prices supply demand forecast inventory analysis", 0.91);
    academic.metadata.claim_graph = [
      { claim: "Forecasting models explain oil price movements.", claim_type: "asserted", supporting_text_offset: [0, 42] }
    ];
    academic.metadata.source_name = "openalex";
    academic.metadata.source_type = "academic";

    const result = await deduplicateChunks([government, academic], new MockEmbedder(), { threshold: 0.4 });

    expect(result.chunks.map((item) => item.id)).toEqual(expect.arrayContaining(["government", "academic"]));
  });

  it("clusters claim-level duplicates even when wording differs", async () => {
    const first = chunk("first", "Interest costs consume more fiscal room over time.", 0.75);
    const second = chunk("second", "The budget loses flexibility as net interest compounds.", 0.92);
    first.metadata.claim_graph = [
      { claim: "Rising interest costs reduce fiscal flexibility.", claim_type: "asserted", supporting_text_offset: [0, 50] }
    ];
    second.metadata.claim_graph = [
      { claim: "Rising interest costs reduce fiscal flexibility.", claim_type: "asserted", supporting_text_offset: [0, 55] }
    ];

    const result = await deduplicateChunks([first, second], new MockEmbedder(), { threshold: 0.99 });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.id).toBe("second");
    expect(result.clusters[0]?.duplicate_level).toBe("claim");
    expect(result.clusters[0]?.novelty_score).toBeGreaterThanOrEqual(0);
  });
});
