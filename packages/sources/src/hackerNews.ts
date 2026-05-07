import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, stripHtml, toIsoDate } from "./utils/http.js";

interface HnResponse {
  hits?: Array<{
    objectID: string;
    title?: string;
    story_title?: string;
    url?: string;
    story_url?: string;
    author?: string;
    created_at?: string;
    comment_text?: string;
    points?: number;
    num_comments?: number;
  }>;
}

export const hackerNewsHandler: SourceHandler = {
  name: "hacker_news",
  async fetch(subQuery, options) {
    return safeSourceFetch("hacker_news", async () => {
      const url = `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(
        subQuery.sub_query
      )}&hitsPerPage=${options.maxResults}`;
      const data = await fetchJson<HnResponse>(url, options.timeoutMs, { signal: options.signal });
      return clampResults(data.hits ?? [], options.maxResults).map<RawItem>((hit) => {
        const title = hit.title ?? hit.story_title ?? null;
        return {
          id: itemId("hacker_news", hit.objectID),
          source: "hacker_news",
          source_type: "tech_discussion",
          url: hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
          title,
          author: hit.author ?? null,
          publish_date: toIsoDate(hit.created_at),
          text: [title, stripHtml(hit.comment_text)].filter(Boolean).join("\n\n"),
          summary: null,
          metadata: { object_id: hit.objectID, points: hit.points, comments: hit.num_comments }
        };
      });
    });
  }
};
