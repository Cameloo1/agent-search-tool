import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchOptions, SubQuery } from "@agent-search/shared";
import { coreHandler } from "./core.js";
import { arxivHandler } from "./arxiv.js";
import { crossrefHandler } from "./crossref.js";
import { dataGovHandler } from "./dataGov.js";
import { compactGitHubSearchQuery, githubHandler } from "./github.js";
import { hackerNewsHandler } from "./hackerNews.js";
import { openAlexHandler } from "./openAlex.js";
import { officialDocsHandler } from "./officialDocs.js";
import { pubmedHandler } from "./pubmed.js";
import { compactSecSearchQuery, secEdgarHandler, secEftsSearchUrl } from "./secEdgar.js";
import { semanticScholarHandler } from "./semanticScholar.js";
import { stackExchangeHandler } from "./stackExchange.js";
import { wikidataHandler } from "./wikidata.js";
import { wikipediaHandler } from "./wikipedia.js";
import { sourceError } from "./utils/http.js";

const baseSubQuery: SubQuery = {
  sub_query: "secure software development",
  target_sources: ["wikipedia"],
  retrieval_intent: "definitional",
  max_results: 2
};

const options: FetchOptions = {
  timeoutMs: 1000,
  maxResults: 2
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("source handlers", () => {
  it("maps Wikipedia search results to RawItem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          pages: [{ id: 1, key: "Secure_by_design", title: "Secure by design", excerpt: "<b>Security</b>", description: "Software design" }]
        })
      }))
    );

    const result = await wikipediaHandler.fetch(baseSubQuery, options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.source).toBe("wikipedia");
      expect(result.items[0]?.url).toContain("wikipedia.org");
    }
  });

  it("normalizes API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => "rate limited"
      }))
    );

    const result = await githubHandler.fetch({ ...baseSubQuery, target_sources: ["github"] }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.code).toBe("HTTP_429");
      expect(result.error.category).toBe("rate_limited");
    }
  });

  it("normalizes non-string source error codes", () => {
    const numeric = sourceError(429, "rate limited", true);
    expect(numeric.code).toBe("HTTP_429");
    expect(numeric.category).toBe("rate_limited");

    const objectCode = sourceError({ code: "HTTP_403" }, "forbidden", false);
    expect(objectCode.code).toBe("HTTP_403");
    expect(objectCode.category).toBe("unavailable");
  });

  it("compacts GitHub searches below the API query length limit", async () => {
    const longQuery = [
      "How to use an LLM like GPT-5.5 for appsec and pre-production testing the correct way",
      "why exactly are most vibecode projects insecure and unoptimized",
      "OWASP ASVS NIST SSDF CISA secure by design webhook authorization SAST DAST SCA secrets IaC SSRF CORS CSRF release gate",
      "implementation examples documentation repository template framework scanner rules"
    ].join(" ");
    const compacted = compactGitHubSearchQuery(longQuery);
    expect(compacted.length).toBeLessThanOrEqual(220);
    expect(encodeURIComponent(compacted).length).toBeLessThanOrEqual(256);
    expect(compacted).toContain("authorization");
    expect(compacted).toContain("OWASP");

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [] })
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await githubHandler.fetch({ ...baseSubQuery, sub_query: longQuery, target_sources: ["github"] }, options);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    const decodedQuery = new URL(url).searchParams.get("q") ?? "";
    expect(decodedQuery.length).toBeLessThanOrEqual(220);
    expect(encodeURIComponent(decodedQuery).length).toBeLessThanOrEqual(256);
    expect(decodedQuery).toBe(compacted);
  });

  it("compacts symbol-heavy GitHub searches below the encoded API query length limit", () => {
    const compacted = compactGitHubSearchQuery(Array.from({ length: 80 }, () => "C++ C# .NET CodeQL").join(" "));
    expect(compacted.length).toBeLessThanOrEqual(220);
    expect(encodeURIComponent(compacted).length).toBeLessThanOrEqual(256);
  });

  it("sends Semantic Scholar API keys when configured", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ paperId: "p1", title: "Paper", abstract: "Abstract" }] })
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await semanticScholarHandler.fetch(
      { ...baseSubQuery, target_sources: ["semantic_scholar"] },
      { ...options, apiKeys: { semanticScholar: "s2-test-key" } }
    );

    expect(result.ok).toBe(true);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)?.["x-api-key"]).toBe("s2-test-key");
  });

  it("retries Semantic Scholar once after a rate-limit response without reducing requested articles", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Too Many Requests"
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ paperId: "p1", title: "Paper", abstract: "Abstract" }] })
      });
    vi.stubGlobal("fetch", fetchSpy);

    const promise = semanticScholarHandler.fetch({ ...baseSubQuery, target_sources: ["semantic_scholar"] }, options);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0]);
    const secondUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(new URL(firstUrl).searchParams.get("limit")).toBe(String(options.maxResults));
    expect(new URL(secondUrl).searchParams.get("limit")).toBe(String(options.maxResults));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.metadata.rate_limit_retry_count).toBe(1);
  });

  it("gracefully disables CORE when key is absent", async () => {
    const result = await coreHandler.fetch({ ...baseSubQuery, target_sources: ["core"] }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CORE_API_KEY_MISSING");
  });

  it("maps academic source responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            "<feed><entry><id>https://arxiv.org/abs/1234.5678</id><title>Dedup</title><summary>Chunk deduplication</summary><published>2025-01-01T00:00:00Z</published><author><name>Ada</name></author></entry></feed>"
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ paperId: "p1", title: "Paper", abstract: "Abstract", authors: [{ name: "Ada" }] }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: [{ id: "https://openalex.org/W1", title: "Work", publication_date: "2025-01-01" }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ message: { items: [{ DOI: "10.1/test", title: ["CrossRef Work"] }] } })
        })
    );

    await expect(arxivHandler.fetch({ ...baseSubQuery, target_sources: ["arxiv"] }, options)).resolves.toMatchObject({ ok: true });
    await expect(
      semanticScholarHandler.fetch({ ...baseSubQuery, target_sources: ["semantic_scholar"] }, options)
    ).resolves.toMatchObject({ ok: true });
    await expect(openAlexHandler.fetch({ ...baseSubQuery, target_sources: ["openalex"] }, options)).resolves.toMatchObject({ ok: true });
    await expect(crossrefHandler.fetch({ ...baseSubQuery, target_sources: ["crossref"] }, options)).resolves.toMatchObject({ ok: true });
  });

  it("maps medical, structured, discussion, filing, and government sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ esearchresult: { idlist: ["123"] } }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: { "123": { uid: "123", title: "Medical", authors: [{ name: "Ada" }] } } })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: { bindings: [{ item: { value: "https://www.wikidata.org/wiki/Q1" }, itemLabel: { value: "Entity" } }] }
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ items: [{ question_id: 1, title: "Stack", link: "https://stackoverflow.com/q/1" }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ hits: [{ objectID: "1", title: "HN", url: "https://news.ycombinator.com/item?id=1" }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ hits: { hits: [{ _id: "a", _source: { company: "ACME", form: "10-K", filing_url: "https://www.sec.gov/a" } }] } })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                identifier: "d1",
                title: "Dataset",
                slug: "dataset",
                description: "Official data",
                publisher: "Agency",
                dcat: { modified: "2026-01-01T00:00:00Z" }
              }
            ]
          })
        })
    );

    await expect(pubmedHandler.fetch({ ...baseSubQuery, target_sources: ["pubmed"] }, options)).resolves.toMatchObject({ ok: true });
    await expect(wikidataHandler.fetch({ ...baseSubQuery, target_sources: ["wikidata"] }, options)).resolves.toMatchObject({ ok: true });
    await expect(stackExchangeHandler.fetch({ ...baseSubQuery, target_sources: ["stack_exchange"] }, options)).resolves.toMatchObject({
      ok: true
    });
    await expect(hackerNewsHandler.fetch({ ...baseSubQuery, target_sources: ["hacker_news"] }, options)).resolves.toMatchObject({ ok: true });
    await expect(
      secEdgarHandler.fetch({ ...baseSubQuery, target_sources: ["sec_edgar"] }, { ...options, secUserAgent: "test@example.com" })
    ).resolves.toMatchObject({ ok: true });
    await expect(dataGovHandler.fetch({ ...baseSubQuery, target_sources: ["data_gov"] }, options)).resolves.toMatchObject({ ok: true });
  });

  it("makes missing SEC user agent explicit", async () => {
    const result = await secEdgarHandler.fetch({ ...baseSubQuery, target_sources: ["sec_edgar"] }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SEC_USER_AGENT_MISSING");
  });

  it("queries SEC EFTS with GET query parameters and maps current response fields", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: {
          hits: [
            {
              _id: "0001213900-23-033683:f20f2022ex4-19_xiaoicorp.htm",
              _source: {
                ciks: ["0001935172"],
                display_names: ["Xiao-I Corp  (AIXI)  (CIK 0001935172)"],
                form: "20-F",
                adsh: "0001213900-23-033683",
                file_date: "2023-04-28",
                file_num: ["001-41631"],
                file_type: "EX-4.19",
                file_description: "AI cloud platform service contract"
              }
            }
          ]
        }
      })
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await secEdgarHandler.fetch(
      { ...baseSubQuery, sub_query: "artificial intelligence", target_sources: ["sec_edgar"] },
      { ...options, maxResults: 1, secUserAgent: "AgentSearchTool/0.1 contact@example.com" }
    );

    expect(result.ok).toBe(true);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(url).toBe(secEftsSearchUrl("artificial intelligence", 1));
    expect(new URL(url).searchParams.get("q")).toBe("artificial intelligence");
    expect(init?.method).toBeUndefined();
    expect((init?.headers as Record<string, string>)?.["User-Agent"]).toContain("AgentSearchTool");
    if (result.ok) {
      expect(result.items[0]?.title).toContain("Xiao-I Corp");
      expect(result.items[0]?.url).toBe(
        "https://www.sec.gov/Archives/edgar/data/1935172/000121390023033683/f20f2022ex4-19_xiaoicorp.htm"
      );
      expect(result.items[0]?.metadata.file_number).toBe("001-41631");
    }
  });

  it("keeps inference-capex SEC searches on the live EFTS search endpoint", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: {
          hits: [
            {
              _id: "0000320193-25-000008:aapl-20241228.htm",
              _source: {
                ciks: ["0000320193"],
                display_names: ["Apple Inc.  (AAPL)  (CIK 0000320193)"],
                form: "10-Q",
                adsh: "0000320193-25-000008",
                file_date: "2025-01-31",
                file_description: "10-Q filing"
              }
            }
          ]
        }
      })
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const subQuery =
      "publicly traded AI infrastructure companies latest 10-K or 10-Q filing disclosures capital expenditure increases inference compute site:sec_edgar";
    const result = await secEdgarHandler.fetch(
      { ...baseSubQuery, sub_query: subQuery, target_sources: ["sec_edgar"] },
      { ...options, secUserAgent: "AgentSearchTool/0.1 contact@example.com" }
    );

    expect(result.ok).toBe(true);
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://efts.sec.gov");
    expect(url.pathname).toBe("/LATEST/search-index");
    expect(url.searchParams.get("q")).toBe(compactSecSearchQuery(subQuery));
    expect(url.searchParams.get("q")).toBe("AI inference compute capital expenditure infrastructure 10-K 10-Q");
    expect(url.searchParams.get("q")).not.toContain("site:sec_edgar");
    expect(url.searchParams.get("q")).not.toContain("publicly");
    expect(url.pathname).not.toContain("companyfacts");
    if (result.ok) {
      expect(result.items[0]?.source).toBe("sec_edgar");
      expect(result.items[0]?.source_type).toBe("filing");
    }
  });

  it("returns constrained official documentation results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => "<html><body>OWASP application security verification standard authorization testing.</body></html>"
      }))
    );

    const result = await officialDocsHandler.fetch(
      { ...baseSubQuery, sub_query: "OWASP ASVS authorization testing", target_sources: ["official_docs"] },
      { ...options, maxResults: 1 }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.source).toBe("official_docs");
      expect(result.items[0]?.url).toContain("owasp.org");
      expect(result.items[0]?.text).toContain("authorization");
    }
  });

  it("broadens over-specific data.gov commodity queries when the first search is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                identifier: "prices",
                title: "Short-Term Energy Outlook - Real and Nominal Petroleum Prices",
                slug: "petroleum-prices",
                description: "Official petroleum price data"
              }
            ]
          })
        })
    );

    const result = await dataGovHandler.fetch(
      {
        ...baseSubQuery,
        sub_query: "when will oil prices come down crude oil price forecast EIA Brent WTI supply demand inventory",
        target_sources: ["data_gov"]
      },
      options
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.title).toContain("Petroleum Prices");
    }
  });
});
