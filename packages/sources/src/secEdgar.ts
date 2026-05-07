import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { disabledResult, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface SecSearchResponse {
  hits?: {
    hits?: SecSearchHit[];
  };
}

const SEC_EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";

interface SecSearchHit {
  _id?: string;
  _source?: SecSearchSource;
}

interface SecSearchSource {
  ciks?: string[];
  file_date?: string;
  period_ending?: string | null;
  form?: string;
  form_type?: string;
  root_forms?: string[];
  company?: string;
  entity_name?: string;
  display_names?: string[];
  cik?: string;
  adsh?: string;
  file_num?: string | string[];
  filing_url?: string;
  xsl?: string;
  file_type?: string;
  file_description?: string | null;
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
      const url = secEftsSearchUrl(subQuery.sub_query, options.maxResults);
      const data = await fetchJson<SecSearchResponse>(url, options.timeoutMs, {
        headers: {
          "User-Agent": secUserAgent,
          Accept: "application/json"
        },
        signal: options.signal
      });
      return (data.hits?.hits ?? []).slice(0, options.maxResults).map<RawItem>((hit) => {
        const src = hit._source ?? {};
        const form = src.form ?? src.form_type ?? src.root_forms?.[0] ?? src.file_type;
        const company = src.company ?? src.entity_name ?? cleanDisplayName(src.display_names?.[0]) ?? null;
        const title = [company, form, src.file_description].filter(Boolean).join(" - ") || null;
        const filingUrl = secFilingUrl(hit._id, src);
        const cik = src.cik ?? src.ciks?.[0];
        const fileNumber = Array.isArray(src.file_num) ? src.file_num.filter(Boolean).join(", ") : src.file_num;
        return {
          id: itemId("sec_edgar", hit._id ?? `${cik}:${src.adsh}:${form}`),
          source: "sec_edgar",
          source_type: "filing",
          url: filingUrl,
          title,
          author: company,
          publish_date: toIsoDate(src.file_date),
          text: [
            title,
            src.file_date ? `Filed ${src.file_date}` : "",
            src.period_ending ? `Period ending ${src.period_ending}` : "",
            fileNumber ? `File number ${fileNumber}` : ""
          ]
            .filter(Boolean)
            .join("\n\n"),
          summary: null,
          metadata: { cik, accession: src.adsh, form, file_number: fileNumber, file_type: src.file_type }
        };
      });
    });
  }
};

export function secEftsSearchUrl(query: string, maxResults: number): string {
  const params = new URLSearchParams({
    q: query,
    from: "0",
    size: String(Math.max(1, Math.min(100, maxResults)))
  });
  return `${SEC_EFTS_SEARCH_URL}?${params.toString()}`;
}

function secFilingUrl(hitId: string | undefined, source: SecSearchSource = {}): string {
  const directUrl = source.filing_url ?? source.xsl;
  if (directUrl) return directUrl.startsWith("http") ? directUrl : `https://www.sec.gov${directUrl}`;

  const parsed = parseHitId(hitId);
  const cik = source.cik ?? source.ciks?.[0];
  const accession = source.adsh ?? parsed?.accession;
  const filename = parsed?.filename;
  if (cik && accession && filename) {
    return `https://www.sec.gov/Archives/edgar/data/${stripLeadingZeros(cik)}/${accession.replace(/-/g, "")}/${filename}`;
  }

  return "https://www.sec.gov/search-filings";
}

function parseHitId(hitId: string | undefined): { accession: string; filename: string } | undefined {
  const [accession, filename] = hitId?.split(":") ?? [];
  if (!accession || !filename) return undefined;
  return { accession, filename };
}

function cleanDisplayName(value: string | undefined): string | undefined {
  return value?.replace(/\s*\(CIK\s+\d+\)\s*/i, "").trim() || undefined;
}

function stripLeadingZeros(value: string): string {
  return value.replace(/^0+/, "") || "0";
}
