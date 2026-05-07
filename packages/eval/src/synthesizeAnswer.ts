import { estimateTokens, type CitedSource, type PipelineResponse } from "@agent-search/shared";
import type { LLMProvider } from "@agent-search/shared";
import { AnswerSynthesisResponseSchema, buildAnswerSynthesisPrompt, structuredCall } from "@agent-search/llm";

export interface SynthesizedAnswer {
  final_answer: string;
  sources_cited: CitedSource[];
  token_count: number;
}

export function synthesizeAnswerFromChunks(response: PipelineResponse): SynthesizedAnswer {
  const sourceLines = response.chunks.map((chunk, index) => {
    const title = chunk.metadata.title ?? chunk.metadata.url;
    const claims = chunk.metadata.claim_graph.map((claim) => claim.claim).slice(0, 3).join(" ");
    return `${index + 1}. ${title}: ${chunk.metadata.summary ?? claims ?? chunk.content.slice(0, 280)}`;
  });
  const finalAnswer =
    sourceLines.length > 0
      ? `Search engine returned ${sourceLines.length} selected evidence chunks:\n\n${sourceLines.join("\n\n")}`
      : "Search engine returned no selected chunks.";
  return {
    final_answer: finalAnswer,
    sources_cited: response.chunks.map((chunk) => ({
      url: chunk.metadata.url,
      title: chunk.metadata.title,
      source_name: chunk.metadata.source_name,
      source_type: chunk.metadata.source_type,
      provenance: provenanceForStance(chunk.metadata.epistemic_stance)
    })),
    token_count: estimateTokens(finalAnswer)
  };
}

export async function synthesizeAnswerFromChunksLLM(
  response: PipelineResponse,
  provider?: LLMProvider,
  timeoutMs?: number
): Promise<SynthesizedAnswer> {
  if (!provider || response.chunks.length === 0) return synthesizeAnswerFromChunks(response);
  const result = await structuredCall(
    provider,
    {
      task: "answer_synthesizer",
      stage: "synthesis",
      schemaName: "AnswerSynthesisResponse",
      prompt: buildAnswerSynthesisPrompt({ query: response.query, chunks: response.chunks }),
      timeoutMs,
      metadata: { stage: "synthesis", query: response.query }
    },
    AnswerSynthesisResponseSchema,
    { maxAttempts: 2, timeoutMs }
  );
  if (!result.ok) return synthesizeAnswerFromChunks(response);
  return {
    final_answer: result.value.final_answer,
    sources_cited: response.chunks
      .filter((chunk) => result.value.cited_chunk_ids.length === 0 || result.value.cited_chunk_ids.includes(chunk.id))
      .map((chunk) => ({
        url: chunk.metadata.url,
        title: chunk.metadata.title,
        source_name: chunk.metadata.source_name,
        source_type: chunk.metadata.source_type,
        provenance: provenanceForStance(chunk.metadata.epistemic_stance)
      })),
    token_count: estimateTokens(result.value.final_answer)
  };
}

function provenanceForStance(stance: PipelineResponse["chunks"][number]["metadata"]["epistemic_stance"]) {
  if (stance === "primary_source") return "primary" as const;
  if (stance === "secondary_analysis") return "secondary" as const;
  if (stance === "tertiary_summary") return "tertiary" as const;
  if (stance === "opinion") return "forum/opinion" as const;
  return "unknown" as const;
}
