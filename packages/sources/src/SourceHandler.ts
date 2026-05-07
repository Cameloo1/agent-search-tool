import type { FetchOptions, SourceFetchResult, SourceName, SubQuery } from "@agent-search/shared";

export interface SourceHandler {
  name: SourceName;
  fetch(subQuery: SubQuery, options: FetchOptions): Promise<SourceFetchResult>;
}
