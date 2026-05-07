import {
  EvidenceHealthSchema,
  type EvidenceHealth,
  type IntentObject,
  type NormalizedChunk,
  type RequiredSourceType,
  type SourceName,
  type Trace
} from "@agent-search/shared";

export interface EvidenceHealthInput {
  chunks: NormalizedChunk[];
  intent: IntentObject;
  sourceResults: Trace["source_results"];
  deduplication: Trace["deduplication"];
}

export function computeEvidenceHealth(input: EvidenceHealthInput): EvidenceHealth {
  const chunks = input.chunks;
  const selectedChunkCount = chunks.length;
  const selectedClaimCount = chunks.reduce((total, chunk) => total + chunk.metadata.claim_graph.length, 0);
  const sourceNames = new Set(chunks.map((chunk) => chunk.metadata.source_name));
  const sourceTypes = new Set(chunks.map((chunk) => chunk.metadata.source_type));
  const primarySourceCount = chunks.filter((chunk) => isPrimaryLike(chunk)).length;
  const importantSources = importantSourcesForIntent(input.intent);
  const failedSources = Object.entries(input.sourceResults)
    .filter(([, result]) => result.failed > 0 && result.ok === 0)
    .map(([source]) => source as SourceName);
  const degradedExtractionCount = chunks.filter((chunk) => isDegradedExtraction(chunk)).length;
  const metadataOnlyCount = chunks.filter((chunk) => chunk.metadata.extraction?.extraction_status === "metadata_only").length;
  const failedExtractionCount = chunks.filter((chunk) => chunk.metadata.extraction?.extraction_status === "failed").length;
  const failedImportantSources = failedSources.filter((source) => importantSources.has(source));
  const requiredMatches = matchedRequiredSourceTypes(chunks, input.intent.required_source_types);
  const missingRequired = input.intent.required_source_types.filter((type) => !requiredMatches.includes(type));
  const nonRedundancy = computeNonRedundancy(input.deduplication, selectedChunkCount);

  if (selectedChunkCount === 0) {
    return EvidenceHealthSchema.parse({
      status: "insufficient",
      evidence_quality_score: 0,
      evidence_coverage_score: 0,
      components: {
        relevance_confidence: 0,
        source_authority: 0,
        coverage_diversity: 0,
        freshness_failure: 0
      },
      reasons: ["No selected evidence chunks were returned."],
      warnings: buildFailureWarnings(failedImportantSources, failedSources),
      details: {
        selected_chunk_count: 0,
        selected_claim_count: 0,
        distinct_source_count: 0,
        distinct_source_type_count: 0,
        primary_source_count: 0,
        failed_important_source_count: failedImportantSources.length,
        failed_source_count: failedSources.length,
        degraded_extraction_count: 0,
        metadata_only_count: 0,
        failed_extraction_count: 0,
        average_relevance: 0,
        average_confidence: 0,
        average_source_weight: 0,
        average_freshness: 0,
        non_redundancy: 0,
        matched_required_source_types: [],
        missing_required_source_types: input.intent.required_source_types,
        failed_important_sources: failedImportantSources
      }
    });
  }

  const averageRelevance = average(chunks.map((chunk) => chunk._internal.relevance_to_query));
  const nearZeroRelevanceCount = chunks.filter((chunk) => chunk._internal.relevance_to_query < 0.18).length;
  const averageConfidence = average(chunks.map((chunk) => chunk.metadata.confidence_score));
  const averageSourceWeight = average(chunks.map((chunk) => chunk._internal.source_weight));
  const averageFreshness = average(chunks.map((chunk) => chunk._internal.freshness_fitness));
  const relevanceConfidence = pct((averageRelevance + averageConfidence) / 2);
  const sourceAuthority = pct((averageSourceWeight * 0.72) + (primarySourceCount > 0 ? 0.18 : 0) + sourceAuthorityIntentBonus(input.intent, primarySourceCount));
  const coverageDiversity = pct(
    (claimCoverage(selectedClaimCount) * 0.34) +
      (Math.min(1, sourceTypes.size / 3) * 0.24) +
      (Math.min(1, sourceNames.size / 3) * 0.16) +
      (requiredMatches.length / Math.max(1, input.intent.required_source_types.length) * 0.16) +
      (nonRedundancy * 0.1)
  );
  const failurePenalty = failedImportantSources.length > 0 ? Math.min(0.35, failedImportantSources.length * 0.12) : 0;
  const freshnessFailure = pct(Math.max(0, averageFreshness - failurePenalty));
  const relevancePenaltyCap = averageRelevance < 0.25 ? 34 : averageRelevance < 0.35 ? 58 : 100;
  const zeroRelevancePenalty = nearZeroRelevanceCount > 0 ? Math.max(0.45, 1 - nearZeroRelevanceCount / selectedChunkCount) : 1;
  const extractionPenalty = degradedExtractionCount > 0 ? Math.max(0.55, 1 - degradedExtractionCount / selectedChunkCount * 0.25) : 1;
  const evidenceQuality = clampScore(
    relevanceConfidence * 0.35 + sourceAuthority * 0.25 + coverageDiversity * 0.25 + freshnessFailure * 0.15
  );
  const evidenceCoverage = clampScore(coverageDiversity * 0.65 + relevanceConfidence * 0.2 + nonRedundancy * 100 * 0.15);
  const cappedEvidenceQuality = Math.min(Math.round(evidenceQuality * zeroRelevancePenalty * extractionPenalty), relevancePenaltyCap);
  const cappedEvidenceCoverage = Math.min(Math.round(evidenceCoverage * zeroRelevancePenalty * extractionPenalty), relevancePenaltyCap);
  const warnings = [
    ...buildFailureWarnings(failedImportantSources, failedSources),
    ...(degradedExtractionCount > 0 ? [`Selected evidence includes ${degradedExtractionCount} degraded extraction chunk(s).`] : []),
    ...(missingRequired.length > 0 ? [`Missing expected source types: ${missingRequired.join(", ")}.`] : [])
  ];

  return EvidenceHealthSchema.parse({
    status: statusForScore(Math.min(cappedEvidenceQuality, cappedEvidenceCoverage)),
    evidence_quality_score: cappedEvidenceQuality,
    evidence_coverage_score: cappedEvidenceCoverage,
    components: {
      relevance_confidence: relevanceConfidence,
      source_authority: sourceAuthority,
      coverage_diversity: coverageDiversity,
      freshness_failure: freshnessFailure
    },
    reasons: buildReasons({
      evidenceQuality: cappedEvidenceQuality,
      evidenceCoverage: cappedEvidenceCoverage,
      selectedClaimCount,
      sourceTypeCount: sourceTypes.size,
      primarySourceCount,
      failedImportantSources,
      missingRequired,
      averageRelevance,
      nearZeroRelevanceCount,
      degradedExtractionCount,
      metadataOnlyCount,
      failedExtractionCount
    }),
    warnings,
    details: {
      selected_chunk_count: selectedChunkCount,
      selected_claim_count: selectedClaimCount,
      distinct_source_count: sourceNames.size,
      distinct_source_type_count: sourceTypes.size,
      primary_source_count: primarySourceCount,
      failed_important_source_count: failedImportantSources.length,
      failed_source_count: failedSources.length,
      degraded_extraction_count: degradedExtractionCount,
      metadata_only_count: metadataOnlyCount,
      failed_extraction_count: failedExtractionCount,
      average_relevance: roundRatio(averageRelevance),
      average_confidence: roundRatio(averageConfidence),
      average_source_weight: roundRatio(averageSourceWeight),
      average_freshness: roundRatio(averageFreshness),
      non_redundancy: roundRatio(nonRedundancy),
      matched_required_source_types: requiredMatches,
      missing_required_source_types: missingRequired,
      failed_important_sources: failedImportantSources
    }
  });
}

function isPrimaryLike(chunk: NormalizedChunk): boolean {
  return (
    chunk.metadata.epistemic_stance === "primary_source" ||
    ["government", "filing", "structured_fact", "medical"].includes(chunk.metadata.source_type)
  );
}

function isDegradedExtraction(chunk: NormalizedChunk): boolean {
  const status = chunk.metadata.extraction?.extraction_status;
  return status === "structured_abstract" || status === "snippet" || status === "metadata_only" || status === "failed";
}

function importantSourcesForIntent(intent: IntentObject): Set<SourceName> {
  const sources = new Set<SourceName>();
  for (const type of intent.required_source_types) {
    if (type === "academic") ["arxiv", "semantic_scholar", "openalex", "crossref"].forEach((source) => sources.add(source as SourceName));
    if (type === "government") ["official_docs", "data_gov"].forEach((source) => sources.add(source as SourceName));
    if (type === "filing" || type === "primary-document") ["official_docs", "sec_edgar"].forEach((source) => sources.add(source as SourceName));
    if (type === "encyclopedic") sources.add("wikipedia");
    if (type === "medical") sources.add("pubmed");
    if (type === "code") sources.add("github");
  }
  if (intent.query_type.includes("fresh-fact")) {
    sources.add("official_docs");
    sources.add("data_gov");
  }
  if (intent.query_type.includes("source-attribution") || intent.query_type.includes("adversarial")) {
    ["official_docs", "data_gov", "sec_edgar", "wikidata"].forEach((source) => sources.add(source as SourceName));
  }
  return sources;
}

function matchedRequiredSourceTypes(chunks: NormalizedChunk[], required: RequiredSourceType[]): RequiredSourceType[] {
  return required.filter((type) =>
    chunks.some((chunk) => {
      if (type === "primary-document") return isPrimaryLike(chunk);
      if (type === "news") return false;
      return chunk.metadata.source_type === type;
    })
  );
}

function computeNonRedundancy(deduplication: Trace["deduplication"], selectedCount: number): number {
  const rejected = deduplication.clusters.reduce((total, cluster) => total + cluster.rejected_ids.length, 0);
  if (selectedCount === 0 && rejected === 0) return 0;
  return Math.max(0, Math.min(1, selectedCount / Math.max(1, selectedCount + rejected)));
}

function claimCoverage(claimCount: number): number {
  return Math.min(1, claimCount / 8);
}

function sourceAuthorityIntentBonus(intent: IntentObject, primarySourceCount: number): number {
  const needsPrimary =
    intent.query_type.some((type) => ["fresh-fact", "source-attribution", "adversarial"].includes(type)) ||
    intent.required_source_types.some((type) => ["primary-document", "government", "filing"].includes(type));
  if (!needsPrimary) return 0.08;
  return primarySourceCount > 0 ? 0.1 : -0.14;
}

function buildFailureWarnings(important: SourceName[], failed: SourceName[]): string[] {
  if (important.length > 0) return [`Important routed sources failed: ${important.join(", ")}.`];
  if (failed.length > 0) return [`Some routed sources failed: ${failed.join(", ")}.`];
  return [];
}

function buildReasons(input: {
  evidenceQuality: number;
  evidenceCoverage: number;
  selectedClaimCount: number;
  sourceTypeCount: number;
  primarySourceCount: number;
  failedImportantSources: SourceName[];
  missingRequired: RequiredSourceType[];
  averageRelevance: number;
  nearZeroRelevanceCount: number;
  degradedExtractionCount: number;
  metadataOnlyCount: number;
  failedExtractionCount: number;
}): string[] {
  const reasons: string[] = [];
  reasons.push(`${input.selectedClaimCount} selected atomic claims across ${input.sourceTypeCount} source type(s).`);
  reasons.push(`${input.primarySourceCount} primary/official source(s) represented.`);
  if (input.failedImportantSources.length > 0) reasons.push(`Important source failures lowered evidence quality.`);
  if (input.missingRequired.length > 0) reasons.push(`Missing expected source types: ${input.missingRequired.join(", ")}.`);
  if (input.averageRelevance < 0.35) reasons.push(`Selected context has low query relevance (${input.averageRelevance.toFixed(2)} average).`);
  if (input.nearZeroRelevanceCount > 0) reasons.push(`${input.nearZeroRelevanceCount} selected chunk(s) had near-zero contextual relevance.`);
  if (input.degradedExtractionCount > 0) reasons.push(`${input.degradedExtractionCount} selected chunk(s) came from degraded extraction.`);
  if (input.metadataOnlyCount > 0 || input.failedExtractionCount > 0) reasons.push("Some selected chunks can establish existence only, not detailed claim support.");
  if (input.evidenceQuality >= 80 && input.evidenceCoverage >= 80) reasons.push("Evidence is strong enough for synthesis with normal caveats.");
  return reasons.slice(0, 4);
}

function statusForScore(score: number): EvidenceHealth["status"] {
  if (score >= 80) return "strong";
  if (score >= 60) return "adequate";
  if (score >= 35) return "weak";
  return "insufficient";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value: number): number {
  return clampScore(value * 100);
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function roundRatio(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
