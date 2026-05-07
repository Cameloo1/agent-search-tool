import type { NormalizedChunk } from "@agent-search/shared";

export function termDistribution(text: string): Map<string, number> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total === 0) return counts;
  for (const [key, value] of counts) counts.set(key, value / total);
  return counts;
}

export function jensenShannonDivergence(left: Map<string, number>, right: Map<string, number>): number {
  const keys = new Set([...left.keys(), ...right.keys()]);
  if (keys.size === 0) return 0;
  const midpoint = new Map<string, number>();
  for (const key of keys) midpoint.set(key, ((left.get(key) ?? 0) + (right.get(key) ?? 0)) / 2);
  const js = (klDivergence(left, midpoint) + klDivergence(right, midpoint)) / 2;
  return clamp01(js / Math.log(2));
}

export function klDivergence(left: Map<string, number>, right: Map<string, number>): number {
  let total = 0;
  for (const [key, p] of left) {
    const q = right.get(key);
    if (!p || !q) continue;
    total += p * Math.log(p / q);
  }
  return total;
}

export function claimSignature(chunk: NormalizedChunk): string {
  const claims = chunk.metadata.claim_graph.map((claim) => normalizeText(claim.claim)).filter(Boolean);
  return claims.join("|") || normalizeText(chunk.content).slice(0, 240);
}

export function canonicalDocumentKey(chunk: NormalizedChunk): string {
  const url = safeUrl(chunk.metadata.url);
  const normalizedUrl = url
    ? `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`
    : normalizeText(chunk.metadata.url);
  const title = normalizeText(chunk.metadata.title ?? "");
  const author = normalizeText(chunk.metadata.author ?? "");
  const date = chunk.metadata.publish_date?.slice(0, 10) ?? "";
  return [chunk.metadata.source_name, normalizedUrl, title, author, date].filter(Boolean).join("::");
}

export function normalizedContentKey(text: string): string {
  return normalizeText(text).replace(/\s+/g, " ").slice(0, 2000);
}

export function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(" ").filter((token) => token.length > 3));
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
