import { estimateTokens, type IntentObject, type NormalizedChunk } from "@agent-search/shared";
import { cosineSimilarity } from "@agent-search/embeddings";

export interface AssemblySelection {
  token_budget: number;
  estimated_tokens_used: number;
  selected_chunk_ids: string[];
  rejected_chunk_ids: string[];
  final_marginal_gains: Record<string, number>;
  reasons: Record<string, string>;
}

export interface Stage8Result {
  chunks: NormalizedChunk[];
  selection: AssemblySelection;
}

type RequiredSourceType = IntentObject["required_source_types"][number];

interface RankedCandidate {
  chunk: NormalizedChunk;
  gain: number;
  index: number;
}

const ASSEMBLY_TUNING = {
  requiredCoverageMinRelevance: 0.12,
  requiredCoverageBoost: 0.35,
  requiredCoverageMinGain: 0.02,
  contextualMismatchRelevance: 0.08,
  minNovelty: 0.05,
  maxNovelty: 1,
  requiredSourceTypeBoost: 0.28,
  multiHopClaimBoost: 0.04,
  multiHopMaxBoost: 0.25,
  freshFactFitnessBoost: 0.25,
  adversarialPrimaryBoost: 0.25,
  sourceAttributionClaimBoost: 0.18,
  dedupProneSurpriseBoost: 0.3,
  academicSourceBoost: 0.22,
  culturalNonSpeculationBoost: 0.08,
  speculationPenalty: 0.18,
  adversarialOpinionPenalty: 0.12,
  freshFactTertiaryPenalty: 0.05
} as const;

const PRIMARY_DOCUMENT_SOURCE_TYPES = new Set<NormalizedChunk["metadata"]["source_type"]>([
  "government",
  "filing",
  "structured_fact",
  "medical"
]);

export function assembleFinalChunks(chunks: NormalizedChunk[], intent: IntentObject, tokenBudget: number): Stage8Result {
  const remaining = [...chunks];
  const selected: NormalizedChunk[] = [];
  const rejected = new Set<string>();
  const reasons: Record<string, string> = {};
  let tokensUsed = 0;

  for (const requiredType of intent.required_source_types) {
    if (!shouldReserveRequiredSourceType(requiredType) || selected.some((chunk) => matchesRequiredSourceType(chunk, requiredType))) continue;
    const coverageCandidate = chooseBestCandidate(
      remaining,
      (chunk) => marginalGain(chunk, selected, intent) + ASSEMBLY_TUNING.requiredCoverageBoost,
      (chunk) =>
        matchesRequiredSourceType(chunk, requiredType) &&
        chunk._internal.relevance_to_query >= ASSEMBLY_TUNING.requiredCoverageMinRelevance
    );
    if (!coverageCandidate) continue;

    const nextTokens = estimateTokens(coverageCandidate.chunk.content);
    remaining.splice(coverageCandidate.index, 1);

    if (nextTokens <= tokenBudget - tokensUsed && coverageCandidate.gain > ASSEMBLY_TUNING.requiredCoverageMinGain) {
      selected.push(coverageCandidate.chunk);
      tokensUsed += nextTokens;
      reasons[coverageCandidate.chunk.id] = `selected_required_coverage=${requiredType} gain=${coverageCandidate.gain.toFixed(4)} tokens=${nextTokens}`;
    } else {
      rejected.add(coverageCandidate.chunk.id);
      reasons[coverageCandidate.chunk.id] =
        nextTokens > tokenBudget - tokensUsed
          ? `rejected_required_coverage_budget source_type=${requiredType} tokens=${nextTokens} remaining=${tokenBudget - tokensUsed}`
          : `rejected_required_coverage_low_gain source_type=${requiredType} gain=${coverageCandidate.gain.toFixed(4)}`;
    }
  }

  while (remaining.length > 0 && tokensUsed < tokenBudget) {
    const next = chooseBestCandidate(remaining, (chunk) => marginalGain(chunk, selected, intent));
    if (!next) break;
    const nextTokens = estimateTokens(next.chunk.content);

    remaining.splice(next.index, 1);

    if (next.chunk._internal.relevance_to_query < ASSEMBLY_TUNING.contextualMismatchRelevance) {
      rejected.add(next.chunk.id);
      reasons[next.chunk.id] = `rejected_contextual_mismatch relevance=${next.chunk._internal.relevance_to_query.toFixed(4)}`;
    } else if (nextTokens <= tokenBudget - tokensUsed && next.gain > 0) {
      selected.push(next.chunk);
      tokensUsed += nextTokens;
      reasons[next.chunk.id] = `selected gain=${next.gain.toFixed(4)} tokens=${nextTokens}`;
    } else {
      rejected.add(next.chunk.id);
      reasons[next.chunk.id] =
        nextTokens > tokenBudget - tokensUsed
          ? `rejected_budget tokens=${nextTokens} remaining=${tokenBudget - tokensUsed}`
          : `rejected_low_gain gain=${next.gain.toFixed(4)}`;
    }
  }

  for (const chunk of remaining) {
    rejected.add(chunk.id);
    reasons[chunk.id] = "rejected_not_reached_after_budget_or_rank";
  }

  return {
    chunks: selected,
    selection: {
      token_budget: tokenBudget,
      estimated_tokens_used: tokensUsed,
      selected_chunk_ids: selected.map((chunk) => chunk.id),
      rejected_chunk_ids: [...rejected],
      final_marginal_gains: finalMarginalGains(chunks, selected, intent),
      reasons
    }
  };
}

function marginalGain(chunk: NormalizedChunk, selected: NormalizedChunk[], intent: IntentObject): number {
  const relevance = chunk._internal.relevance_to_query;
  const novelty = noveltyScore(chunk, selected);
  const sourceWeight = chunk._internal.source_weight;
  const queryWeight = queryTypeWeight(chunk, intent);
  const stancePenalty = epistemicStancePenalty(chunk, intent);
  return relevance * novelty * sourceWeight * queryWeight - stancePenalty;
}

function noveltyScore(chunk: NormalizedChunk, selected: NormalizedChunk[]): number {
  if (selected.length === 0) return 1;
  const maxSimilarity = Math.max(
    ...selected.map((other) => {
      if (chunk._internal.embedding.length && other._internal.embedding.length) {
        return cosineSimilarity(chunk._internal.embedding, other._internal.embedding);
      }
      return claimOverlap(chunk, other);
    })
  );
  return clamp(1 - maxSimilarity, ASSEMBLY_TUNING.minNovelty, ASSEMBLY_TUNING.maxNovelty);
}

function claimOverlap(a: NormalizedChunk, b: NormalizedChunk): number {
  const aTerms = new Set(
    a.metadata.claim_graph
      .flatMap((claim) => claim.claim.toLowerCase().split(/[^a-z0-9]+/))
      .filter((term) => term.length > 3)
  );
  const bTerms = new Set(
    b.metadata.claim_graph
      .flatMap((claim) => claim.claim.toLowerCase().split(/[^a-z0-9]+/))
      .filter((term) => term.length > 3)
  );
  if (aTerms.size === 0 || bTerms.size === 0) return 0;
  const intersection = [...aTerms].filter((term) => bTerms.has(term)).length;
  return intersection / Math.min(aTerms.size, bTerms.size);
}

function queryTypeWeight(chunk: NormalizedChunk, intent: IntentObject): number {
  let weight = 1;
  if (intent.required_source_types.some((sourceType) => matchesRequiredSourceType(chunk, sourceType))) weight += ASSEMBLY_TUNING.requiredSourceTypeBoost;
  if (intent.query_type.includes("multi-hop")) {
    weight += Math.min(ASSEMBLY_TUNING.multiHopMaxBoost, chunk.metadata.claim_graph.length * ASSEMBLY_TUNING.multiHopClaimBoost);
  }
  if (intent.query_type.includes("fresh-fact")) weight += chunk._internal.freshness_fitness * ASSEMBLY_TUNING.freshFactFitnessBoost;
  if (intent.query_type.includes("adversarial") && chunk.metadata.epistemic_stance === "primary_source") weight += ASSEMBLY_TUNING.adversarialPrimaryBoost;
  if (intent.query_type.includes("source-attribution") && chunk.metadata.claim_graph.length > 0) weight += ASSEMBLY_TUNING.sourceAttributionClaimBoost;
  if (intent.query_type.includes("dedup-prone")) weight += chunk.metadata.surprise_score * ASSEMBLY_TUNING.dedupProneSurpriseBoost;
  if (intent.query_type.includes("academic") && ["academic", "medical"].includes(chunk.metadata.source_type)) weight += ASSEMBLY_TUNING.academicSourceBoost;
  if (intent.query_type.includes("cultural") && chunk.metadata.epistemic_stance !== "speculation") weight += ASSEMBLY_TUNING.culturalNonSpeculationBoost;
  return weight;
}

function matchesRequiredSourceType(chunk: NormalizedChunk, requiredType: RequiredSourceType): boolean {
  if (requiredType === "primary-document") {
    return (
      chunk.metadata.epistemic_stance === "primary_source" ||
      PRIMARY_DOCUMENT_SOURCE_TYPES.has(chunk.metadata.source_type)
    );
  }
  if (requiredType === "news") return false;
  return chunk.metadata.source_type === requiredType;
}

function shouldReserveRequiredSourceType(requiredType: RequiredSourceType): boolean {
  // Day 1 has no generic news source_type; the only "news" source is Hacker News technical discussion.
  return requiredType !== "news";
}

function epistemicStancePenalty(chunk: NormalizedChunk, intent: IntentObject): number {
  if (chunk.metadata.epistemic_stance === "speculation") return ASSEMBLY_TUNING.speculationPenalty;
  if (intent.query_type.includes("adversarial") && chunk.metadata.epistemic_stance === "opinion") return ASSEMBLY_TUNING.adversarialOpinionPenalty;
  if (intent.query_type.includes("fresh-fact") && chunk.metadata.epistemic_stance === "tertiary_summary") return ASSEMBLY_TUNING.freshFactTertiaryPenalty;
  return 0;
}

function chooseBestCandidate(
  chunks: NormalizedChunk[],
  score: (chunk: NormalizedChunk) => number,
  eligible: (chunk: NormalizedChunk) => boolean = () => true
): RankedCandidate | undefined {
  let best: RankedCandidate | undefined;

  chunks.forEach((chunk, index) => {
    if (!eligible(chunk)) return;
    const candidate = { chunk, gain: score(chunk), index };
    if (!best || isBetterCandidate(candidate, best)) best = candidate;
  });

  return best;
}

function isBetterCandidate(candidate: RankedCandidate, incumbent: RankedCandidate): boolean {
  if (candidate.gain !== incumbent.gain) return candidate.gain > incumbent.gain;
  if (candidate.chunk._internal.relevance_to_query !== incumbent.chunk._internal.relevance_to_query) {
    return candidate.chunk._internal.relevance_to_query > incumbent.chunk._internal.relevance_to_query;
  }
  if (candidate.chunk._internal.source_weight !== incumbent.chunk._internal.source_weight) {
    return candidate.chunk._internal.source_weight > incumbent.chunk._internal.source_weight;
  }
  if (candidate.chunk._internal.freshness_fitness !== incumbent.chunk._internal.freshness_fitness) {
    return candidate.chunk._internal.freshness_fitness > incumbent.chunk._internal.freshness_fitness;
  }
  return candidate.chunk.id.localeCompare(incumbent.chunk.id) < 0;
}

function finalMarginalGains(chunks: NormalizedChunk[], selected: NormalizedChunk[], intent: IntentObject): Record<string, number> {
  return Object.fromEntries(
    chunks.map((chunk) => [
      chunk.id,
      roundGain(marginalGain(chunk, selected.filter((selectedChunk) => selectedChunk.id !== chunk.id), intent))
    ])
  );
}

function roundGain(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
