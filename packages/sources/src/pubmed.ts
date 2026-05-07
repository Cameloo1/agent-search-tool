import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface PubMedSearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface PubMedSummaryResponse {
  result?: Record<
    string,
    | {
        uid?: string;
        title?: string;
        fulljournalname?: string;
        pubdate?: string;
        sortpubdate?: string;
        authors?: Array<{ name?: string }>;
        articleids?: Array<{ idtype?: string; value?: string }>;
      }
    | string[]
  >;
}

export const pubmedHandler: SourceHandler = {
  name: "pubmed",
  async fetch(subQuery, options) {
    return safeSourceFetch("pubmed", async () => {
      const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(
        subQuery.sub_query
      )}&retmax=${options.maxResults}`;
      const search = await fetchJson<PubMedSearchResponse>(searchUrl, options.timeoutMs, { signal: options.signal });
      const ids = search.esearchresult?.idlist ?? [];
      if (ids.length === 0) return [];
      const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(
        ","
      )}`;
      const summary = await fetchJson<PubMedSummaryResponse>(summaryUrl, options.timeoutMs, { signal: options.signal });
      return ids.flatMap<RawItem>((id) => {
        const entry = summary.result?.[id];
        if (!entry || Array.isArray(entry)) return [];
        const doi = entry.articleids?.find((a) => a.idtype === "doi")?.value;
        const title = entry.title ?? null;
        return {
          id: itemId("pubmed", id),
          source: "pubmed",
          source_type: "medical",
          url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          title,
          author: entry.authors?.map((a) => a.name).filter(Boolean).join(", ") || null,
          publish_date: toIsoDate(entry.sortpubdate ?? entry.pubdate),
          text: [title, entry.fulljournalname].filter(Boolean).join("\n\n"),
          summary: null,
          metadata: { pmid: id, journal: entry.fulljournalname, doi }
        };
      });
    });
  }
};
