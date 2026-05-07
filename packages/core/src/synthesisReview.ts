import {
  DEFAULTS,
  SynthesisReviewSchema,
  estimateTokens,
  type GapAnalysis,
  type LLMProvider,
  type NormalizedChunk,
  type StructuredLLMCallTrace,
  type SynthesisReview
} from "@agent-search/shared";
import { SynthesisReviewResponseSchema, buildSynthesisReviewPrompt, structuredCall } from "@agent-search/llm";
import type { EvidenceHealth } from "@agent-search/shared";

export interface SynthesisReviewResult {
  review: SynthesisReview;
  warnings: string[];
  structuredLlmCalls: StructuredLLMCallTrace[];
}

export async function reviewSynthesizedAnswer(
  input: {
    query: string;
    draftAnswer: string;
    chunks: NormalizedChunk[];
    evidenceHealth?: EvidenceHealth;
    gapAnalysis?: GapAnalysis;
  },
  provider: LLMProvider,
  options: { timeoutMs?: number; maxAttempts?: number; signal?: AbortSignal; reasoningEnabled?: boolean } = {}
): Promise<SynthesisReviewResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULTS.synthesisReviewTimeoutMs, DEFAULTS.synthesisReviewTimeoutMs);
  const result = await structuredCall(
    provider,
    {
      task: "cautious_synthesis_reviewer",
      stage: "adjudicator",
      schemaName: "SynthesisReviewResponse",
      prompt: buildSynthesisReviewPrompt(input),
      timeoutMs,
      signal: options.signal,
      reasoningEnabled: options.reasoningEnabled,
      metadata: { stage: "synthesis_review", query: input.query }
    },
    SynthesisReviewResponseSchema,
    {
      maxAttempts: options.maxAttempts ?? 2,
      timeoutMs,
      coerceOutput: (raw) => coerceReviewResponse(raw, input.draftAnswer)
    }
  );

  if (!result.ok) {
    return {
      review: deterministicReview(input),
      warnings: [
        "Synthesis reviewer failed schema validation; deterministic cautious review was used.",
        ...result.errors.slice(0, 2).map((error) => `Synthesis reviewer ${error.code}: ${error.issues.slice(0, 3).join("; ")}`)
      ],
      structuredLlmCalls: result.attemptDiagnostics
    };
  }

  return {
    review: SynthesisReviewSchema.parse(result.value),
    warnings: result.errors.length > 0 ? ["Synthesis reviewer needed a structured repair attempt before validation succeeded."] : [],
    structuredLlmCalls: result.attemptDiagnostics
  };
}

function coerceReviewResponse(raw: unknown, draftAnswer: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (typeof record.final_answer === "string" && record.final_answer.trim()) return raw;
  return { ...record, final_answer: draftAnswer };
}

function deterministicReview(input: {
  query: string;
  draftAnswer: string;
  chunks: NormalizedChunk[];
  evidenceHealth?: EvidenceHealth;
  gapAnalysis?: GapAnalysis;
}): SynthesisReview {
  const status =
    input.evidenceHealth?.status === "insufficient"
      ? "insufficient_evidence"
      : input.evidenceHealth?.status === "weak"
        ? "partially_answered"
        : "answered";
  const gaps = input.gapAnalysis?.reasons ?? input.evidenceHealth?.warnings ?? [];
  const prefix =
    status === "answered"
      ? ""
      : "Evidence is limited, so this answer separates retrieved support from cautious general reasoning.\n\n";
  return SynthesisReviewSchema.parse({
    final_answer: `${prefix}${input.draftAnswer}`,
    coverage_status: status,
    addressed_questions: [input.query],
    remaining_gaps: gaps,
    unsupported_or_weak_claims: gaps,
    source_backed_claims: input.chunks.flatMap((chunk) => chunk.metadata.claim_graph.map((claim) => claim.claim)).slice(0, 10),
    model_prior_notes: status === "answered" ? [] : ["General reasoning may be needed where retrieved evidence is thin."],
    keyword_context_warnings: input.gapAnalysis?.bad_context_reasons ?? [],
    cited_chunk_ids: input.chunks.map((chunk) => chunk.id),
    token_count: estimateTokens(input.draftAnswer)
  });
}
