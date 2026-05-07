import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { OpponentResultFixtureSchema } from "@agent-search/shared";
import type { OpponentMode, OpponentResultFixture } from "@agent-search/shared";
import type { OpponentFixtureLoadResult } from "./types.js";

export interface LoadOpponentFixturesOptions {
  defaultMode?: Exclude<OpponentMode, "live">;
  allowLiveFromFile?: boolean;
}

export async function loadOpponentFixtures(
  path: string,
  options: LoadOpponentFixturesOptions = {}
): Promise<OpponentFixtureLoadResult> {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      fixtures: [],
      errors: [`Opponent fixture file not found at ${path}`],
      warnings: []
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return {
      status: "invalid",
      path,
      fixtures: [],
      errors: [`Opponent fixture JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`],
      warnings: []
    };
  }

  const records = normalizeFixtureEnvelope(parsedJson);
  const fixtures: OpponentResultFixture[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  records.forEach((record, index) => {
    const normalized = normalizeFixtureMode(record, options, warnings, index);
    const result = OpponentResultFixtureSchema.safeParse(normalized);
    if (result.success) {
      fixtures.push(result.data);
      return;
    }

    errors.push(
      `fixture[${index}]: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`
    );
  });

  return {
    status: errors.length > 0 ? "invalid" : "valid",
    path,
    fixtures,
    errors,
    warnings
  };
}

export async function loadOpponentFixtureFiles(
  paths: string[],
  options: LoadOpponentFixturesOptions = {}
): Promise<OpponentFixtureLoadResult[]> {
  return Promise.all(paths.map((path) => loadOpponentFixtures(path, options)));
}

export function validateOpponentFixture(input: unknown): OpponentResultFixture {
  return OpponentResultFixtureSchema.parse(input);
}

export function createMissingOpponentFixture(
  engineName: string,
  questionId: string,
  notes: string[] = []
): OpponentResultFixture {
  return OpponentResultFixtureSchema.parse({
    engine_name: engineName,
    question_id: questionId,
    final_answer: "",
    sources_cited: [],
    token_count: 0,
    time_to_result_ms: 0,
    mode: "missing",
    notes
  });
}

function normalizeFixtureEnvelope(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;

  if (input && typeof input === "object") {
    const maybeEnvelope = input as { fixtures?: unknown; results?: unknown };
    if (Array.isArray(maybeEnvelope.fixtures)) return maybeEnvelope.fixtures;
    if (Array.isArray(maybeEnvelope.results)) return maybeEnvelope.results;
  }

  return [input];
}

function normalizeFixtureMode(
  input: unknown,
  options: LoadOpponentFixturesOptions,
  warnings: string[],
  index: number
): unknown {
  if (!input || typeof input !== "object") return input;

  const record = { ...(input as Record<string, unknown>) };
  const defaultMode = options.defaultMode ?? "imported";

  if (!record.mode) {
    record.mode = defaultMode;
    return record;
  }

  if (record.mode === "live" && !options.allowLiveFromFile) {
    record.mode = defaultMode;
    warnings.push(`fixture[${index}]: live mode in imported fixture file was relabeled as ${defaultMode}`);
  }

  return record;
}
