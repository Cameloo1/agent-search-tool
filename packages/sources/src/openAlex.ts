import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, stripHtml, toIsoDate } from "./utils/http.js";

interface OpenAlexResponse {
  results?: Array<{
    id: string;
    doi?: string;
    title?: string;
    display_name?: string;
    publication_date?: string;
    abstract_inverted_index?: Record<string, number[]>;
    authorships?: Array<{ author?: { display_name?: string } }>;
    primary_location?: { landing_page_url?: string };
  }>;
}

function uninvert(index?: Record<string, number[]>): string | null {
  if (!index) return null;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word]);
  }
  return words.sort((a, b) => a[0] - b[0]).map(([, word]) => word).join(" ") || null;
}

export const openAlexHandler: SourceHandler = {
  name: "openalex",
  async fetch(subQuery, options) {
    return safeSourceFetch("openalex", async () => {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(subQuery.sub_query)}&per-page=${
        options.maxResults
      }`;
      const data = await fetchJson<OpenAlexResponse>(url, options.timeoutMs, { signal: options.signal });
      return clampResults(data.results ?? [], options.maxResults).map<RawItem>((work) => {
        const abstract = stripHtml(uninvert(work.abstract_inverted_index));
        return {
          id: itemId("openalex", work.id),
          source: "openalex",
          source_type: "academic",
          url: work.primary_location?.landing_page_url ?? work.doi ?? work.id,
          title: work.title ?? work.display_name ?? null,
          author: work.authorships?.map((a) => a.author?.display_name).filter(Boolean).join(", ") || null,
          publish_date: toIsoDate(work.publication_date),
          text: [work.title ?? work.display_name, abstract].filter(Boolean).join("\n\n"),
          summary: abstract || null,
          metadata: { openalex_id: work.id, doi: work.doi }
        };
      });
    });
  }
};
