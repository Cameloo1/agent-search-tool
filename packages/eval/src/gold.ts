import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GoldArtifactSchema, QUERY_TYPES, REQUIRED_SOURCE_TYPES } from "@agent-search/shared";
import type { AtomicFact, GoldAnswer, GoldQuestion, RequiredSource } from "@agent-search/shared";
import type { GoldArtifact, GoldLoadResult, GoldMarkdownParseResult, GoldValidationResult } from "./types.js";

export const LOCKED_GOLD_QUESTION_IDS = ["Q1", "Q2", "Q3", "Q4", "Q5"] as const;

const queryTypes = new Set<string>(QUERY_TYPES);
const requiredSourceTypes = new Set<string>(REQUIRED_SOURCE_TYPES);

export function defaultGoldPath(root = process.cwd()): string {
  return join(root, "packages", "eval", "gold", "gold-answers.json");
}

export function validateGoldArtifact(input: unknown): GoldValidationResult {
  const parsed = GoldArtifactSchema.safeParse(input);

  if (!parsed.success) {
    return {
      status: "invalid",
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      warnings: []
    };
  }

  const artifact = parsed.data as GoldArtifact;
  const errors = validateGoldDomainRules(artifact);

  if (errors.length > 0) {
    return {
      status: "invalid",
      errors,
      warnings: []
    };
  }

  return {
    status: "valid",
    artifact,
    errors: [],
    warnings: []
  };
}

export async function loadGoldArtifact(path = defaultGoldPath()): Promise<GoldLoadResult> {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      errors: [`Gold artifact not found at ${path}`],
      warnings: []
    };
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      status: "invalid",
      path,
      errors: [`Failed to read gold artifact: ${error instanceof Error ? error.message : String(error)}`],
      warnings: []
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      path,
      errors: [`Gold artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      warnings: []
    };
  }

  const result = validateGoldArtifact(json);
  return {
    status: result.status,
    path,
    artifact: result.artifact,
    errors: result.errors,
    warnings: result.warnings
  };
}

export function parseGoldMarkdown(markdown: string): GoldMarkdownParseResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const warnings: string[] = [];
  const errors: string[] = [];
  const questions: GoldQuestion[] = [];
  const answers: GoldAnswer[] = [];

  let version = "draft";
  let methodology = "Parsed from Markdown draft.";
  let current: DraftRecord | null = null;
  let section: DraftSection = "none";

  const flush = () => {
    if (!current) return;

    if (!current.question) {
      errors.push(`${current.id}: missing question text`);
    }

    const question: GoldQuestion = {
      id: current.id,
      category: current.category || "uncategorized",
      query_types: current.queryTypes.length > 0 ? current.queryTypes : ["source-attribution"],
      question: current.question || current.title || current.id
    };

    const answer: GoldAnswer = {
      question_id: current.id,
      gold_answer: current.goldAnswer.join("\n").trim() || "Markdown draft did not include a gold answer.",
      must_hit_atomic_facts: parseAtomicFactBullets(current.atomicFacts, current.id, warnings),
      required_source_types: parseRequiredSourceBullets(current.requiredSources, current.id, warnings),
      penalize_if: parseSimpleBullets(current.penalties),
      methodology_notes: current.methodologyNotes.join("\n").trim()
    };

    questions.push(question);
    answers.push(answer);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const versionMatch = trimmed.match(/^version\s*:\s*(.+)$/i);
    const methodologyMatch = trimmed.match(/^methodology\s*:\s*(.+)$/i);
    const questionHeader = trimmed.match(/^##\s*(Q[1-5])(?:\s*[:\-]\s*(.+))?$/i);
    const sectionHeader = trimmed.match(/^###\s*(.+)$/);

    if (versionMatch) {
      version = versionMatch[1].trim();
      continue;
    }

    if (methodologyMatch && !current) {
      methodology = methodologyMatch[1].trim();
      continue;
    }

    if (questionHeader) {
      flush();
      current = {
        id: questionHeader[1].toUpperCase(),
        title: questionHeader[2]?.trim() ?? "",
        category: "",
        queryTypes: [],
        question: questionHeader[2]?.trim() ?? "",
        goldAnswer: [],
        atomicFacts: [],
        requiredSources: [],
        penalties: [],
        methodologyNotes: []
      };
      section = "none";
      continue;
    }

    if (!current) continue;

    if (sectionHeader) {
      section = normalizeSection(sectionHeader[1]);
      continue;
    }

    const fieldMatch = trimmed.match(/^(category|query[_\s-]*types?|question|methodology[_\s-]*notes?)\s*:\s*(.*)$/i);
    if (fieldMatch) {
      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2].trim();
      if (key.startsWith("category")) current.category = value;
      if (key.startsWith("query")) current.queryTypes = parseQueryTypes(value, warnings, current.id);
      if (key.startsWith("question")) current.question = value;
      if (key.startsWith("methodology")) current.methodologyNotes.push(value);
      continue;
    }

    if (!trimmed && section !== "gold_answer" && section !== "methodology_notes") continue;

    if (section === "gold_answer") current.goldAnswer.push(line);
    if (section === "atomic_facts") current.atomicFacts.push(line);
    if (section === "required_sources") current.requiredSources.push(line);
    if (section === "penalties") current.penalties.push(line);
    if (section === "methodology_notes") current.methodologyNotes.push(line);
  }

  flush();

  const artifact = {
    version,
    methodology,
    questions,
    answers
  };

  return { artifact, errors, warnings };
}

export function goldArtifactToMarkdown(artifact: GoldArtifact): string {
  const answerById = new Map(artifact.answers.map((answer) => [answer.question_id, answer]));
  const lines = ["# Gold Answers", "", `Version: ${artifact.version}`, `Methodology: ${artifact.methodology}`, ""];

  for (const question of artifact.questions) {
    const answer = answerById.get(question.id);
    lines.push(`## ${question.id}: ${question.question}`);
    lines.push(`Category: ${question.category}`);
    lines.push(`Query types: ${question.query_types.join(", ")}`);
    lines.push("");
    lines.push("### Gold answer");
    lines.push(answer?.gold_answer ?? "");
    lines.push("");
    lines.push("### Must hit atomic facts");
    for (const fact of answer?.must_hit_atomic_facts ?? []) {
      const keywords = fact.keywords.length > 0 ? ` | keywords=${fact.keywords.join(", ")}` : "";
      lines.push(`- ${fact.id} | weight=${fact.weight}${keywords} | ${fact.text}`);
    }
    lines.push("");
    lines.push("### Required source types");
    for (const source of answer?.required_source_types ?? []) {
      lines.push(`- ${source.id} | type=${source.type} | weight=${source.weight} | ${source.description}`);
    }
    lines.push("");
    lines.push("### Penalize if");
    for (const penalty of answer?.penalize_if ?? []) {
      lines.push(`- ${penalty}`);
    }
    lines.push("");
    lines.push("### Methodology notes");
    lines.push(answer?.methodology_notes ?? "");
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function validateGoldDomainRules(artifact: GoldArtifact): string[] {
  const errors: string[] = [];
  const expected = new Set<string>(LOCKED_GOLD_QUESTION_IDS);
  const questionIds = artifact.questions.map((question) => question.id);
  const answerIds = artifact.answers.map((answer) => answer.question_id);

  for (const duplicate of findDuplicates(questionIds)) {
    errors.push(`Duplicate gold question id: ${duplicate}`);
  }

  for (const duplicate of findDuplicates(answerIds)) {
    errors.push(`Duplicate gold answer question_id: ${duplicate}`);
  }

  for (const id of LOCKED_GOLD_QUESTION_IDS) {
    if (!questionIds.includes(id)) errors.push(`Missing locked gold question ${id}`);
    if (!answerIds.includes(id)) errors.push(`Missing locked gold answer ${id}`);
  }

  for (const id of questionIds) {
    if (!expected.has(id)) errors.push(`Unexpected gold question id ${id}; expected Q1-Q5 only`);
  }

  for (const id of answerIds) {
    if (!expected.has(id)) errors.push(`Unexpected gold answer question_id ${id}; expected Q1-Q5 only`);
  }

  return errors;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

type DraftSection = "none" | "gold_answer" | "atomic_facts" | "required_sources" | "penalties" | "methodology_notes";

interface DraftRecord {
  id: string;
  title: string;
  category: string;
  queryTypes: GoldQuestion["query_types"];
  question: string;
  goldAnswer: string[];
  atomicFacts: string[];
  requiredSources: string[];
  penalties: string[];
  methodologyNotes: string[];
}

function normalizeSection(value: string): DraftSection {
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, "_");
  if (normalized.includes("gold") && normalized.includes("answer")) return "gold_answer";
  if (normalized.includes("atomic") || normalized.includes("must_hit")) return "atomic_facts";
  if (normalized.includes("required") && normalized.includes("source")) return "required_sources";
  if (normalized.includes("penal")) return "penalties";
  if (normalized.includes("methodology") || normalized.includes("notes")) return "methodology_notes";
  return "none";
}

function parseQueryTypes(value: string, warnings: string[], questionId: string): GoldQuestion["query_types"] {
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const ok = queryTypes.has(part);
      if (!ok) warnings.push(`${questionId}: ignored unknown query type "${part}"`);
      return ok;
    }) as GoldQuestion["query_types"];

  return parsed;
}

function parseSimpleBullets(lines: string[]): string[] {
  return lines.map(cleanBullet).filter(Boolean);
}

function parseAtomicFactBullets(lines: string[], questionId: string, warnings: string[]): AtomicFact[] {
  const bullets = parseSimpleBullets(lines);
  if (bullets.length === 0) {
    warnings.push(`${questionId}: Markdown draft contains no atomic facts`);
    return [{ id: `${questionId}.F1`, text: "Markdown draft contains no atomic facts.", keywords: [], weight: 1 }];
  }

  return bullets.map((bullet, index) => {
    const parsed = parsePipeRecord(bullet);
    const id = parsed.id || `${questionId}.F${index + 1}`;
    return {
      id,
      text: parsed.text || bullet,
      keywords: parseCsv(parsed.fields.get("keywords") ?? ""),
      weight: parsePositiveNumber(parsed.fields.get("weight"), 1)
    };
  });
}

function parseRequiredSourceBullets(lines: string[], questionId: string, warnings: string[]): RequiredSource[] {
  const bullets = parseSimpleBullets(lines);
  if (bullets.length === 0) {
    warnings.push(`${questionId}: Markdown draft contains no required source types`);
    return [
      {
        id: `${questionId}.S1`,
        type: "primary-document",
        description: "Markdown draft contains no required source types.",
        weight: 1
      }
    ];
  }

  return bullets.map((bullet, index) => {
    const parsed = parsePipeRecord(bullet);
    const typeValue = parsed.fields.get("type") ?? firstKnownRequiredSourceType(parsed.text);
    const type = requiredSourceTypes.has(typeValue) ? (typeValue as RequiredSource["type"]) : "primary-document";
    if (!requiredSourceTypes.has(typeValue)) {
      warnings.push(`${questionId}: required source "${bullet}" did not name a valid type; defaulted to primary-document`);
    }
    return {
      id: parsed.id || `${questionId}.S${index + 1}`,
      type,
      description: parsed.text || bullet,
      weight: parsePositiveNumber(parsed.fields.get("weight"), 1)
    };
  });
}

function parsePipeRecord(input: string): { id: string; text: string; fields: Map<string, string> } {
  const parts = input
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const fields = new Map<string, string>();
  let id = "";
  const textParts: string[] = [];

  for (const part of parts) {
    const keyValue = part.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(.+)$/);
    if (keyValue) {
      fields.set(keyValue[1].toLowerCase(), keyValue[2].trim());
      continue;
    }

    const idValue = part.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (!id && idValue && idValue[1].length <= 24) {
      id = idValue[1];
      textParts.push(idValue[2]);
      continue;
    }

    if (!id && /^[A-Za-z0-9_.-]+$/.test(part) && part.length <= 24) {
      id = part;
      continue;
    }

    textParts.push(part);
  }

  return { id, text: textParts.join(" | ").trim(), fields };
}

function cleanBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstKnownRequiredSourceType(text: string): string {
  for (const type of REQUIRED_SOURCE_TYPES) {
    if (text.toLowerCase().includes(type)) return type;
  }
  return "";
}
