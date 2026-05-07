import { cosineSimilarity } from "./cosine.js";

export interface SimilarityCluster {
  id: string;
  memberIndexes: number[];
  representativeIndex: number;
}

export interface EmbeddingItem {
  id: string;
  embedding: number[];
}

export interface ItemSimilarityCluster {
  id: string;
  itemIds: string[];
  memberIndexes: number[];
}

export function clusterByCosine(vectors: number[][], threshold: number): SimilarityCluster[];
export function clusterByCosine(
  items: EmbeddingItem[],
  options: { threshold: number }
): { clusters: ItemSimilarityCluster[] };
export function clusterByCosine(
  input: number[][] | EmbeddingItem[],
  thresholdOrOptions: number | { threshold: number }
): SimilarityCluster[] | { clusters: ItemSimilarityCluster[] } {
  const itemMode = isEmbeddingItems(input);
  const threshold = typeof thresholdOrOptions === "number" ? thresholdOrOptions : thresholdOrOptions.threshold;
  const vectors = itemMode ? input.map((item) => item.embedding) : input;
  const clusters: SimilarityCluster[] = [];

  for (let index = 0; index < vectors.length; index += 1) {
    let assigned = false;
    for (const cluster of clusters) {
      const isSimilar = cluster.memberIndexes.some((memberIndex) => cosineSimilarity(vectors[index], vectors[memberIndex]) >= threshold);
      if (isSimilar) {
        cluster.memberIndexes.push(index);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        id: `cluster-${clusters.length + 1}`,
        memberIndexes: [index],
        representativeIndex: index
      });
    }
  }

  if (!itemMode) return clusters;
  return {
    clusters: clusters.map((cluster) => ({
      id: cluster.id,
      itemIds: cluster.memberIndexes.map((index) => input[index].id),
      memberIndexes: cluster.memberIndexes
    }))
  };
}

function isEmbeddingItems(input: number[][] | EmbeddingItem[]): input is EmbeddingItem[] {
  return Boolean(input[0]) && !Array.isArray(input[0]);
}
