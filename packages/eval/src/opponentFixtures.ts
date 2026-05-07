import { OpponentResultFixtureSchema, type OpponentResultFixture } from "@agent-search/shared";

export const DEFAULT_OPPONENTS = ["ChatGPT search", "Perplexity", "Tavily API", "Exa API", "Vanilla Claude with web_search"];

export function validateOpponentFixture(value: unknown): OpponentResultFixture {
  return OpponentResultFixtureSchema.parse(value);
}

export function missingOpponentFixtures(questionId: string): OpponentResultFixture[] {
  return DEFAULT_OPPONENTS.map((engineName) =>
    OpponentResultFixtureSchema.parse({
      engine_name: engineName,
      question_id: questionId,
      final_answer: "",
      sources_cited: [],
      token_count: 0,
      time_to_result_ms: 0,
      mode: "missing",
      notes: ["No live or imported opponent fixture provided."]
    })
  );
}
