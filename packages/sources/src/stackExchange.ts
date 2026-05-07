import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, stripHtml, toIsoDate } from "./utils/http.js";

interface StackExchangeResponse {
  items?: Array<{
    question_id: number;
    title?: string;
    link?: string;
    owner?: { display_name?: string };
    creation_date?: number;
    body?: string;
    tags?: string[];
  }>;
}

export const stackExchangeHandler: SourceHandler = {
  name: "stack_exchange",
  async fetch(subQuery, options) {
    return safeSourceFetch("stack_exchange", async () => {
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&filter=withbody&q=${encodeURIComponent(
        subQuery.sub_query
      )}&pagesize=${options.maxResults}`;
      const data = await fetchJson<StackExchangeResponse>(url, options.timeoutMs, { signal: options.signal });
      return clampResults(data.items ?? [], options.maxResults).map<RawItem>((question) => ({
        id: itemId("stack_exchange", String(question.question_id)),
        source: "stack_exchange",
        source_type: "forum",
        url: question.link ?? `https://stackoverflow.com/questions/${question.question_id}`,
        title: question.title ?? null,
        author: question.owner?.display_name ?? null,
        publish_date: question.creation_date ? toIsoDate(new Date(question.creation_date * 1000).toISOString()) : null,
        text: [question.title, stripHtml(question.body)].filter(Boolean).join("\n\n"),
        summary: null,
        metadata: { question_id: question.question_id, tags: question.tags ?? [] }
      }));
    });
  }
};
