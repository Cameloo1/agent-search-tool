import { cosineSimilarity } from "@agent-search/embeddings";
import { DEFAULTS, NormalizedChunkSchema, type Embedder, type NormalizedChunk } from "@agent-search/shared";
import {
  canonicalDocumentKey,
  claimSignature,
  jaccard,
  jensenShannonDivergence,
  normalizedContentKey,
  termDistribution,
  tokenSet
} from "./informationTheory.js";

export interface DedupClusterTrace {
  id: string;
  representative_id: string;
  member_ids: string[];
  rejected_ids: string[];
  duplicate_level: "document" | "chunk" | "claim" | "semantic";
  novelty_score?: number;
  js_divergence?: number;
}

export interface Stage7Result {
  chunks: NormalizedChunk[];
  clusters: DedupClusterTrace[];
  rejectedChunkIds: string[];
  warnings: string[];
}

export interface Stage7Options {
  threshold?: number;
  claimOverlapThreshold?: number;
  documentOverlapThreshold?: number;
  debugInternals?: boolean;
}

export async function deduplicateChunks(
  chunks: NormalizedChunk[],
  embedder: Embedder,
  options: Stage7Options = {}
): Promise<Stage7Result> {
  if (chunks.length === 0) {
    return { chunks: [], clusters: [], rejectedChunkIds: [], warnings: [] };
  }

  const threshold = options.threshold ?? DEFAULTS.dedupSimilarityThreshold;
  const claimThreshold = options.claimOverlapThreshold ?? 0.78;
  const documentThreshold = options.documentOverlapThreshold ?? 0.92;
  const embeddings = await embedder.embed(chunks.map((chunk) => chunk.content));
  const embeddedChunks = chunks.map((chunk, index) =>
    NormalizedChunkSchema.parse({
      ...chunk,
      _internal: { ...chunk._internal, embedding: embeddings[index] ?? [] }
    })
  );

  const unionFind = new UnionFind(embeddedChunks.length);
  const duplicateLevels = new Map<string, DedupClusterTrace["duplicate_level"]>();

  for (let left = 0; left < embeddedChunks.length; left += 1) {
    for (let right = left + 1; right < embeddedChunks.length; right += 1) {
      const level = duplicateLevel(embeddedChunks[left], embeddedChunks[right], embeddings[left], embeddings[right], {
        semanticThreshold: threshold,
        claimThreshold,
        documentThreshold
      });
      if (level) {
        unionFind.union(left, right);
        duplicateLevels.set(pairKey(left, right), level);
      }
    }
  }

  const rawClusters = unionFind.clusters().map((memberIndexes, index) => ({
    id: `cluster-${index + 1}`,
    memberIndexes,
    representativeIndex: memberIndexes[0]
  }));
  const selected: NormalizedChunk[] = [];
  const rejectedChunkIds: string[] = [];
  const clusters: DedupClusterTrace[] = [];

  for (const cluster of rawClusters) {
    const representativeIndex = chooseRepresentative(cluster.memberIndexes, embeddedChunks);
    cluster.representativeIndex = representativeIndex;
    const representative = embeddedChunks[representativeIndex];
    selected.push(stripEmbeddingIfNeeded(representative, options.debugInternals));
    const rejected = cluster.memberIndexes.filter((index) => index !== representativeIndex).map((index) => embeddedChunks[index].id);
    rejectedChunkIds.push(...rejected);
    const noveltyScore = clusterNovelty(representative, cluster.memberIndexes, embeddedChunks);
    const jsDivergence = clusterJsDivergence(representative, cluster.memberIndexes, embeddedChunks);
    clusters.push({
      id: cluster.id,
      representative_id: representative.id,
      member_ids: cluster.memberIndexes.map((index) => embeddedChunks[index].id),
      rejected_ids: rejected,
      duplicate_level: clusterDuplicateLevel(cluster.memberIndexes, duplicateLevels),
      novelty_score: noveltyScore,
      js_divergence: jsDivergence
    });
  }

  return {
    chunks: selected,
    clusters,
    rejectedChunkIds,
    warnings: [`V2 dedup uses canonical document, exact chunk, claim overlap, semantic cosine, and JS divergence metrics.`]
  };
}

function duplicateLevel(
  left: NormalizedChunk,
  right: NormalizedChunk,
  leftEmbedding: number[],
  rightEmbedding: number[],
  thresholds: { semanticThreshold: number; claimThreshold: number; documentThreshold: number }
): DedupClusterTrace["duplicate_level"] | null {
  if (canonicalDocumentKey(left) === canonicalDocumentKey(right)) return "document";
  if (normalizedContentKey(left.content) === normalizedContentKey(right.content)) return "chunk";
  const documentOverlap = jaccard(tokenSet(left.content), tokenSet(right.content));
  if (documentOverlap >= thresholds.documentThreshold) return "chunk";
  const claimOverlap = jaccard(tokenSet(claimSignature(left)), tokenSet(claimSignature(right)));
  if (claimOverlap >= thresholds.claimThreshold) return "claim";
  const semanticThreshold =
    left.metadata.source_type === right.metadata.source_type
      ? thresholds.semanticThreshold
      : Math.max(0.94, thresholds.semanticThreshold + 0.08);
  if (cosineSimilarity(leftEmbedding, rightEmbedding) >= semanticThreshold) return "semantic";
  return null;
}

function clusterNovelty(representative: NormalizedChunk, memberIndexes: number[], chunks: NormalizedChunk[]): number {
  const others = memberIndexes.map((index) => chunks[index]).filter((chunk) => chunk.id !== representative.id);
  if (others.length === 0) return 1;
  const maxOverlap = Math.max(...others.map((chunk) => jaccard(tokenSet(representative.content), tokenSet(chunk.content))));
  return Math.max(0, Math.min(1, 1 - maxOverlap));
}

function clusterJsDivergence(representative: NormalizedChunk, memberIndexes: number[], chunks: NormalizedChunk[]): number {
  const others = memberIndexes.map((index) => chunks[index]).filter((chunk) => chunk.id !== representative.id);
  if (others.length === 0) return 1;
  const repDistribution = termDistribution(representative.content);
  const otherText = others.map((chunk) => chunk.content).join(" ");
  return jensenShannonDivergence(repDistribution, termDistribution(otherText));
}

function clusterDuplicateLevel(memberIndexes: number[], levels: Map<string, DedupClusterTrace["duplicate_level"]>): DedupClusterTrace["duplicate_level"] {
  const priority: DedupClusterTrace["duplicate_level"][] = ["document", "chunk", "claim", "semantic"];
  const found = new Set<DedupClusterTrace["duplicate_level"]>();
  for (let left = 0; left < memberIndexes.length; left += 1) {
    for (let right = left + 1; right < memberIndexes.length; right += 1) {
      const level = levels.get(pairKey(memberIndexes[left], memberIndexes[right]));
      if (level) found.add(level);
    }
  }
  return priority.find((level) => found.has(level)) ?? "semantic";
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    if (this.parents[index] !== index) this.parents[index] = this.find(this.parents[index]);
    return this.parents[index];
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }

  clusters(): number[][] {
    const groups = new Map<number, number[]>();
    for (let index = 0; index < this.parents.length; index += 1) {
      const root = this.find(index);
      groups.set(root, [...(groups.get(root) ?? []), index]);
    }
    return [...groups.values()];
  }
}

function chooseRepresentative(indexes: number[], chunks: NormalizedChunk[]): number {
  return indexes
    .map((index) => ({ index, score: representativeScore(chunks[index]) }))
    .sort((a, b) => b.score - a.score || chunks[a.index].id.localeCompare(chunks[b.index].id))[0].index;
}

function representativeScore(chunk: NormalizedChunk): number {
  return (
    chunk._internal.relevance_to_query *
    chunk._internal.source_weight *
    chunk.metadata.confidence_score *
    chunk._internal.freshness_fitness
  );
}

function stripEmbeddingIfNeeded(chunk: NormalizedChunk, debugInternals = false): NormalizedChunk {
  if (debugInternals) return chunk;
  return NormalizedChunkSchema.parse({
    ...chunk,
    _internal: { ...chunk._internal, embedding: [] }
  });
}
