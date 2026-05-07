import {
  ALLOWED_SOURCE_NAMES,
  QUERY_TYPES,
  REQUIRED_SOURCE_TYPES,
  RETRIEVAL_INTENTS
} from "@agent-search/shared";
import type { EvidenceHealth, GapAnalysis, GoldAnswer, IntentObject, NormalizedChunk, PipelineRequest, SourceDescriptor } from "@agent-search/shared";

export const SOURCE_AWARE_BENCHMARK_POLICY = `You are the structured planning layer for a source-first search engine for LLMs.
Optimize for answerability with inspectable evidence, not fluent speculation.
Benchmarks reward primary evidence, correct source-type coverage, dedup-resistant planning, explicit recency handling, and useful contrarian checks.
Benchmarks penalize generic web-style searches, unsupported claims, shallow summaries for domain-depth questions, fabricated citations, and source names outside the Day 1 allowlist.`;

export const DAY1_SOURCE_GUIDE = `Allowed Day 1 source names: ${ALLOWED_SOURCE_NAMES.join(", ")}.
Source map:
- filings and company disclosures: sec_edgar
- government datasets, public agencies, official statistics: data_gov
- constrained official public documentation and guidance: official_docs
- structured facts and identifiers: wikidata
- encyclopedic background: wikipedia
- papers and scholarly metadata: arxiv, semantic_scholar, openalex, crossref
- biomedical literature: pubmed
- open access metadata or text: core
- code and repository evidence: github
- technical/community discussion: stack_exchange, hacker_news
There is no generic open-web or news source in Day 1; use primary documents, official data, academic sources, and structured facts instead.`;

function buildSourceGuide(sourceDescriptors?: SourceDescriptor[]): string {
  if (!sourceDescriptors || sourceDescriptors.length === 0) return DAY1_SOURCE_GUIDE;
  const lines = sourceDescriptors.map((source) => {
    const label = source.label && source.label !== source.id ? ` (${source.label})` : "";
    const sourceType = source.source_type ? ` [${source.source_type}]` : "";
    const description = source.description ? `: ${source.description}` : "";
    return `- ${source.id}${label}${sourceType}${description}`;
  });
  return `Allowed source names:
${lines.join("\n")}
There is no generic open-web source unless a host app explicitly registers one. Prefer primary documents, official data, academic sources, structured facts, and host-registered research sources.`;
}

export interface Stage1IntentPromptParams {
  request: PipelineRequest;
  now?: Date | string;
}

export interface Stage2StrategyPromptParams {
  request: Pick<PipelineRequest, "query" | "chat_history" | "memory_snippet">;
  intent: IntentObject;
  maxSubQueries?: number;
  now?: Date | string;
  sourceDescriptors?: SourceDescriptor[];
}

export interface Stage6ScoringPromptParams {
  request: Pick<PipelineRequest, "query" | "memory_snippet">;
  intent: IntentObject;
  chunks: NormalizedChunk[];
  now?: Date | string;
}

export interface AnswerSynthesisPromptParams {
  query: string;
  chunks: NormalizedChunk[];
}

export interface SynthesisReviewPromptParams {
  query: string;
  draftAnswer: string;
  chunks: NormalizedChunk[];
  evidenceHealth?: EvidenceHealth;
  gapAnalysis?: GapAnalysis;
}

export interface AdjudicatorPromptParams {
  questionId: string;
  finalAnswer: string;
  gold?: GoldAnswer;
  sources: Array<{ title?: string | null; url?: string; source_name?: string; source_type?: string; provenance?: string }>;
}

export function buildStage1IntentPrompt(params: Stage1IntentPromptParams): string {
  const { request } = params;
  return `${SOURCE_AWARE_BENCHMARK_POLICY}

Task: classify the user's information need into the IntentObject JSON schema.

Required JSON object:
{"core_intent": string, "query_type": string[], "entities": string[], "temporal_constraints": string|null, "required_source_types": string[]}

Rules:
- Return exactly one JSON object. Do not wrap it in markdown. Do not add commentary.
- Include every required key exactly as shown. Do not add extra top-level keys.
- Use only these query_type labels: ${QUERY_TYPES.join(", ")}.
- Use only these required_source_types labels: ${REQUIRED_SOURCE_TYPES.join(", ")}.
- query_type may contain multiple labels when useful.
- temporal_constraints must be a concrete phrase from the query, a normalized date/year/range, or null.
- entities should include people, organizations, products, papers, laws, datasets, tickers, repos, places, and named events.
- core_intent should be one concise sentence that preserves the user's actual goal.
- Day 1 has no generic news handler. Avoid required_source_types "news" unless the user explicitly asks for news sources; for current factual questions prefer government, academic, primary-document, encyclopedic, filing, or structured sources.
- Output only JSON with keys: core_intent, query_type, entities, temporal_constraints, required_source_types.

Current date: ${formatNow(params.now)}
User query: ${request.query}
Memory snippet: ${request.memory_snippet ?? "(none)"}
Recent chat history:
${formatChatHistory(request.chat_history)}`;
}

export function buildStage2StrategyPrompt(params: Stage2StrategyPromptParams): string {
  const maxSubQueries = params.maxSubQueries ?? 4;
  const sourceGuide = buildSourceGuide(params.sourceDescriptors);
  return `${SOURCE_AWARE_BENCHMARK_POLICY}

${sourceGuide}

Task: convert the IntentObject into a retrieval strategy. Split the work into focused SubQuery objects.

Required JSON object:
{"sub_queries":[{"sub_query": string, "target_sources": string[], "retrieval_intent": string, "max_results": number}]}

Rules:
- Return exactly one JSON object. Do not wrap it in markdown. Do not add commentary.
- Include only the "sub_queries" top-level key.
- Each sub_query item must include exactly: sub_query, target_sources, retrieval_intent, max_results.
- Every target_sources value must be from the allowed source names listed above.
- Use only these retrieval_intent labels: ${RETRIEVAL_INTENTS.join(", ")}.
- Produce 1 to ${maxSubQueries} sub_queries.
- Set max_results from 1 to 10; prefer 4 to 6 unless the query clearly needs breadth.
- Do not be stingy: simple or short factual queries still need at least one broad context source and one corroborating source family when available.
- For fresh market, commodity, macro, policy, or current-data questions, include official data plus at least one contextual/corroborating family such as wikipedia/wikidata and openalex/crossref when relevant.
- Favor primary_evidence for filings, official data, papers, code, and medical literature.
- Add corroborating queries when one source family is not enough.
- Add contrarian queries for disputed, adversarial, or claim-checking questions.
- Add temporal queries for fresh facts, dates, versions, releases, and policy changes.
- Keep each sub_query concrete enough for a source API, not a final-answer instruction.

Current date: ${formatNow(params.now)}
User query: ${params.request.query}
Memory snippet: ${params.request.memory_snippet ?? "(none)"}
IntentObject:
${JSON.stringify(params.intent, null, 2)}
Recent chat history:
${formatChatHistory(params.request.chat_history)}`;
}

export function buildStage6ChunkScoringPrompt(params: Stage6ScoringPromptParams): string {
  const candidates = params.chunks.map((chunk) => ({
    id: chunk.id,
    source_name: chunk.metadata.source_name,
    source_type: chunk.metadata.source_type,
    title: chunk.metadata.title,
    publish_date: chunk.metadata.publish_date,
    author: chunk.metadata.author,
    current_source_weight: chunk._internal.source_weight,
    extraction: chunk.metadata.extraction
      ? {
          canonical_url: chunk.metadata.extraction.canonical_url,
          document_type: chunk.metadata.extraction.document_type,
          retrieval_method: chunk.metadata.extraction.retrieval_method,
          extraction_method: chunk.metadata.extraction.extraction_method,
          extraction_status: chunk.metadata.extraction.extraction_status,
          extraction_confidence: chunk.metadata.extraction.extraction_confidence,
          content_coverage: chunk.metadata.extraction.content_coverage,
          degradation_reason: chunk.metadata.extraction.degradation_reason ?? null
        }
      : null,
    summary: truncateForPrompt(chunk.metadata.summary ?? "", 220),
    content: truncateForPrompt(chunk.content, 600)
  }));

  return `${SOURCE_AWARE_BENCHMARK_POLICY}

Task: score retrieved chunks for final answer selection.

Required JSON object:
{"scores":[{"chunk_id": string, "relevance_to_query": number, "confidence_score": number, "freshness_fitness": number, "surprise_score": number, "claim_graph": [{"claim": string, "claim_type": "asserted"|"cited"|"quoted"|"disputed", "supporting_text_offset": [number, number]}], "epistemic_stance": "primary_source"|"secondary_analysis"|"tertiary_summary"|"opinion"|"speculation", "summary": string|null}]}

Rules:
- Return exactly one JSON object. Do not wrap it in markdown. Do not add commentary.
- Include only the "scores" top-level key.
- Return one score per candidate id, and copy each candidate id exactly into "chunk_id".
- relevance_to_query, confidence_score, freshness_fitness, and surprise_score must be numbers from 0 to 1.
- epistemic_stance must be one of: primary_source, secondary_analysis, tertiary_summary, opinion, speculation.
- claim_graph must list atomic supported claims. Each claim object must be exactly {"claim": string, "claim_type": "asserted"|"cited"|"quoted"|"disputed", "supporting_text_offset": [number, number]}.
- Use "asserted" for normal supported claims. Do not invent alternate claim_type labels.
- supporting_text_offset must be a two-number array, not an object.
- confidence_score should reward source authority and direct support, not prose polish.
- Respect extraction quality: full_text/section_text can score normally; structured_abstract is summary-level only; snippet is weak; metadata_only or failed cannot support detailed claims.
- Cap confidence_score for degraded evidence: structured_abstract <= 0.55, snippet <= 0.35, metadata_only <= 0.15, failed <= 0.08.
- freshness_fitness should be high only when the date is fit for the user's temporal need.
- surprise_score should be high for non-obvious, answer-changing, or contrarian evidence.
- Penalize chunks that are generic background when the query needs domain-depth evidence.

Current date: ${formatNow(params.now)}
User query: ${params.request.query}
Memory snippet: ${params.request.memory_snippet ?? "(none)"}
IntentObject:
${JSON.stringify(params.intent, null, 2)}
Candidates:
${JSON.stringify(candidates, null, 2)}`;
}

export function buildAnswerSynthesisPrompt(params: AnswerSynthesisPromptParams): string {
  const evidence = params.chunks.map((chunk) => ({
    chunk_id: chunk.id,
    source: chunk.metadata.source_name,
    source_type: chunk.metadata.source_type,
    title: chunk.metadata.title,
    url: chunk.metadata.url,
    claims: chunk.metadata.claim_graph.map((claim) => claim.claim),
    content: truncateForPrompt(chunk.content, 1400)
  }));

  return `${SOURCE_AWARE_BENCHMARK_POLICY}

Task: synthesize a final answer for the user's query using only the selected evidence chunks.
Purpose of this call: you are the user-facing answer writer for an evidence engine; convert the selected, scored chunks into a direct answer with claim-level citations.

Required JSON object:
{"final_answer": string, "cited_chunk_ids": string[], "caveats": string[]}

Rules:
- Return exactly one JSON object. Do not wrap it in markdown. Do not add commentary.
- Include every required key exactly as shown. Do not add extra top-level keys.
- final_answer must directly answer the user's query in prose.
- final_answer must not start with "Synthesized from" or describe itself as a source inventory.
- Do not output a numbered inventory of chunks, sources, or findings unless the user explicitly asked for a list.
- Cite claims inline using chunk ids in square brackets, e.g. [chunk_id].
- Put each citation beside the specific claim it supports.
- Do not cite sources or facts that are not present in the evidence.
- Preserve uncertainty and caveats. Do not make benchmark-win claims.
- If evidence is thin, say what is missing.

User query: ${params.query}
Evidence chunks:
${JSON.stringify(evidence, null, 2)}`;
}

export function buildSynthesisReviewPrompt(params: SynthesisReviewPromptParams): string {
  const evidence = params.chunks.map((chunk) => ({
    chunk_id: chunk.id,
    source: chunk.metadata.source_name,
    source_type: chunk.metadata.source_type,
    title: chunk.metadata.title,
    url: chunk.metadata.url,
    relevance_to_query: chunk._internal.relevance_to_query,
    confidence_score: chunk.metadata.confidence_score,
    epistemic_stance: chunk.metadata.epistemic_stance,
    claims: chunk.metadata.claim_graph.map((claim) => claim.claim).slice(0, 8),
    content_preview: truncateForPrompt(chunk.content, 260)
  }));

  return `${SOURCE_AWARE_BENCHMARK_POLICY}

Task: review and improve a synthesized answer when retrieval evidence may be weak.

Required JSON object:
{"final_answer": string, "coverage_status": "answered"|"partially_answered"|"insufficient_evidence", "addressed_questions": string[], "remaining_gaps": string[], "unsupported_or_weak_claims": string[], "source_backed_claims": string[], "model_prior_notes": string[], "keyword_context_warnings": string[], "cited_chunk_ids": string[]}

Rules:
- Return exactly one JSON object. Do not wrap it in markdown. Do not add commentary.
- Include every required key exactly as shown. Do not add extra top-level keys.
- final_answer must directly address the user's actual question in prose, not just keywords from retrieved chunks.
- final_answer must use inline chunk citations next to supported claims, e.g. [chunk_id].
- final_answer must not start with "Synthesized from" or become a numbered source/finding inventory unless the user explicitly asked for a list.
- You may use general model knowledge to fill obvious connective tissue or explain what thin evidence means, but do not fabricate source-backed claims.
- Citations must only reference chunk_ids that appear in the evidence list.
- Separate source-backed claims from model-prior reasoning in the arrays.
- If retrieved chunks are keyword-adjacent but not contextually useful, say so in keyword_context_warnings and write cautiously.

User query:
${params.query}

Draft answer:
${params.draftAnswer}

Evidence health:
${JSON.stringify(params.evidenceHealth ?? null, null, 2)}

Gap analysis:
${JSON.stringify(params.gapAnalysis ?? null, null, 2)}

Selected evidence chunks:
${JSON.stringify(evidence, null, 2)}`;
}

export function buildAdjudicatorPrompt(params: AdjudicatorPromptParams): string {
  return `${SOURCE_AWARE_BENCHMARK_POLICY}

Task: adjudicate whether a final answer is supported by the gold benchmark and cited sources.

Rules:
- Output only JSON shaped as {"supported_atomic_fact_ids": string[], "hallucination_flags": string[], "unsourced_claims": string[], "notes": string[], "confidence": number}.
- Judge claim support, not prose style.
- Do not give credit for claims without source support.
- Do not treat consensus as truth.

Question id: ${params.questionId}
Gold answer:
${params.gold?.gold_answer ?? "(gold unavailable)"}
Atomic facts:
${JSON.stringify(params.gold?.must_hit_atomic_facts ?? [], null, 2)}
Required sources:
${JSON.stringify(params.gold?.required_source_types ?? [], null, 2)}
Final answer:
${params.finalAnswer}
Cited sources:
${JSON.stringify(params.sources, null, 2)}`;
}

export function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}

function formatNow(now: Date | string | undefined): string {
  if (!now) {
    return new Date().toISOString();
  }

  return now instanceof Date ? now.toISOString() : now;
}

function formatChatHistory(chatHistory: PipelineRequest["chat_history"]): string {
  if (!chatHistory || chatHistory.length === 0) {
    return "(none)";
  }

  return chatHistory
    .slice(-6)
    .map((message) => `${message.role}: ${truncateForPrompt(message.content, 400)}`)
    .join("\n");
}
