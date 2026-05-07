import type { FastifyInstance } from "fastify";
import { runComparison } from "@agent-search/eval";
import { makeMockRawItems, runPipeline } from "@agent-search/core";
import { getEnv } from "../env.js";
import { createConfiguredLLMProvider, createConfiguredProviderForModel } from "../llm.js";

export async function registerCompareRoutes(app: FastifyInstance) {
  app.get("/compare", async () => {
    const env = getEnv();
    return runComparison({
      runEngine: async (question) =>
        runPipeline(
          { query: question.question, token_budget: 1800 },
          {
            mockRawItems: env.llmProvider === "mock" ? makeMockRawItems(question.question) : undefined,
            llmProvider: createConfiguredLLMProvider(),
            stageModels: env.llmModels,
            reliabilityDbPath: env.reliabilityDbPath,
            llmTimeoutMs: env.llmTimeoutMs,
            stage6ScoringConcurrency: env.stage6ScoringConcurrency,
            synthesisReviewTimeoutMs: env.synthesisReviewTimeoutMs,
            prerankMaxLlmChunks: env.prerankMaxLlmChunks,
            maxRepairRounds: env.maxRepairRounds,
            repairTimeBudgetMs: env.repairTimeBudgetMs,
            apiKeys: { core: env.coreApiKey, github: env.githubToken, semanticScholar: env.semanticScholarApiKey },
            secUserAgent: env.secUserAgent
          }
        )
      ,
      synthesisProvider: createConfiguredProviderForModel(env.llmModels.synthesis),
      adjudicatorProvider: createConfiguredProviderForModel(env.llmModels.adjudicator),
      llmTimeoutMs: env.llmTimeoutMs
    });
  });
}
