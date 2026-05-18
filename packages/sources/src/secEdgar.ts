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
      const url = secEftsSearchUrl(compactSecSearchQuery(subQuery.sub_query), options.maxResults);
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

export function compactSecSearchQuery(query: string): string {
  const cleaned = query
    .replace(/\bsite:(?:sec_edgar|sec\.gov|www\.sec\.gov)\b/gi, " ")
    .replace(/[()[\],?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return query.trim();

  const shouldCompact = cleaned !== query.trim() || cleaned.length > 96 || encodeURIComponent(cleaned).length > 140;
  if (!shouldCompact) return cleaned;

  const lower = cleaned.toLowerCase();
  const forms = unique(
    cleaned.match(/\b(?:10-k|10-q|8-k|20-f|6-k|s-1)s?\b/gi)?.map((form) => form.replace(/s$/i, "").toUpperCase()) ?? []
  );
  const priority = [
    /\b(?:ai|artificial intelligence)\b/i.test(cleaned) ? "AI" : "",
    /\binference\b/i.test(cleaned) ? "inference" : "",
    /\bcompute\b/i.test(cleaned) ? "compute" : "",
    /\b(?:capex|capital expenditures?)\b/i.test(cleaned) ? "capital expenditure" : "",
    /\binfrastructure\b/i.test(cleaned) ? "infrastructure" : "",
    /\bdata centers?\b/i.test(cleaned) ? "data center" : "",
    /\bgpus?\b/i.test(cleaned) ? "GPU" : "",
    /\bcloud\b/i.test(cleaned) ? "cloud" : ""
  ].filter(Boolean);
  if (priority.length >= 2) {
    return unique([...priority.slice(0, 5), ...forms]).join(" ");
  }

  const priorityTokens = new Set(priority.flatMap((phrase) => phrase.toLowerCase().split(/\s+/)));
  const formTokens = new Set(forms.map((form) => form.toLowerCase()));
  const remainder = cleaned
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9-]/gi, ""))
    .filter(Boolean)
    .filter((token) => !SEC_QUERY_STOPWORDS.has(token.toLowerCase()))
    .filter((token) => !priorityTokens.has(token.toLowerCase()))
    .filter((token) => !formTokens.has(token.toLowerCase()))
    .slice(0, 4);
  return unique([...priority, ...forms, ...remainder]).join(" ") || cleaned.slice(0, 96);
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

const SEC_QUERY_STOPWORDS = new Set([
  "and",
  "against",
  "capex",
  "companies",
  "company",
  "disclosed",
  "disclosures",
  "driver",
  "edgar",
  "explicitly",
  "extract",
  "filing",
  "filings",
  "for",
  "have",
  "in",
  "identified",
  "increase",
  "increases",
  "latest",
  "material",
  "mention",
  "names",
  "most",
  "not",
  "of",
  "or",
  "public",
  "publicly",
  "quoted",
  "rationale",
  "references",
  "reasons",
  "recent",
  "sec",
  "specifically",
  "that",
  "the",
  "they",
  "tied",
  "to",
  "traded",
  "what",
  "which"
]);
