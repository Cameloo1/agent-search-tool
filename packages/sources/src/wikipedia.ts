import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, stripHtml } from "./utils/http.js";

interface WikipediaSearchResponse {
  pages?: Array<{
    id: number;
    key: string;
    title: string;
    excerpt?: string;
    description?: string;
  }>;
}

export const wikipediaHandler: SourceHandler = {
  name: "wikipedia",
  async fetch(subQuery, options) {
    return safeSourceFetch("wikipedia", async () => {
      const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(
        subQuery.sub_query
      )}&limit=${options.maxResults}`;
      const data = await fetchJson<WikipediaSearchResponse>(url, options.timeoutMs, {
        headers: { "User-Agent": "agent-search-tool/0.1 (public API research)" },
        signal: options.signal
      });
      return clampResults(data.pages ?? [], options.maxResults).map<RawItem>((page) => {
        const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`;
        const excerpt = stripHtml(page.excerpt);
        const description = stripHtml(page.description);
        return {
          id: itemId("wikipedia", `${page.id}:${page.title}`),
          source: "wikipedia",
          source_type: "encyclopedic",
          url: pageUrl,
          title: page.title ?? null,
          author: null,
          publish_date: null,
          text: [page.title, description, excerpt].filter(Boolean).join("\n\n"),
          summary: description || null,
          metadata: { page_id: page.id, key: page.key }
        };
      });
    });
  }
};
