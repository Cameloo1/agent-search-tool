import { describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "./embedder.js";
import { cosineSimilarity } from "./cosine.js";

describe("local hash embedder", () => {
  it("makes exact duplicates highly similar and unrelated text less similar", async () => {
    const embedder = new LocalHashEmbedder();
    const [a, b, c] = await embedder.embed([
      "SEC filings provide primary source evidence for company disclosures.",
      "SEC filings provide primary source evidence for company disclosures.",
      "Banana bread recipes use flour and sugar."
    ]);

    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.6);
  });
});
