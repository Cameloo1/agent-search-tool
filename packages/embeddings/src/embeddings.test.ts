import { describe, expect, it } from "vitest";
import { clusterByCosine, cosineSimilarity, createDeterministicMockEmbedder } from "./index.js";

describe("deterministic local embeddings", () => {
  it("produces stable vectors and high duplicate similarity", async () => {
    const embedder = createDeterministicMockEmbedder({ dimensions: 64 });
    const first = await embedder.embed(["The SEC filing reports revenue growth for 2025."]);
    const second = await embedder.embed(["The SEC filing reports revenue growth for 2025."]);

    expect(first[0]).toEqual(second[0]);
    expect(cosineSimilarity(first[0], second[0])).toBeCloseTo(1, 6);
  });

  it("clusters similar items by cosine threshold", async () => {
    const embedder = createDeterministicMockEmbedder({ dimensions: 64 });
    const [alpha, alphaDuplicate, beta] = await embedder.embed([
      "machine learning benchmark reproducibility",
      "machine learning benchmark reproducibility",
      "municipal bond disclosure deadline"
    ]);

    const result = clusterByCosine(
      [
        { id: "alpha", embedding: alpha },
        { id: "alpha-copy", embedding: alphaDuplicate },
        { id: "beta", embedding: beta }
      ],
      { threshold: 0.9 }
    );

    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.find((cluster) => cluster.itemIds.includes("alpha"))?.itemIds).toEqual([
      "alpha",
      "alpha-copy"
    ]);
  });
});
