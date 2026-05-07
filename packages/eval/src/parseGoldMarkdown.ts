import type { GoldArtifact } from "@agent-search/shared";

export function parseGoldMarkdown(markdown: string): Partial<GoldArtifact> {
  const questions = [...markdown.matchAll(/^# (Q[1-5]) .*$/gm)].map((match) => ({
    id: match[1],
    category: match[0].replace(/^# /, ""),
    query_types: ["multi-hop" as const],
    question: extractBlock(markdown, match.index ?? 0, "## Question").replace(/^>\s?/, "").trim()
  }));

  return {
    version: "draft-from-markdown",
    methodology: extractSection(markdown, "## Gold Answer Methodology"),
    questions
  };
}

function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const next = markdown.indexOf("\n# ", start + heading.length);
  return markdown.slice(start + heading.length, next < 0 ? undefined : next).trim();
}

function extractBlock(markdown: string, startIndex: number, heading: string): string {
  const start = markdown.indexOf(heading, startIndex);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start + heading.length, next < 0 ? undefined : next).trim();
}
