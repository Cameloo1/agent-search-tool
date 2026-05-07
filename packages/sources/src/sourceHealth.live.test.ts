import { describe, expect, it } from "vitest";
import { SourceFetchResultSchema, type FetchOptions, type SubQuery } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { arxivHandler } from "./arxiv.js";
import { coreHandler } from "./core.js";
import { crossrefHandler } from "./crossref.js";
import { dataGovHandler } from "./dataGov.js";
import { githubHandler } from "./github.js";
import { hackerNewsHandler } from "./hackerNews.js";
import { openAlexHandler } from "./openAlex.js";
import { officialDocsHandler } from "./officialDocs.js";
import { pubmedHandler } from "./pubmed.js";
import { secEdgarHandler } from "./secEdgar.js";
import { semanticScholarHandler } from "./semanticScholar.js";
import { stackExchangeHandler } from "./stackExchange.js";
import { wikidataHandler } from "./wikidata.js";
import { wikipediaHandler } from "./wikipedia.js";

const live = process.env.LIVE_API_TESTS === "1";

describe.runIf(live)("live source health checks", () => {
  for (const check of checks) {
    it(`${check.handler.name} returns a normalized health result`, async () => {
      const result = await check.handler.fetch(check.subQuery, liveOptions());
      expect(() => SourceFetchResultSchema.parse(result)).not.toThrow();
      if (!result.ok) {
        expect(result.error.category).toMatch(/^(unavailable|rate_limited|query_invalid|missing_config|timeout|unknown)$/);
      }
    });
  }
});

function liveOptions(): FetchOptions {
  return {
    timeoutMs: 10_000,
    maxResults: 1,
    apiKeys: {
      core: process.env.CORE_API_KEY,
      github: process.env.GITHUB_TOKEN,
      semanticScholar: process.env.SEMANTIC_SCHOLAR_API_KEY ?? process.env.S2_API_KEY
    },
    secUserAgent: process.env.SEC_USER_AGENT
  };
}

const checks: Array<{ handler: SourceHandler; subQuery: SubQuery }> = [
  { handler: wikipediaHandler, subQuery: subQuery("secure software development", ["wikipedia"]) },
  { handler: wikidataHandler, subQuery: subQuery("secure software development", ["wikidata"]) },
  { handler: arxivHandler, subQuery: subQuery("retrieval augmented generation", ["arxiv"]) },
  { handler: semanticScholarHandler, subQuery: subQuery("retrieval augmented generation", ["semantic_scholar"]) },
  { handler: openAlexHandler, subQuery: subQuery("retrieval augmented generation", ["openalex"]) },
  { handler: crossrefHandler, subQuery: subQuery("retrieval augmented generation", ["crossref"]) },
  { handler: pubmedHandler, subQuery: subQuery("software security", ["pubmed"]) },
  { handler: coreHandler, subQuery: subQuery("retrieval augmented generation", ["core"]) },
  { handler: stackExchangeHandler, subQuery: subQuery("authorization testing", ["stack_exchange"]) },
  { handler: hackerNewsHandler, subQuery: subQuery("software security", ["hacker_news"]) },
  { handler: githubHandler, subQuery: subQuery("OWASP ASVS authorization testing", ["github"]) },
  { handler: officialDocsHandler, subQuery: subQuery("OWASP ASVS authorization testing", ["official_docs"]) },
  { handler: secEdgarHandler, subQuery: subQuery("Apple 10-K", ["sec_edgar"]) },
  { handler: dataGovHandler, subQuery: subQuery("crude oil prices", ["data_gov"]) }
];

function subQuery(query: string, target_sources: SubQuery["target_sources"]): SubQuery {
  return {
    sub_query: query,
    target_sources,
    retrieval_intent: "corroborating",
    max_results: 1
  };
}
