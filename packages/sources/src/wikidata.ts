import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch } from "./utils/http.js";

interface WikidataResponse {
  results?: {
    bindings?: Array<{
      item?: { value: string };
      itemLabel?: { value: string };
      itemDescription?: { value: string };
    }>;
  };
}

export const wikidataHandler: SourceHandler = {
  name: "wikidata",
  async fetch(subQuery, options) {
    return safeSourceFetch("wikidata", async () => {
      const sparql = `
        SELECT ?item ?itemLabel ?itemDescription WHERE {
          SERVICE wikibase:mwapi {
            bd:serviceParam wikibase:endpoint "www.wikidata.org";
              wikibase:api "EntitySearch";
              mwapi:search "${subQuery.sub_query.replace(/"/g, '\\"')}";
              mwapi:language "en".
            ?item wikibase:apiOutputItem mwapi:item.
          }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        }
        LIMIT ${options.maxResults}
      `;
      const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
      const data = await fetchJson<WikidataResponse>(url, options.timeoutMs, {
        headers: { Accept: "application/sparql-results+json" },
        signal: options.signal
      });
      return clampResults(data.results?.bindings ?? [], options.maxResults).map<RawItem>((binding) => {
        const entityUrl = binding.item?.value ?? "https://www.wikidata.org/wiki/Wikidata:Main_Page";
        const label = binding.itemLabel?.value ?? null;
        const description = binding.itemDescription?.value ?? "";
        return {
          id: itemId("wikidata", entityUrl),
          source: "wikidata",
          source_type: "structured_fact",
          url: entityUrl,
          title: label,
          author: null,
          publish_date: null,
          text: [label, description].filter(Boolean).join("\n\n"),
          summary: description || null,
          metadata: { entity_url: entityUrl }
        };
      });
    });
  }
};
