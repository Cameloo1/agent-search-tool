import { createHash } from "node:crypto";
import {
  PreRankDiagnosticsSchema,
  getSourceWeight,
  type IntentObject,
  type NormalizedChunk,
  type PreRankDiagnostics,
  type RequiredSourceType,
  type SourceName
} from "@agent-search/shared";

export interface PreRankOptions {
  maxLlmChunks: number;
  roundIndex: number;
  broadeningLevel: number;
  unavailableSourcesSkipped?: SourceName[];
}

export interface PreRankResult {
  chunks: NormalizedChunk[];
  rejectedChunks: NormalizedChunk[];
  diagnostics: PreRankDiagnostics;
}

interface Candidate {
  chunk: NormalizedChunk;
  localScore: number;
  reasons: string[];
}

const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "between",
  "could",
  "from",
  "have",
  "into",
  "like",
  "more",
  "most",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your"
]);

export function preRankChunks(
  chunks: NormalizedChunk[],
  query: string,
  intent: IntentObject,
  options: PreRankOptions
): PreRankResult {
  if (chunks.length === 0 || options.maxLlmChunks <= 0) {
    const diagnostics = PreRankDiagnosticsSchema.parse({
      round_index: options.roundIndex,
      broadening_level: options.broadeningLevel,
      input_chunk_count: chunks.length,
      duplicate_group_count: 0,
      duplicate_rejected_count: 0,
      selected_for_llm_count: 0,
      rejected_count: chunks.length,
      unavailable_sources_skipped: options.unavailableSourcesSkipped ?? [],
      selected_candidates: [],
      rejected_candidates: chunks.map((chunk) => ({ chunk_id: chunk.id, local_score: 0, reasons: ["no_prerank_capacity"] })),
      duplicate_groups: []
    });
    return { chunks: [], rejectedChunks: chunks, diagnostics };
  }

  const candidates = chunks.map((chunk) => scoreCandidate(chunk, query, intent));
  const grouped = groupExactDuplicates(candidates);
  const representatives = grouped.representatives.sort((a, b) => b.localScore - a.localScore);
  const selected = selectDiverseCandidates(representatives, intent, options.maxLlmChunks);
  const selectedIds = new Set(selected.map((candidate) => candidate.chunk.id));
  const duplicateRejectedIds = new Set(grouped.duplicateRejected.map((candidate) => candidate.chunk.id));
  const rejected = [
    ...representatives.filter((candidate) => !selectedIds.has(candidate.chunk.id)),
    ...grouped.duplicateRejected
  ];

  const diagnostics = PreRankDiagnosticsSchema.parse({
    round_index: options.roundIndex,
    broadening_level: options.broadeningLevel,
    input_chunk_count: chunks.length,
    duplicate_group_count: grouped.duplicateGroups.length,
    duplicate_rejected_count: duplicateRejectedIds.size,
    selected_for_llm_count: selected.length,
    rejected_count: rejected.length,
    unavailable_sources_skipped: options.unavailableSourcesSkipped ?? [],
    selected_candidates: selected.map(toDiagnosticCandidate),
    rejected_candidates: rejected.slice(0, 80).map(toDiagnosticCandidate),
    duplicate_groups: grouped.duplicateGroups.slice(0, 40)
  });

  return {
    chunks: selected.map((candidate) => candidate.chunk),
    rejectedChunks: rejected.map((candidate) => candidate.chunk),
    diagnostics
  };
}

function scoreCandidate(chunk: NormalizedChunk, query: string, intent: IntentObject): Candidate {
  const queryTerms = tokenize(query);
  const haystack = `${chunk.metadata.title ?? ""} ${chunk.metadata.summary ?? ""} ${chunk.content}`.toLowerCase();
  const title = (chunk.metadata.title ?? "").toLowerCase();
  const hits = queryTerms.filter((term) => haystack.includes(term));
  const titleHits = queryTerms.filter((term) => title.includes(term));
  const denominator = Math.max(4, Math.min(14, queryTerms.length || 4));
  const lexical = queryTerms.length ? hits.length / denominator : 0;
  const titleBoost = titleHits.length ? Math.min(0.12, titleHits.length * 0.03) : 0;
  const phraseBoost = phraseMatchBoost(query, haystack);
  const sourceWeight = getSourceWeight(chunk.metadata.source_name, chunk.metadata.source_type);
  const freshness = freshnessScore(chunk.metadata.publish_date);
  const requiredMatch = intent.required_source_types.some((required) => matchesRequiredSourceType(chunk, required));
  const primaryBoost =
    chunk.metadata.epistemic_stance === "primary_source" || ["filing", "government", "structured_fact"].includes(chunk.metadata.source_type)
      ? 0.06
      : 0;
  const queryTypeBoost = queryTypeBoostForChunk(chunk, intent);
  const badContextPenalty = /about the author|editorial board|copyright|privacy policy|terms of use/.test(haystack.slice(0, 500))
    ? 0.45
    : 1;

  const localScore = clamp01(
    (lexical * 0.46 + sourceWeight * 0.24 + freshness * 0.1 + titleBoost + phraseBoost + primaryBoost + queryTypeBoost + (requiredMatch ? 0.1 : 0)) *
      badContextPenalty
  );
  const reasons = [
    hits.length ? `${hits.length}_query_terms` : "low_term_overlap",
    `source_weight_${sourceWeight.toFixed(2)}`,
    `freshness_${freshness.toFixed(2)}`,
    ...(titleHits.length ? ["title_match"] : []),
    ...(requiredMatch ? ["required_source_type"] : []),
    ...(primaryBoost ? ["primary_like_source"] : []),
    ...(phraseBoost ? ["phrase_match"] : []),
    ...(badContextPenalty < 1 ? ["boilerplate_penalty"] : [])
  ];

  return { chunk, localScore, reasons };
}

function groupExactDuplicates(candidates: Candidate[]) {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = duplicateKey(candidate.chunk);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  const representatives: Candidate[] = [];
  const duplicateRejected: Candidate[] = [];
  const duplicateGroups: PreRankDiagnostics["duplicate_groups"] = [];

  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => b.localScore - a.localScore);
    const representative = sorted[0];
    representatives.push(representative);
    const duplicates = sorted.slice(1);
    duplicateRejected.push(...duplicates);
    if (duplicates.length > 0) {
      duplicateGroups.push({
        id: hashText(key).slice(0, 12),
        representative_id: representative.chunk.id,
        member_ids: sorted.map((candidate) => candidate.chunk.id),
        reason: key.startsWith("url:") ? "canonical_url" : key.startsWith("title:") ? "title_text_fingerprint" : "content_fingerprint"
      });
    }
  }

  return { representatives, duplicateRejected, duplicateGroups };
}

function selectDiverseCandidates(candidates: Candidate[], intent: IntentObject, maxCount: number): Candidate[] {
  const selected: Candidate[] = [];
  const selectedIds = new Set<string>();
  const coveredRequired = new Set<RequiredSourceType>();

  const add = (candidate: Candidate | undefined) => {
    if (!candidate || selectedIds.has(candidate.chunk.id) || selected.length >= maxCount) return;
    selected.push(candidate);
    selectedIds.add(candidate.chunk.id);
    for (const required of intent.required_source_types) {
      if (matchesRequiredSourceType(candidate.chunk, required)) coveredRequired.add(required);
    }
  };

  for (const required of intent.required_source_types) {
    add(candidates.find((candidate) => matchesRequiredSourceType(candidate.chunk, required)));
  }

  while (selected.length < maxCount) {
    const remaining = candidates.filter((candidate) => !selectedIds.has(candidate.chunk.id));
    if (!remaining.length) break;
    const sourceNames = new Set(selected.map((candidate) => candidate.chunk.metadata.source_name));
    const sourceTypes = new Set(selected.map((candidate) => candidate.chunk.metadata.source_type));
    const next = remaining
      .map((candidate) => {
        const sourcePenalty = sourceNames.has(candidate.chunk.metadata.source_name) ? 0.82 : 1;
        const typePenalty = sourceTypes.has(candidate.chunk.metadata.source_type) ? 0.9 : 1;
        const missingRequiredBoost = intent.required_source_types.some(
          (required) => !coveredRequired.has(required) && matchesRequiredSourceType(candidate.chunk, required)
        )
          ? 0.08
          : 0;
        return {
          candidate,
          adjustedScore: candidate.localScore * sourcePenalty * typePenalty + missingRequiredBoost
        };
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore)[0]?.candidate;
    add(next);
  }

  return selected;
}

function matchesRequiredSourceType(chunk: NormalizedChunk, requiredType: RequiredSourceType): boolean {
  if (requiredType === "primary-document") {
    return (
      chunk.metadata.epistemic_stance === "primary_source" ||
      ["government", "filing", "structured_fact", "medical"].includes(chunk.metadata.source_type)
    );
  }
  if (requiredType === "news") return chunk.metadata.source_name === "hacker_news";
  return chunk.metadata.source_type === requiredType;
}

function queryTypeBoostForChunk(chunk: NormalizedChunk, intent: IntentObject): number {
  let boost = 0;
  if (intent.query_type.includes("fresh-fact")) boost += chunk._internal.freshness_fitness * 0.04;
  if (intent.query_type.includes("source-attribution") && chunk.metadata.epistemic_stance === "primary_source") boost += 0.05;
  if (intent.query_type.includes("academic") && chunk.metadata.source_type === "academic") boost += 0.05;
  if (intent.query_type.includes("adversarial") && ["government", "filing", "medical"].includes(chunk.metadata.source_type)) boost += 0.04;
  if (intent.query_type.includes("dedup-prone")) boost += chunk.metadata.surprise_score * 0.03;
  return Math.min(0.12, boost);
}

function duplicateKey(chunk: NormalizedChunk): string {
  const url = canonicalUrl(chunk.metadata.url);
  if (url) return `url:${url}`;
  const title = normalizeText(chunk.metadata.title ?? "");
  const contentHash = hashText(normalizeText(chunk.content).slice(0, 900));
  if (title) return `title:${title}:${contentHash}`;
  return `text:${contentHash}`;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return "";
  }
}

function phraseMatchBoost(query: string, haystack: string): number {
  const terms = tokenize(query);
  if (terms.length < 2) return 0;
  const bigrams = terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`);
  const matches = bigrams.filter((bigram) => haystack.includes(bigram)).length;
  return Math.min(0.1, matches * 0.035);
}

function freshnessScore(value: string | null): number {
  if (!value) return 0.55;
  const published = Date.parse(value);
  if (!Number.isFinite(published)) return 0.55;
  const ageDays = Math.max(0, (Date.now() - published) / 86_400_000);
  if (ageDays <= 365) return 1;
  if (ageDays <= 365 * 3) return 0.78;
  if (ageDays <= 365 * 8) return 0.6;
  return 0.45;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 3 && !STOPWORDS.has(term));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toDiagnosticCandidate(candidate: Candidate) {
  return {
    chunk_id: candidate.chunk.id,
    local_score: Number(candidate.localScore.toFixed(4)),
    reasons: candidate.reasons
  };
}
