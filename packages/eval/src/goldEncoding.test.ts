import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GoldArtifactSchema } from "@agent-search/shared";
import { goldArtifactToMarkdown, parseGoldMarkdown, validateGoldArtifact } from "./gold.js";
import { loadGoldArtifact } from "./questions.js";

const goldPath = fileURLToPath(new URL("../gold/gold-answers.json", import.meta.url));

describe("gold artifact encoding and parser round-trip", () => {
  it("keeps smart punctuation parseable without mojibake in the locked JSON", () => {
    const raw = readFileSync(goldPath, "utf8");
    expect(raw).not.toMatch(/[âÃ�]/u);
    expect(raw).toContain("\\u2019");

    const loaded = loadGoldArtifact();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.reason);

    const q1 = loaded.artifact.questions.find((question) => question.id === "Q1");
    const q4 = loaded.artifact.questions.find((question) => question.id === "Q4");
    expect(q1?.question).toContain("What\u2019s");
    expect(q1?.question).toContain("that\u2019s");
    expect(q4?.question).toContain("I\u2019d");
  });

  it("round-trips benchmark questions and answers through markdown parsing", () => {
    const loaded = loadGoldArtifact();
    if (!loaded.ok) throw new Error(loaded.reason);

    const markdown = goldArtifactToMarkdown(loaded.artifact);
    const parsed = parseGoldMarkdown(markdown);
    expect(parsed.errors).toEqual([]);

    const validation = validateGoldArtifact(parsed.artifact);
    expect(validation.status).toBe("valid");
    expect(validation.artifact).toEqual(loaded.artifact);
  });

  it("keeps ASCII-normalized apostrophes stable through the parser", () => {
    const loaded = loadGoldArtifact();
    if (!loaded.ok) throw new Error(loaded.reason);

    const asciiMarkdown = goldArtifactToMarkdown(loaded.artifact).replace(/\u2019/g, "'");
    const parsed = parseGoldMarkdown(asciiMarkdown);
    expect(parsed.errors).toEqual([]);

    const artifact = GoldArtifactSchema.parse(parsed.artifact);
    const q1 = artifact.questions.find((question) => question.id === "Q1");
    const q4 = artifact.questions.find((question) => question.id === "Q4");
    expect(q1?.question).toContain("What's");
    expect(q1?.question).toContain("that's");
    expect(q4?.question).toContain("I'd");
    expect(artifact.answers.find((answer) => answer.question_id === "Q1")?.gold_answer).toContain("U.S.");
  });
});
