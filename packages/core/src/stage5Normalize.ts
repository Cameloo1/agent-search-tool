import {
  NormalizedChunkSchema,
  ExtractionMetadataSchema,
  estimateTokens,
  getSourceWeight,
  type EpistemicStance,
  type NormalizedChunk,
  type NormalizedSourceType,
  type RawItem
} from "@agent-search/shared";

export interface NormalizeOptions {
  targetMinTokens?: number;
  targetMaxTokens?: number;
}

function cleanText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stanceForSourceType(sourceType: NormalizedSourceType): EpistemicStance {
  if (sourceType === "filing" || sourceType === "government") return "primary_source";
  if (sourceType === "academic" || sourceType === "medical" || sourceType === "code") return "secondary_analysis";
  if (sourceType === "encyclopedic" || sourceType === "structured_fact") return "tertiary_summary";
  if (sourceType === "forum" || sourceType === "tech_discussion") return "opinion";
  return "speculation";
}

function freshnessFitness(publishDate: string | null): number {
  if (!publishDate) return 0.5;
  const ageMs = Date.now() - new Date(publishDate).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0.8;
  const ageDays = ageMs / 86_400_000;
  if (ageDays < 30) return 1;
  if (ageDays < 365) return 0.85;
  if (ageDays < 365 * 5) return 0.7;
  return 0.55;
}

function splitIntoChunks(text: string, minTokens: number, maxTokens: number): string[] {
  const paragraphs = text
    .split(/\n{2,}|(?<=\.)\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    const paragraphTokens = estimateTokens(paragraph);
    if (currentTokens > 0 && currentTokens + paragraphTokens > maxTokens) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(paragraph);
    currentTokens += paragraphTokens;
    if (currentTokens >= minTokens && currentTokens >= maxTokens * 0.75) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length) chunks.push(current.join("\n\n"));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function normalizeExtractionMetadata(metadata: RawItem["metadata"]): unknown {
  const parsed = ExtractionMetadataSchema.safeParse(metadata.extraction);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeRawItems(rawItems: RawItem[], options: NormalizeOptions = {}): NormalizedChunk[] {
  const minTokens = options.targetMinTokens ?? 500;
  const maxTokens = options.targetMaxTokens ?? 1000;
  const chunks: NormalizedChunk[] = [];

  for (const item of rawItems) {
    const parts = [item.title, item.summary, item.text].filter(Boolean).map((part) => cleanText(String(part)));
    const text = Array.from(new Set(parts)).join("\n\n").trim();
    if (!text) continue;

    const split = splitIntoChunks(text, minTokens, maxTokens);
    const extraction = normalizeExtractionMetadata(item.metadata);
    split.forEach((content, index) => {
      const chunk = NormalizedChunkSchema.parse({
        id: `${item.id}:chunk:${index}`,
        content,
        metadata: {
          url: item.url,
          source_name: item.source,
          source_type: item.source_type,
          title: item.title,
          publish_date: item.publish_date,
          author: item.author,
          confidence_score: 0,
          summary: item.summary,
          claim_graph: [],
          epistemic_stance: stanceForSourceType(item.source_type),
          surprise_score: 0,
          extraction
        },
        _internal: {
          relevance_to_query: 0,
          source_weight: getSourceWeight(item.source, item.source_type),
          freshness_fitness: freshnessFitness(item.publish_date),
          embedding: []
        }
      });
      chunks.push(chunk);
    });
  }

  return chunks;
}
