import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { disabledResult, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface SecSearchResponse {
  hits?: {
    hits?: Array<{
      _id?: string;
      _source?: {
        file_date?: string;
        form?: string;
        company?: string;
        display_names?: string[];
        cik?: string;
        adsh?: string;
        file_num?: string;
        filing_url?: string;
        xsl?: string;
      };
    }>;
  };
}

export const secEdgarHandler: SourceHandler = {
  name: "sec_edgar",
  async fetch(subQuery, options) {
    if (!options.secUserAgent) {
      return disabledResult(
        "sec_edgar",
        "SEC_USER_AGENT_MISSING",
        "SEC EDGAR live calls require SEC_USER_AGENT to comply with SEC fair-access guidance."
      );
    }
    const secUserAgent = options.secUserAgent;
    return safeSourceFetch("sec_edgar", async () => {
      const body = JSON.stringify({
        keys: subQuery.sub_query,
        from: 0,
        size: options.maxResults,
        sort: [{ file_date: { order: "desc" } }]
      });
      const data = await fetchJson<SecSearchResponse>("https://efts.sec.gov/LATEST/search-index", options.timeoutMs, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": secUserAgent,
          Accept: "application/json"
        },
        body,
        signal: options.signal
      });
      return (data.hits?.hits ?? []).slice(0, options.maxResults).map<RawItem>((hit) => {
        const src = hit._source ?? {};
        const title = [src.company ?? src.display_names?.[0], src.form].filter(Boolean).join(" ") || null;
        const filingUrl = src.filing_url ?? src.xsl ?? "https://www.sec.gov/edgar/search/";
        return {
          id: itemId("sec_edgar", hit._id ?? `${src.cik}:${src.adsh}:${src.form}`),
          source: "sec_edgar",
          source_type: "filing",
          url: filingUrl.startsWith("http") ? filingUrl : `https://www.sec.gov${filingUrl}`,
          title,
          author: src.company ?? null,
          publish_date: toIsoDate(src.file_date),
          text: [title, src.file_date ? `Filed ${src.file_date}` : "", src.file_num ? `File number ${src.file_num}` : ""]
            .filter(Boolean)
            .join("\n\n"),
          summary: null,
          metadata: { cik: src.cik, accession: src.adsh, form: src.form, file_number: src.file_num }
        };
      });
    });
  }
};
