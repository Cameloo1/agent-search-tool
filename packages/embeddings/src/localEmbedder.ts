import type { Embedder } from "@agent-search/shared";
import { normalizeVector } from "./similarity.js";

export interface LocalEmbedderOptions {
  dimensions?: number;
  includeCharacterNgrams?: boolean;
  name?: string;
  seed?: number;
}

const DEFAULT_DIMENSIONS = 128;
const DEFAULT_SEED = 2_166_136_261;
const WORD_PATTERN = /[a-z0-9]+(?:['-][a-z0-9]+)?/g;

export class DeterministicLocalEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions: number;
  private readonly includeCharacterNgrams: boolean;
  private readonly seed: number;

  constructor(options: LocalEmbedderOptions = {}) {
    this.name = options.name ?? "deterministic-local-embedder";
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.includeCharacterNgrams = options.includeCharacterNgrams ?? true;
    this.seed = options.seed ?? DEFAULT_SEED;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = tokenize(text);

    for (const token of tokens) {
      this.addFeature(vector, `tok:${token}`, 1 + Math.min(token.length / 12, 0.6));
    }

    for (let index = 0; index < tokens.length - 1; index += 1) {
      this.addFeature(vector, `bigram:${tokens[index]} ${tokens[index + 1]}`, 0.7);
    }

    if (this.includeCharacterNgrams) {
      for (const token of tokens) {
        for (const ngram of characterNgrams(token, 3)) {
          this.addFeature(vector, `char:${ngram}`, 0.28);
        }
      }
    }

    return normalizeVector(vector);
  }

  private addFeature(vector: number[], feature: string, weight: number): void {
    const hash = hashString(feature, this.seed);
    const index = hash % this.dimensions;
    const sign = hashString(`sign:${feature}`, this.seed) % 2 === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }
}

export function createLocalEmbedder(options: LocalEmbedderOptions = {}): Embedder {
  return new DeterministicLocalEmbedder(options);
}

export function createDeterministicMockEmbedder(options: LocalEmbedderOptions = {}): Embedder {
  return new DeterministicLocalEmbedder({
    dimensions: options.dimensions ?? 64,
    includeCharacterNgrams: options.includeCharacterNgrams ?? false,
    name: options.name ?? "deterministic-mock-embedder",
    seed: options.seed
  });
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

function characterNgrams(token: string, size: number): string[] {
  if (token.length <= size) return [token];

  const padded = ` ${token} `;
  const ngrams: string[] = [];
  for (let index = 0; index <= padded.length - size; index += 1) {
    ngrams.push(padded.slice(index, index + size));
  }
  return ngrams;
}

function hashString(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
