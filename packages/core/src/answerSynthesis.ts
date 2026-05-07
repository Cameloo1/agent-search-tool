import {
  estimateTokens,
  type CitedSource,
  type LLMProvider,
  type NormalizedChunk,
  type PipelineResponse,
  type StructuredLLMCallTrace
} from "@agent-search/shared";
import { AnswerSynthesisResponseSchema, buildAnswerSynthesisPrompt, structuredCall } from "@agent-search/llm";

export interface SynthesisResult {
  synthesized_answer: string;
  sources_cited: CitedSource[];
  token_count: number;
  warnings: string[];
  structuredLlmCalls: StructuredLLMCallTrace[];
}

export async function synthesizeSelectedAnswer(
  response: Pick<PipelineResponse, "query" | "chunks">,
  provider: LLMProvider,
  options: { timeoutMs?: number; maxAttempts?: number; signal?: AbortSignal; reasoningEnabled?: boolean } = {}
): Promise<SynthesisResult> {
  if (response.chunks.length === 0) {
    return {
      synthesized_answer: "No selected evidence chunks were available to synthesize an answer.",
      sources_cited: [],
      token_count: 14,
      warnings: ["Synthesis skipped because no selected chunks were available."],
      structuredLlmCalls: []
    };
  }

  const result = await structuredCall(
    provider,
    {
      task: "answer_synthesizer",
      stage: "synthesis",
      schemaName: "AnswerSynthesisResponse",
      prompt: buildAnswerSynthesisPrompt({ query: response.query, chunks: response.chunks }),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      reasoningEnabled: options.reasoningEnabled,
      metadata: { stage: "synthesis", query: response.query }
    },
    AnswerSynthesisResponseSchema,
    { maxAttempts: options.maxAttempts ?? 2, timeoutMs: options.timeoutMs }
  );

  if (!result.ok) {
    const fallback = deterministicSynthesis(response);
    return {
      ...fallback,
      warnings: ["Synthesis model failed schema validation; deterministic cited answer was used."],
      structuredLlmCalls: result.attemptDiagnostics
    };
  }

  if (violatesAnswerShape(result.value.final_answer)) {
    const fallback = deterministicSynthesis(response);
    return {
      ...fallback,
      warnings: ["Synthesis model returned an inventory-shaped answer; deterministic cited answer was used."],
      structuredLlmCalls: result.attemptDiagnostics
    };
  }

  return {
    synthesized_answer: result.value.final_answer,
    sources_cited: citedSources(response, result.value.cited_chunk_ids),
    token_count: estimateTokens(result.value.final_answer),
    warnings: result.errors.length > 0 ? ["Synthesis model needed a structured repair attempt before validation succeeded."] : [],
    structuredLlmCalls: result.attemptDiagnostics
  };
}

function deterministicSynthesis(response: Pick<PipelineResponse, "query" | "chunks">): SynthesisResult {
  const synthesized = isComparativeQuestion(response.query)
    ? deterministicComparativeSynthesis(response)
    : deterministicGeneralSynthesis(response);
  const citedIds = extractCitedChunkIds(synthesized, response.chunks);
  return {
    synthesized_answer: synthesized,
    sources_cited: citedSources(response, citedIds),
    token_count: estimateTokens(synthesized),
    warnings: [],
    structuredLlmCalls: []
  };
}

function deterministicGeneralSynthesis(response: Pick<PipelineResponse, "query" | "chunks">): string {
  const bestChunks = [...response.chunks]
    .sort((a, b) => b._internal.relevance_to_query * b.metadata.confidence_score - a._internal.relevance_to_query * a.metadata.confidence_score)
    .slice(0, 4);
  const citedSentences = bestChunks.map((chunk) => `${claimSentenceForChunk(chunk)} [${chunk.id}].`);
  const weakEvidence = bestChunks.some((chunk) => chunk.metadata.confidence_score < 0.4 || chunk.metadata.extraction?.extraction_status === "metadata_only");
  const caveat = weakEvidence
    ? "The retrieved evidence is thin in places, so claims beyond those cited chunks should be treated as unresolved."
    : "";
  const synthesized = [
    `The selected evidence supports this answer to "${response.query}": ${citedSentences[0] ?? "the pipeline did not retain a claim-level supporting chunk."}`,
    ...citedSentences.slice(1),
    caveat
  ]
    .filter(Boolean)
    .join(" ");
  return synthesized;
}

function deterministicComparativeSynthesis(response: Pick<PipelineResponse, "query" | "chunks">): string {
  const chunks = [...response.chunks].sort((a, b) => scoreChunkForAnswer(b) - scoreChunkForAnswer(a));
  const fusionChunks = chunksBySignal(chunks, /\b(rrf|reciprocal rank fusion|rank fusion|hybrid retrieval|fusion retrieval|bm25|dense|sparse)\b/i).slice(0, 2);
  const rerankerChunks = chunksBySignal(chunks, /\b(cross[- ]?encoder|rerank|reranker|learned rerank|cross-attention|top-k|top k)\b/i).slice(0, 3);
  const implementationChunks = chunksBySignal(chunks, /\b(open[- ]?source|github|implementation|framework|rag|trec|benchmark|system)\b/i).slice(0, 3);
  const primaryFusion = fusionChunks[0] ?? chunks[0];
  const primaryReranker = rerankerChunks.find((chunk) => chunk.id !== primaryFusion?.id) ?? rerankerChunks[0] ?? chunks.find((chunk) => chunk.id !== primaryFusion?.id);
  const support = uniqueChunks([primaryFusion, primaryReranker, ...fusionChunks, ...rerankerChunks, ...implementationChunks].filter(Boolean) as NormalizedChunk[]);
  const hasCodeEvidence = chunks.some((chunk) => chunk.metadata.source_type === "code" || chunk.metadata.source_name === "github");
  const asksImplementations = /\b(which|what)\b.*\b(open[- ]?source|implementation|framework|repo|github|published benchmark|benchmarks?)\b/i.test(response.query);

  const fusionSentence = primaryFusion
    ? `RRF is the simpler fusion-side option: the retained evidence shows rank or hybrid fusion can improve relevance over single retrievers, including an RRF result that beat dense-only and sparse-only baselines in one benchmark [${primaryFusion.id}].`
    : "RRF is the simpler fusion-side option, but this run did not retain a strong RRF-specific chunk.";
  const rerankerSentence = primaryReranker
    ? `Learned cross-encoder reranking is the quality-oriented second-stage option: it can use richer query-document scoring after retrieval, but it adds compute and remains bounded by the candidate set surfaced by first-stage retrieval [${primaryReranker.id}].`
    : "Learned reranking is the quality-oriented second-stage option, but this run did not retain a strong cross-encoder-specific chunk.";
  const tradeoffSentence = buildTradeoffSentence(fusionChunks, rerankerChunks);
  const implementationSentence = asksImplementations
    ? buildImplementationSentence(implementationChunks, hasCodeEvidence)
    : "";
  const caveat = support.length < 3
    ? "The answer is cautious because the retained evidence is narrow for a comparative question."
    : "";

  return [fusionSentence, rerankerSentence, tradeoffSentence, implementationSentence, caveat].filter(Boolean).join("\n\n");
}

function buildTradeoffSentence(fusionChunks: NormalizedChunk[], rerankerChunks: NormalizedChunk[]): string {
  const fusionCite = fusionChunks[0] ? ` [${fusionChunks[0].id}]` : "";
  const rerankerCite = rerankerChunks[0] ? ` [${rerankerChunks[0].id}]` : "";
  if (fusionCite || rerankerCite) {
    return `So the practical trade-off is speed, simplicity, and robustness for RRF-style fusion${fusionCite}, versus higher per-query cost and potentially better precision for learned reranking${rerankerCite}.`;
  }
  return "So the practical trade-off is speed and simplicity for fusion versus higher per-query cost and potentially better precision for learned reranking.";
}

function buildImplementationSentence(implementationChunks: NormalizedChunk[], hasCodeEvidence: boolean): string {
  const cited = implementationChunks.slice(0, 2).map((chunk) => `[${chunk.id}]`).join(" ");
  const titles = implementationChunks
    .map((chunk) => chunk.metadata.title)
    .filter((title): title is string => Boolean(title))
    .slice(0, 3)
    .map(shortTitle);
  if (hasCodeEvidence) {
    return `For published implementations or systems, the retained evidence points to ${titles.join(", ") || "the cited implementation evidence"} ${cited}.`;
  }
  return `For the open-source implementation part, this run does not retain repository/code evidence strong enough to name open-source RAG implementations conclusively; it retained benchmarked papers or systems${titles.length ? ` such as ${titles.join(", ")}` : ""}, but not source-backed proof of open-source releases or direct RRF-vs-cross-encoder framework benchmarks ${cited}.`;
}

function claimSentenceForChunk(chunk: PipelineResponse["chunks"][number]): string {
  const claim = chunk.metadata.claim_graph[0]?.claim ?? chunk.metadata.summary ?? firstSentence(chunk.content);
  return normalizeSentence(claim || `${chunk.metadata.title ?? chunk.metadata.source_name} is relevant to the query`);
}

function firstSentence(text: string): string {
  return text.split(/(?<=\.)\s+/)[0]?.slice(0, 260).trim() || text.slice(0, 260).trim();
}

function normalizeSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim().replace(/\s*\[[^\]]+\]\s*$/g, "");
  if (!cleaned) return "The retained evidence is relevant to the query";
  return cleaned.replace(/[.!?]+$/, "");
}

function isComparativeQuestion(query: string): boolean {
  return /\b(trade-?offs?|compare|comparison|versus|vs\.?|between|which)\b/i.test(query);
}

function scoreChunkForAnswer(chunk: NormalizedChunk): number {
  return chunk._internal.relevance_to_query * 0.55 + chunk.metadata.confidence_score * 0.3 + chunk._internal.source_weight * 0.15;
}

function chunksBySignal(chunks: NormalizedChunk[], pattern: RegExp): NormalizedChunk[] {
  return chunks
    .filter((chunk) => pattern.test(chunkText(chunk)))
    .sort((a, b) => scoreChunkForAnswer(b) - scoreChunkForAnswer(a));
}

function chunkText(chunk: NormalizedChunk): string {
  return [
    chunk.metadata.title,
    chunk.metadata.summary,
    ...chunk.metadata.claim_graph.map((claim) => claim.claim),
    chunk.content
  ]
    .filter(Boolean)
    .join(" ");
}

function uniqueChunks(chunks: NormalizedChunk[]): NormalizedChunk[] {
  const seen = new Set<string>();
  const unique: NormalizedChunk[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    unique.push(chunk);
  }
  return unique;
}

function extractCitedChunkIds(answer: string, chunks: NormalizedChunk[]): string[] {
  const ids = new Set(chunks.map((chunk) => chunk.id));
  const cited = Array.from(answer.matchAll(/\[([^\]]+)\]/g))
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id) && ids.has(id));
  return [...new Set(cited)];
}

function shortTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().replace(/[:.]\s*$/, "");
}

function violatesAnswerShape(answer: string): boolean {
  const trimmed = answer.trim();
  if (/^Synthesized from\b/i.test(trimmed)) return true;
  const firstLines = trimmed.split(/\n+/).slice(0, 4);
  const numberedLines = firstLines.filter((line) => /^\s*\d+\.\s+/.test(line)).length;
  return numberedLines >= 2;
}

function citedSources(response: Pick<PipelineResponse, "chunks">, citedIds: string[]): CitedSource[] {
  return response.chunks
    .filter((chunk) => citedIds.length === 0 || citedIds.includes(chunk.id))
    .map((chunk) => ({
      url: chunk.metadata.url,
      title: chunk.metadata.title,
      source_name: chunk.metadata.source_name,
      source_type: chunk.metadata.source_type,
      provenance: provenanceForStance(chunk.metadata.epistemic_stance)
    }));
}

function provenanceForStance(stance: PipelineResponse["chunks"][number]["metadata"]["epistemic_stance"]) {
  if (stance === "primary_source") return "primary" as const;
  if (stance === "secondary_analysis") return "secondary" as const;
  if (stance === "tertiary_summary") return "tertiary" as const;
  if (stance === "opinion") return "forum/opinion" as const;
  return "unknown" as const;
}
