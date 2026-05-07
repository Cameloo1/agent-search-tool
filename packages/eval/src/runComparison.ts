import { ComparisonItemSchema, type ComparisonItem, type GoldQuestion, type PipelineResponse } from "@agent-search/shared";
import { loadGoldArtifact } from "./questions.js";
import { missingOpponentFixtures } from "./opponentFixtures.js";
import { scoreAgainstGold } from "./scoreAgainstGold.js";
import { synthesizeAnswerFromChunksLLM } from "./synthesizeAnswer.js";
import { adjudicateEvaluation } from "./adjudicate.js";
import type { LLMProvider } from "@agent-search/shared";

export interface RunComparisonOptions {
  runEngine?: (question: GoldQuestion) => Promise<PipelineResponse>;
  synthesisProvider?: LLMProvider;
  adjudicatorProvider?: LLMProvider;
  llmTimeoutMs?: number;
}

export interface ComparisonRun {
  generated_at: string;
  gold_status: "available" | "blocked_missing_gold" | "blocked_invalid_gold";
  items: ComparisonItem[];
}

export async function runComparison(options: RunComparisonOptions = {}): Promise<ComparisonRun> {
  const loaded = loadGoldArtifact();
  if (!loaded.ok) {
    return {
      generated_at: new Date().toISOString(),
      gold_status: "blocked_invalid_gold",
      items: []
    };
  }

  const items: ComparisonItem[] = [];
  for (const question of loaded.artifact.questions) {
    const gold = loaded.artifact.answers.find((answer) => answer.question_id === question.id);
    if (options.runEngine) {
      const started = Date.now();
      const pipeline = await options.runEngine(question);
      const synthesized = await synthesizeAnswerFromChunksLLM(pipeline, options.synthesisProvider, options.llmTimeoutMs);
      const deterministicEvaluation = scoreAgainstGold({
        engineName: "Agent Search Tool",
        questionId: question.id,
        finalAnswer: synthesized.final_answer,
        sources: synthesized.sources_cited,
        tokenCount: synthesized.token_count,
        timeToResultMs: Date.now() - started,
        gold
      });
      const evaluation = await adjudicateEvaluation(deterministicEvaluation, {
        provider: options.adjudicatorProvider,
        questionId: question.id,
        finalAnswer: synthesized.final_answer,
        sources: synthesized.sources_cited,
        gold,
        timeoutMs: options.llmTimeoutMs
      });
      items.push(
        ComparisonItemSchema.parse({
          engine_name: "Agent Search Tool",
          question_id: question.id,
          final_answer: synthesized.final_answer,
          sources_cited: synthesized.sources_cited,
          token_count: synthesized.token_count,
          time_to_result_ms: Date.now() - started,
          mode: "live",
          evaluation,
          pipeline: { ...pipeline, synthesized_answer: synthesized.final_answer, adjudication: evaluation }
        })
      );
    }

    for (const fixture of missingOpponentFixtures(question.id)) {
      items.push(
        ComparisonItemSchema.parse({
          engine_name: fixture.engine_name,
          question_id: question.id,
          final_answer: fixture.final_answer,
          sources_cited: fixture.sources_cited,
          token_count: fixture.token_count,
          time_to_result_ms: fixture.time_to_result_ms,
          mode: fixture.mode,
          evaluation: scoreAgainstGold({
            engineName: fixture.engine_name,
            questionId: question.id,
            finalAnswer: fixture.final_answer,
            sources: fixture.sources_cited,
            tokenCount: fixture.token_count,
            timeToResultMs: fixture.time_to_result_ms,
            gold
          })
        })
      );
    }
  }

  return { generated_at: new Date().toISOString(), gold_status: "available", items };
}
