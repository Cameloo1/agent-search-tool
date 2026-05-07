import type { BuiltInSourceName, SourceName } from "@agent-search/shared";
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

export const sourceRegistry: Record<BuiltInSourceName, SourceHandler> = {
  wikipedia: wikipediaHandler,
  arxiv: arxivHandler,
  semantic_scholar: semanticScholarHandler,
  pubmed: pubmedHandler,
  openalex: openAlexHandler,
  core: coreHandler,
  crossref: crossrefHandler,
  stack_exchange: stackExchangeHandler,
  hacker_news: hackerNewsHandler,
  github: githubHandler,
  wikidata: wikidataHandler,
  sec_edgar: secEdgarHandler,
  data_gov: dataGovHandler,
  official_docs: officialDocsHandler
};

export function getSourceHandler(source: SourceName): SourceHandler {
  return sourceRegistry[source as BuiltInSourceName];
}
