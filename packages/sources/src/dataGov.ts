import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, stripHtml, toIsoDate } from "./utils/http.js";

interface DataGovResponse {
  results?: DataGovDataset[];
}

interface DataGovDataset {
  identifier?: string;
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  publisher?: string;
  landingPage?: string;
  last_harvested_date?: string;
  organization?: { title?: string; name?: string; slug?: string };
  dcat?: {
    title?: string;
    description?: string;
    identifier?: string;
    modified?: string;
    issued?: string;
    landingPage?: string;
    publisher?: { name?: string };
    distribution?: Array<{ title?: string; downloadURL?: string; accessURL?: string; mediaType?: string; format?: string } | string>;
  };
  harvest_record?: string;
  harvest_record_raw?: string;
  distribution_titles?: string[];
}

export const dataGovHandler: SourceHandler = {
  name: "data_gov",
  async fetch(subQuery, options) {
    return safeSourceFetch("data_gov", async () => {
      const data = await fetchFirstNonEmpty(subQuery.sub_query, options.timeoutMs, options.maxResults, options.signal);
      return clampResults(data.results ?? [], options.maxResults).map<RawItem>((dataset) => {
        const identifier = dataset.identifier ?? dataset.dcat?.identifier ?? dataset.id ?? dataset.slug ?? dataset.title ?? "unknown";
        const pageUrl =
          dataset.landingPage ??
          dataset.dcat?.landingPage ??
          dataset.harvest_record ??
          `https://catalog.data.gov/dataset/${dataset.slug ?? identifier}`;
        const description = stripHtml(dataset.description ?? dataset.dcat?.description);
        const title = dataset.title ?? dataset.dcat?.title ?? null;
        return {
          id: itemId("data_gov", identifier),
          source: "data_gov",
          source_type: "government",
          url: pageUrl,
          title,
          author: dataset.publisher ?? dataset.dcat?.publisher?.name ?? dataset.organization?.title ?? dataset.organization?.name ?? null,
          publish_date: toIsoDate(dataset.dcat?.modified ?? dataset.last_harvested_date ?? dataset.dcat?.issued),
          text: [title, description, dataset.distribution_titles?.join("; ")].filter(Boolean).join("\n\n"),
          summary: description || null,
          metadata: {
            dataset_id: identifier,
            slug: dataset.slug,
            organization: dataset.organization,
            distributions: dataset.dcat?.distribution ?? [],
            harvest_record_raw: dataset.harvest_record_raw
          }
        };
      });
    });
  }
};

async function fetchFirstNonEmpty(query: string, timeoutMs: number, maxResults: number, signal?: AbortSignal): Promise<DataGovResponse> {
  let last: DataGovResponse = {};
  for (const variant of dataGovQueryVariants(query)) {
    const url = `https://catalog.data.gov/search?q=${encodeURIComponent(variant)}&per_page=${maxResults}`;
    const data = await fetchJson<DataGovResponse>(url, timeoutMs, { signal });
    last = data;
    if ((data.results ?? []).length > 0) return data;
  }
  return last;
}

function dataGovQueryVariants(query: string): string[] {
  const variants = [query];
  const lower = query.toLowerCase();
  if (/(oil|crude|wti|brent|petroleum|gasoline|fuel)/.test(lower)) {
    variants.push("oil prices", "Short-Term Energy Outlook petroleum prices", "crude oil", "petroleum prices");
  }
  if (/(inflation|cpi|prices|consumer price)/.test(lower)) {
    variants.push("consumer price index", "inflation");
  }
  if (/(employment|jobs|unemployment|labor)/.test(lower)) {
    variants.push("unemployment", "employment");
  }
  if (/(gdp|gross domestic product|economic growth)/.test(lower)) {
    variants.push("gross domestic product", "GDP");
  }
  return Array.from(new Set(variants.map((variant) => variant.trim()).filter(Boolean))).slice(0, 5);
}
