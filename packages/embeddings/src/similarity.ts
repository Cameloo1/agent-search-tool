export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function normalizeVector(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}

export function averageVectors(vectors: readonly (readonly number[])[]): number[] {
  const maxLength = vectors.reduce((max, vector) => Math.max(max, vector.length), 0);
  if (vectors.length === 0 || maxLength === 0) return [];

  const average = Array.from({ length: maxLength }, () => 0);
  for (const vector of vectors) {
    for (let index = 0; index < maxLength; index += 1) {
      average[index] += vector[index] ?? 0;
    }
  }

  return normalizeVector(average.map((value) => value / vectors.length));
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
