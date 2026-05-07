import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";

describe("api routes", () => {
  let debugRunsDir: string | undefined;

  beforeEach(async () => {
    debugRunsDir = await mkdtemp(join(tmpdir(), "agent-search-debug-runs-"));
    process.env.SEARCH_DEBUG_RUNS_DIR = debugRunsDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.SEARCH_DEBUG_RUNS_DIR;
    if (debugRunsDir) {
      await rm(debugRunsDir, { recursive: true, force: true });
      debugRunsDir = undefined;
    }
  });

  it("serves health", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it("runs search in mock mode", async () => {
    process.env.LLM_PROVIDER = "mock";
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "How do source-attributed pipelines work?", token_budget: 600, quality_mode: "quality" }
    });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.trace.counts.raw_items).toBeGreaterThan(0);
    expect(json.trace.model_usage.strategy.model).toBe("openai/gpt-5.5");
    expect(json.trace.escalations.length).toBeGreaterThan(0);
    expect(json.evidence_health.status).toBeTruthy();
    expect(json.synthesized_answer).toBeTruthy();
    expect(json.trace.pre_rank[0].selected_for_llm_count).toBeGreaterThan(0);
    expect(json.trace.cost_summary.pricing_source).toBe("mock_zero");
    expect(json.trace.cost_summary.line_items.length).toBeGreaterThan(0);

    const debug = await app.inject({ method: "GET", url: "/debug/search/latest" });
    expect(debug.statusCode).toBe(200);
    expect(debug.json().response.counts.raw_items).toBeGreaterThan(0);
    expect(debug.json().response.selected_chunks[0]._internal.embedding).toBeUndefined();
    expect(debug.json().response.retrieval_rounds.length).toBeGreaterThanOrEqual(1);
    expect(debug.json().response.cost_summary.pricing_source).toBe("mock_zero");

    const detail = await app.inject({ method: "GET", url: `/debug/search/${json.trace.request_id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().response.synthesized_answer).toBeTruthy();

    const feedback = await app.inject({
      method: "POST",
      url: `/debug/search/${json.trace.request_id}/feedback`,
      payload: { rating: "up", note: "Answered the query directly." }
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.json().feedback.rating).toBe("up");
    expect(feedback.json().feedback.note).toBe("Answered the query directly.");

    const detailWithFeedback = await app.inject({ method: "GET", url: `/debug/search/${json.trace.request_id}` });
    expect(detailWithFeedback.statusCode).toBe(200);
    expect(detailWithFeedback.json().feedback.rating).toBe("up");

    const latestWithFeedback = await app.inject({ method: "GET", url: "/debug/search/latest" });
    expect(latestWithFeedback.statusCode).toBe(200);
    expect(latestWithFeedback.json().feedback.rating).toBe("up");
  });

  it("rejects invalid search feedback ratings", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/debug/search/not-a-real-run/feedback",
      payload: { rating: "great" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("up, neutral, down");
  });

  it("runs balanced mode with cheap planning/scoring and GPT-5.5 synthesis in mock mode", async () => {
    process.env.LLM_PROVIDER = "mock";
    process.env.LLM_MODEL_BALANCED_DEFAULT = "~openai/gpt-mini-latest";
    process.env.LLM_MODEL_BALANCED_INTENT = "~openai/gpt-mini-latest";
    process.env.LLM_MODEL_BALANCED_STRATEGY = "~openai/gpt-mini-latest";
    process.env.LLM_MODEL_BALANCED_SCORING = "google/gemini-3.1-flash-lite";
    process.env.LLM_MODEL_BALANCED_SYNTHESIS = "openai/gpt-5.5";
    process.env.LLM_MODEL_BALANCED_ADJUDICATOR = "openai/gpt-5.5";
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "How do source-attributed pipelines work?", token_budget: 600, quality_mode: "balanced" }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.trace.model_usage.strategy.model).toBe("~openai/gpt-mini-latest");
    expect(json.trace.model_usage.strategy.quality_mode).toBe("balanced");
    expect(json.trace.model_usage.strategy.escalated).toBe(false);
    expect(json.trace.model_usage.scoring.model).toBe("google/gemini-3.1-flash-lite");
    expect(json.trace.model_usage.synthesis.model).toBe("openai/gpt-5.5");
    const reasoningByStage = new Map(json.trace.structured_llm_calls.map((call: any) => [call.stage, call.reasoning_enabled]));
    expect(reasoningByStage.get("synthesis")).toBe(true);
    expect(json.synthesized_answer).toBeTruthy();
  });

  it("streams search progress and a final response", async () => {
    process.env.LLM_PROVIDER = "mock";
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/search/stream",
      payload: {
        query: "How do source-attributed pipelines work?",
        token_budget: 600,
        quality_mode: "fast",
        synthesize_answer: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/event-stream");
    expect(response.body).toContain("event: stage_start");
    expect(response.body).toContain("event: final");
    expect(response.body).toContain("evidence_health");
    expect(response.body).toContain("cost_summary");
  });

  it("handles browser CORS preflight for search", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/search",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(String(response.headers["access-control-allow-methods"])).toContain("POST");
  });

  it("returns a visible missing provider result when a provider key is absent", async () => {
    process.env.OPENAI_API_KEY = "";
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/opponents/provider-search",
      payload: { provider: "openai", query: "What moved oil prices today?" }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.engine_name).toBe("OpenAI Web Search");
    expect(json.mode).toBe("missing");
    expect(json.evaluation.score_status).toBe("scoring_unavailable");
    expect(json.notes[0]).toContain("OPENAI_API_KEY");
  });

  it("normalizes mocked provider web-search responses without using the pipeline", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: "Oil prices may ease if supply growth outpaces demand and inventories rise.",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: "Oil prices may ease if supply growth outpaces demand and inventories rise.",
                    annotations: [{ type: "url_citation", url: "https://example.com/oil", title: "Oil outlook" }]
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/opponents/provider-search",
      payload: { provider: "openai", query: "When will oil prices come down?" }
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.mode).toBe("live");
    expect(json.final_answer).toContain("Oil prices");
    expect(json.sources_cited[0].url).toBe("https://example.com/oil");
    expect(json.pipeline).toBeUndefined();
  });

  it("keeps gold scoring and evidence health together for Q5 comparison", async () => {
    process.env.LLM_PROVIDER = "mock";
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/compare" });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    const q5 = json.items.find((item: any) => item.engine_name === "Agent Search Tool" && item.question_id === "Q5");
    expect(q5.evaluation.score_status).toBe("scored");
    expect(q5.pipeline.evidence_health.status).toBeTruthy();
  });
});
