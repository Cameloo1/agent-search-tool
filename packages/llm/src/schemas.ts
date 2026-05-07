import { ClaimGraphItemSchema, EpistemicStanceSchema, SubQuerySchema } from "@agent-search/shared";
import { z } from "zod";

export const QueryStrategyResponseSchema = z.object({
  sub_queries: z.array(SubQuerySchema).min(1).max(6)
});

export const ChunkScoreItemSchema = z.object({
  chunk_id: z.string().min(1),
  relevance_to_query: z.number().min(0).max(1),
  confidence_score: z.number().min(0).max(1),
  freshness_fitness: z.number().min(0).max(1),
  surprise_score: z.number().min(0).max(1),
  claim_graph: z.array(ClaimGraphItemSchema).default([]),
  epistemic_stance: EpistemicStanceSchema,
  summary: z.string().min(1).nullable().optional(),
  rationale: z.string().min(1).optional()
});

export const ChunkScoringResponseSchema = z.object({
  scores: z.array(ChunkScoreItemSchema)
});

export const AnswerSynthesisResponseSchema = z.object({
  final_answer: z.string().min(1),
  cited_chunk_ids: z.array(z.string()).default([]),
  caveats: z.array(z.string()).default([])
});

const StringArrayFromCommonLLMShape = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (value == null) return [];
  return value;
}, z.array(z.string()).default([]));

const SynthesisCoverageStatusSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const aliases: Record<string, "answered" | "partially_answered" | "insufficient_evidence"> = {
    complete: "answered",
    fully_answered: "answered",
    answered: "answered",
    adequate: "answered",
    supported: "answered",
    mostly_answered: "partially_answered",
    partial: "partially_answered",
    partially_answered: "partially_answered",
    needs_more_evidence: "partially_answered",
    weak: "partially_answered",
    insufficient: "insufficient_evidence",
    insufficient_evidence: "insufficient_evidence",
    not_enough_evidence: "insufficient_evidence",
    unanswered: "insufficient_evidence"
  };
  return aliases[normalized] ?? value;
}, z.enum(["answered", "partially_answered", "insufficient_evidence"]));

export const SynthesisReviewResponseSchema = z.object({
  final_answer: z.string().min(1),
  coverage_status: SynthesisCoverageStatusSchema,
  addressed_questions: StringArrayFromCommonLLMShape,
  remaining_gaps: StringArrayFromCommonLLMShape,
  unsupported_or_weak_claims: StringArrayFromCommonLLMShape,
  source_backed_claims: StringArrayFromCommonLLMShape,
  model_prior_notes: StringArrayFromCommonLLMShape,
  keyword_context_warnings: StringArrayFromCommonLLMShape,
  cited_chunk_ids: StringArrayFromCommonLLMShape
});

export const AdjudicatorResponseSchema = z.object({
  supported_atomic_fact_ids: z.array(z.string()).default([]),
  hallucination_flags: z.array(z.string()).default([]),
  unsourced_claims: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1)
});

export type QueryStrategyResponse = z.infer<typeof QueryStrategyResponseSchema>;
export type ChunkScoreItem = z.infer<typeof ChunkScoreItemSchema>;
export type ChunkScoringResponse = z.infer<typeof ChunkScoringResponseSchema>;
export type AnswerSynthesisResponse = z.infer<typeof AnswerSynthesisResponseSchema>;
export type SynthesisReviewResponse = z.infer<typeof SynthesisReviewResponseSchema>;
export type AdjudicatorResponse = z.infer<typeof AdjudicatorResponseSchema>;
