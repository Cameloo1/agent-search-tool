import type { BuiltInSourceName, NormalizedSourceType, SourceName } from "./types.js";

export const SOURCE_WEIGHTS: Record<BuiltInSourceName, number> = {
  sec_edgar: 0.98,
  data_gov: 0.95,
  wikidata: 0.86,
  wikipedia: 0.72,
  arxiv: 0.88,
  semantic_scholar: 0.86,
  pubmed: 0.93,
  openalex: 0.84,
  core: 0.8,
  crossref: 0.82,
  github: 0.74,
  stack_exchange: 0.58,
  hacker_news: 0.42,
  official_docs: 0.92
};

export const SOURCE_TYPE_WEIGHTS: Record<NormalizedSourceType, number> = {
  filing: 0.98,
  government: 0.95,
  medical: 0.93,
  academic: 0.87,
  structured_fact: 0.86,
  code: 0.74,
  encyclopedic: 0.72,
  forum: 0.55,
  tech_discussion: 0.42,
  other: 0.35
};

export function getSourceWeight(source: SourceName, sourceType?: NormalizedSourceType): number {
  return Math.max(SOURCE_WEIGHTS[source as BuiltInSourceName] ?? 0.35, sourceType ? SOURCE_TYPE_WEIGHTS[sourceType] ?? 0.35 : 0.35);
}
