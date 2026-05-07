import type { FastifyInstance } from "fastify";
import { PipelineRequestSchema, type PipelineProgressEvent, type PipelineRequest } from "@agent-search/shared";
import { makeMockRawItems, runPipeline } from "@agent-search/core";
import { getEnv } from "../env.js";
import { createConfiguredLLMProvider } from "../llm.js";
import {
  isSearchRunFeedbackRating,
  readLatestSearchDebugLog,
  readSearchDebugLog,
  readSearchDebugLogList,
  writeSearchDebugFeedback,
  writeSearchDebugLog
} from "../debugLog.js";

export async function registerSearchRoutes(app: FastifyInstance) {
  app.post("/search", async (request, reply) => {
    const parsed = PipelineRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }

    try {
      const response = await runSearchPipeline(parsed.data);
      await writeSearchDebugLog({ request: parsed.data, response }).catch((error) => {
        request.log.warn({ error }, "search debug log write failed");
      });
      return response;
    } catch (error) {
      await writeSearchDebugLog({ request: parsed.data, error }).catch((debugError) => {
        request.log.warn({ error: debugError }, "search debug log write failed");
      });
      throw error;
    }
  });

  app.post("/search/stream", async (request, reply) => {
    const parsed = PipelineRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.flatten() });
    }

    reply.hijack();
    const response = reply.raw;
    const abortController = new AbortController();
    const events: PipelineProgressEvent[] = [];
    let clientGone = false;

    const markDisconnected = () => {
      if (!response.writableEnded) {
        clientGone = true;
        abortController.abort(new Error("Client disconnected."));
      }
    };

    request.raw.on("aborted", markDisconnected);
    response.on("close", markDisconnected);

    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    });
    response.write(": connected\n\n");

    const writeEvent = (event: PipelineProgressEvent) => {
      events.push(event);
      if (clientGone || response.destroyed || response.writableEnded) return false;
      try {
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        return true;
      } catch (error) {
        clientGone = true;
        abortController.abort(error);
        return false;
      }
    };

    try {
      const pipelineResponse = await runSearchPipeline(parsed.data, {
        abortSignal: abortController.signal,
        onProgress: (event) => {
          writeEvent(event);
        }
      });
      writeEvent({ type: "final", at: new Date().toISOString(), response: pipelineResponse });
      await writeSearchDebugLog({ request: parsed.data, response: pipelineResponse, events }).catch((error) => {
        request.log.warn({ error }, "search debug log write failed");
      });
    } catch (error) {
      const stageErrorEvent: PipelineProgressEvent = {
        type: "stage_error",
        stage: "pipeline",
        message: "Pipeline failed before a final response could be returned.",
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      const fatalEvent: PipelineProgressEvent = {
        type: "fatal",
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      if (!clientGone && !response.destroyed && !response.writableEnded) {
        writeEvent(stageErrorEvent);
        writeEvent(fatalEvent);
      } else {
        events.push(stageErrorEvent, fatalEvent);
      }
      await writeSearchDebugLog({ request: parsed.data, events, error }).catch(() => undefined);
    } finally {
      if (!clientGone && !response.destroyed && !response.writableEnded) {
        response.end();
      }
      request.raw.off("aborted", markDisconnected);
      response.off("close", markDisconnected);
    }
  });

  app.get("/debug/search/latest", async (_request, reply) => {
    const latest = await readLatestSearchDebugLog();
    if (!latest) {
      return reply.status(404).send({ ok: false, error: "No search debug log has been written yet." });
    }
    return latest;
  });

  app.get("/debug/search", async (request) => {
    const query = request.query as { limit?: string };
    const requestedLimit = Number.parseInt(query.limit ?? "12", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 30) : 12;
    return { runs: await readSearchDebugLogList(limit) };
  });

  app.post("/debug/search/:requestId/feedback", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const body = isRecord(request.body) ? request.body : {};
    const rating = body.rating;
    const note = body.note;

    if (!isSearchRunFeedbackRating(rating)) {
      return reply.status(400).send({
        ok: false,
        error: "Feedback rating must be one of: up, neutral, down."
      });
    }

    if (note !== undefined && typeof note !== "string") {
      return reply.status(400).send({ ok: false, error: "Feedback note must be a string when provided." });
    }

    const feedback = await writeSearchDebugFeedback({ requestId, rating, note });
    if (!feedback) {
      return reply.status(404).send({ ok: false, error: `No search debug log found for ${requestId}.` });
    }

    return { ok: true, feedback };
  });

  app.get("/debug/search/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const record = await readSearchDebugLog(requestId);
    if (!record) {
      return reply.status(404).send({ ok: false, error: `No search debug log found for ${requestId}.` });
    }
    return record;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runSearchPipeline(
  request: PipelineRequest,
  options: {
    abortSignal?: AbortSignal;
    onProgress?: (event: PipelineProgressEvent) => void | Promise<void>;
  } = {}
) {
  const env = getEnv();
  const useMockSources = env.llmProvider === "mock";
  return runPipeline(request, {
    mockRawItems: useMockSources ? makeMockRawItems(request.query) : undefined,
    llmProvider: createConfiguredLLMProvider(),
    stageModels: env.llmModels,
    sourceTimeoutMs: env.sourceTimeoutMs,
    maxConcurrency: env.maxConcurrency,
    maxRepairRounds: env.maxRepairRounds,
    repairTimeBudgetMs: env.repairTimeBudgetMs,
    prerankMaxLlmChunks: env.prerankMaxLlmChunks,
    stage6ScoringConcurrency: env.stage6ScoringConcurrency,
    synthesisReviewTimeoutMs: env.synthesisReviewTimeoutMs,
    openRouterPricingCacheTtlMs: env.openRouterPricingCacheTtlMs,
    dedupSimilarityThreshold: env.dedupSimilarityThreshold,
    scoringThreshold: env.scoringThreshold,
    llmTimeoutMs: env.llmTimeoutMs,
    balancedStageModels: env.balancedLlmModels,
    apiKeys: { core: env.coreApiKey, github: env.githubToken, semanticScholar: env.semanticScholarApiKey },
    secUserAgent: env.secUserAgent,
    reliabilityDbPath: env.reliabilityDbPath,
    enableDebugInternals: env.enableDebugInternals,
    abortSignal: options.abortSignal,
    onProgress: options.onProgress
  });
}
