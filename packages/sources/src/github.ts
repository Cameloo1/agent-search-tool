import type { RawItem } from "@agent-search/shared";
import type { SourceHandler } from "./SourceHandler.js";
import { clampResults, fetchJson, itemId, safeSourceFetch, toIsoDate } from "./utils/http.js";

interface GitHubSearchResponse {
  items?: Array<{
    id: number;
    full_name?: string;
    html_url?: string;
    description?: string;
    updated_at?: string;
    owner?: { login?: string };
    language?: string;
    stargazers_count?: number;
  }>;
}

export const githubHandler: SourceHandler = {
  name: "github",
  async fetch(subQuery, options) {
    return safeSourceFetch("github", async () => {
      const compactedQuery = compactGitHubSearchQuery(subQuery.sub_query);
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
        compactedQuery
      )}&sort=stars&order=desc&per_page=${options.maxResults}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-search-tool/0.1"
      };
      if (options.apiKeys?.github) headers.Authorization = `Bearer ${options.apiKeys.github}`;
      const data = await fetchJson<GitHubSearchResponse>(url, options.timeoutMs, { headers, signal: options.signal });
      return clampResults(data.items ?? [], options.maxResults).map<RawItem>((repo) => ({
        id: itemId("github", String(repo.id)),
        source: "github",
        source_type: "code",
        url: repo.html_url ?? "https://github.com",
        title: repo.full_name ?? null,
        author: repo.owner?.login ?? null,
        publish_date: toIsoDate(repo.updated_at),
        text: [repo.full_name, repo.description, repo.language ? `Language: ${repo.language}` : ""]
          .filter(Boolean)
          .join("\n\n"),
        summary: repo.description ?? null,
        metadata: {
          repository_id: repo.id,
          language: repo.language,
          stars: repo.stargazers_count,
          original_query: subQuery.sub_query,
          compacted_query: compactedQuery,
          compacted_query_encoded_length: encodeURIComponent(compactedQuery).length
        }
      }));
    });
  }
};

const GITHUB_SEARCH_QUERY_LIMIT = 256;
const GITHUB_SAFE_QUERY_LENGTH = 220;

export function compactGitHubSearchQuery(
  query: string,
  maxLength = GITHUB_SAFE_QUERY_LENGTH,
  maxEncodedLength = GITHUB_SEARCH_QUERY_LIMIT
): string {
  const highSignalTerms = tokenize(query)
    .filter((term) => term.length > 1)
    .filter((term) => !GITHUB_QUERY_STOPWORDS.has(term.toLowerCase()));
  const uniqueTerms: string[] = [];
  const seen = new Set<string>();
  for (const term of highSignalTerms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTerms.push(term);
  }

  const ordered = [...uniqueTerms].sort((a, b) => termPriority(b) - termPriority(a));
  const selected: string[] = [];
  for (const term of ordered) {
    const candidate = [...selected, term].join(" ");
    if (!fitsGitHubSearchLimit(candidate, maxLength, maxEncodedLength)) continue;
    selected.push(term);
  }

  const compacted = selected.join(" ").trim();
  if (compacted) return compacted;
  return truncateToGitHubSearchLimit("secure software development appsec testing", maxLength, maxEncodedLength);
}

function fitsGitHubSearchLimit(value: string, maxLength: number, maxEncodedLength: number): boolean {
  return value.length <= maxLength && encodeURIComponent(value).length <= maxEncodedLength;
}

function truncateToGitHubSearchLimit(value: string, maxLength: number, maxEncodedLength: number): string {
  let output = value.slice(0, maxLength).trim();
  while (output && encodeURIComponent(output).length > maxEncodedLength) {
    output = output.slice(0, -1).trim();
  }
  return output || "software";
}

function tokenize(query: string): string[] {
  return query
    .replace(/["'`“”‘’]/g, " ")
    .split(/[^a-zA-Z0-9_.#+-]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function termPriority(term: string): number {
  const lower = term.toLowerCase();
  let score = Math.min(12, term.length);
  if (/^(owasp|asvs|nist|cisa|appsec|security|sast|dast|sca|webhook|auth|authorization|vulnerability|scanner|semgrep|codeql|trivy|zap|dependency|secret|iac|ssrf|csrf|cors)$/i.test(lower)) {
    score += 20;
  }
  if (/^(implementation|example|template|repository|library|framework|docs|testing|validation|release|gate)$/i.test(lower)) {
    score += 10;
  }
  if (/[._#+-]/.test(term)) score += 4;
  return score;
}

const GITHUB_QUERY_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "being",
  "best",
  "but",
  "can",
  "close",
  "correct",
  "did",
  "does",
  "doing",
  "exactly",
  "for",
  "from",
  "gap",
  "gonna",
  "have",
  "how",
  "into",
  "like",
  "most",
  "not",
  "only",
  "projects",
  "should",
  "that",
  "the",
  "their",
  "this",
  "use",
  "using",
  "vibe",
  "vibecode",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you"
]);
