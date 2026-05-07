import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { disabledResult, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface CoreResponse {
  results?: Array<{
    id?: string;
    title?: string;
    abstract?: string;
    authors?: Array<string> | string[];
    publishedDate?: string;
    downloadUrl?: string;
    doi?: string;
    urls?: string[];
  }>;
}

export const coreHandler: SourceHandler = {
  name: "core",
  async fetch(subQuery, options) {
    const apiKey = options.apiKeys?.core;
    if (!apiKey) {
      return disabledResult("core", "CORE_API_KEY_MISSING", "CORE is optional and disabled because CORE_API_KEY is absent.");
    }
    return safeSourceFetch("core", async () => {
      const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(subQuery.sub_query)}&limit=${
        options.maxResults
      }`;
      const data = await fetchJson<CoreResponse>(url, options.timeoutMs, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: options.signal
      });
      return (data.results ?? []).slice(0, options.maxResults).map<RawItem>((work) => ({
        id: itemId("core", work.id ?? work.doi ?? work.title ?? "unknown"),
        source: "core",
        source_type: "academic",
        url: work.downloadUrl ?? work.urls?.[0] ?? (work.doi ? `https://doi.org/${work.doi}` : "https://core.ac.uk/"),
        title: work.title ?? null,
        author: Array.isArray(work.authors) ? work.authors.join(", ") : null,
        publish_date: toIsoDate(work.publishedDate),
        text: [work.title, work.abstract].filter(Boolean).join("\n\n"),
        summary: work.abstract ?? null,
        metadata: { core_id: work.id, doi: work.doi }
      }));
    });
  }
};
