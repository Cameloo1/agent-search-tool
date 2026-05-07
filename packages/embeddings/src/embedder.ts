import type { Embedder } from "@agent-search/shared";

export class LocalHashEmbedder implements Embedder {
  readonly name: string = "local-hashing-embedder";

  constructor(private readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => normalize(vectorize(text, this.dimensions)));
  }
}

export class MockEmbedder extends LocalHashEmbedder {
  readonly name = "mock-local-embedder";
}

export function createDefaultEmbedder(): Embedder {
  return new LocalHashEmbedder();
}

function vectorize(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    vector[hash(token) % dimensions] += 1;
    for (const gram of charTrigrams(token)) {
      vector[hash(`g:${gram}`) % dimensions] += 0.3;
    }
  }
  return vector;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function charTrigrams(token: string): string[] {
  if (token.length <= 3) return [token];
  const grams: string[] = [];
  for (let i = 0; i <= token.length - 3; i += 1) grams.push(token.slice(i, i + 3));
  return grams;
}

function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
