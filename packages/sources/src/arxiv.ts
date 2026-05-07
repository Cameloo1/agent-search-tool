import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchText, itemId, safeSourceFetch, stripHtml, toIsoDate } from "./utils/http.js";

function entries(xml: string): string[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1] ?? "");
}

function tag(entry: string, name: string): string | null {
  return stripHtml(entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? "").trim() || null;
}

function repeatedTag(entry: string, name: string): string[] {
  return [...entry.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "g"))]
    .map((m) => stripHtml(m[1]))
    .filter(Boolean);
}

export const arxivHandler: SourceHandler = {
  name: "arxiv",
  async fetch(subQuery, options) {
    return safeSourceFetch("arxiv", async () => {
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
        subQuery.sub_query
      )}&start=0&max_results=${options.maxResults}`;
      const xml = await fetchText(url, options.timeoutMs, { signal: options.signal });
      return clampResults(entries(xml), options.maxResults).map<RawItem>((entry) => {
        const id = tag(entry, "id") ?? "https://arxiv.org/";
        const title = tag(entry, "title");
        const summary = tag(entry, "summary");
        const authors = repeatedTag(entry, "name").join(", ") || null;
        return {
          id: itemId("arxiv", id),
          source: "arxiv",
          source_type: "academic",
          url: id,
          title,
          author: authors,
          publish_date: toIsoDate(tag(entry, "published")),
          text: [title, summary].filter(Boolean).join("\n\n"),
          summary,
          metadata: { updated: tag(entry, "updated") }
        };
      });
    });
  }
};
