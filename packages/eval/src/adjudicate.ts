import { AdjudicatorResponseSchema, buildAdjudicatorPrompt, structuredCall } from "@agent-search/llm";
import { EvaluationResultSchema, type CitedSource, type EvaluationResult, type GoldAnswer, type LLMProvider } from "@agent-search/shared";

export async function adjudicateEvaluation(
  evaluation: EvaluationResult,
  params: {
    provider?: LLMProvider;
    questionId: string;
    finalAnswer: string;
    gold?: GoldAnswer;
    sources: CitedSource[];
    timeoutMs?: number;
  }
): Promise<EvaluationResult> {
  if (!params.provider || !params.gold || !params.finalAnswer.trim()) return evaluation;
  const result = await structuredCall(
    params.provider,
    {
      task: "gold_answer_adjudicator",
      stage: "adjudicator",
      schemaName: "AdjudicatorResponse",
      prompt: buildAdjudicatorPrompt({
        questionId: params.questionId,
        finalAnswer: params.finalAnswer,
        gold: params.gold,
        sources: params.sources
      }),
      timeoutMs: params.timeoutMs,
      metadata: { stage: "adjudicator", questionId: params.questionId }
    },
    AdjudicatorResponseSchema,
    { maxAttempts: 2, timeoutMs: params.timeoutMs }
  );
  if (!result.ok) return evaluation;

  const supported = new Set(result.value.supported_atomic_fact_ids);
  const factsHit = Math.max(evaluation.facts_hit, params.gold.must_hit_atomic_facts.filter((fact) => supported.has(fact.id)).length);
  return EvaluationResultSchema.parse({
    ...evaluation,
    facts_hit: factsHit,
    hallucination_flags: Array.from(new Set([...evaluation.hallucination_flags, ...result.value.hallucination_flags])),
    unsourced_claims: Array.from(new Set([...evaluation.unsourced_claims, ...result.value.unsourced_claims])),
    notes: [
      ...evaluation.notes,
      `adjudicator_confidence=${result.value.confidence}`,
      ...result.value.notes.map((note) => `adjudicator:${note}`)
    ]
  });
}
