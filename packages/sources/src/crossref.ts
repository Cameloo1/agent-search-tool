import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface CrossRefResponse {
  message?: {
    items?: Array<{
      DOI?: string;
      URL?: string;
      title?: string[];
      abstract?: string;
      author?: Array<{ given?: string; family?: string }>;
      published?: { "date-parts"?: number[][] };
      "published-print"?: { "date-parts"?: number[][] };
      "published-online"?: { "date-parts"?: number[][] };
    }>;
  };
}

function datePartsToIso(parts?: number[][]): string | null {
  const first = parts?.[0];
  if (!first?.[0]) return null;
  return toIsoDate(`${first[0]}-${String(first[1] ?? 1).padStart(2, "0")}-${String(first[2] ?? 1).padStart(2, "0")}`);
}

export const crossrefHandler: SourceHandler = {
  name: "crossref",
  async fetch(subQuery, options) {
    return safeSourceFetch("crossref", async () => {
      const url = `https://api.crossref.org/works?query=${encodeURIComponent(subQuery.sub_query)}&rows=${
        options.maxResults
      }`;
      const data = await fetchJson<CrossRefResponse>(url, options.timeoutMs, { signal: options.signal });
      return clampResults(data.message?.items ?? [], options.maxResults).map<RawItem>((work) => {
        const title = work.title?.[0] ?? null;
        const authors = work.author
          ?.map((a) => [a.given, a.family].filter(Boolean).join(" "))
          .filter(Boolean)
          .join(", ");
        return {
          id: itemId("crossref", work.DOI ?? work.URL ?? title ?? "unknown"),
          source: "crossref",
          source_type: "academic",
          url: work.URL ?? (work.DOI ? `https://doi.org/${work.DOI}` : "https://www.crossref.org/"),
          title,
          author: authors || null,
          publish_date:
            datePartsToIso(work.published?.["date-parts"]) ??
            datePartsToIso(work["published-online"]?.["date-parts"]) ??
            datePartsToIso(work["published-print"]?.["date-parts"]),
          text: [title, work.abstract].filter(Boolean).join("\n\n"),
          summary: work.abstract ?? null,
          metadata: { doi: work.DOI }
        };
      });
    });
  }
};
