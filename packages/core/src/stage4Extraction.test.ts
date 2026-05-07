import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawItem } from "@agent-search/shared";
import { canonicalizeEvidenceUrl, resolveAndExtractEvidence } from "./stage4Extraction.js";

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    constructor(_params: unknown) {}
    async getText() {
      return { text: "PDF extracted evidence text ".repeat(20) };
    }
    async destroy() {}
  }
}));

describe("stage 4 evidence extraction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canonicalizes arXiv, DOI, GitHub, and official URLs before chunking", () => {
    expect(canonicalizeEvidenceUrl(raw({ source: "arxiv", url: "https://arxiv.org/pdf/2401.12345.pdf" })).canonicalUrl).toBe(
      "https://arxiv.org/abs/2401.12345"
    );
    expect(canonicalizeEvidenceUrl(raw({ source: "crossref", metadata: { doi: "https://doi.org/10.5555/ABC" } })).key).toBe("doi:10.5555/abc");
    expect(canonicalizeEvidenceUrl(raw({ source: "github", source_type: "code", url: "https://github.com/Owner/Repo/issues/1" })).canonicalUrl).toBe(
      "https://github.com/Owner/Repo"
    );
    expect(
      canonicalizeEvidenceUrl(raw({ source: "official_docs", url: "https://example.gov/report?utm_source=test#section" })).canonicalUrl
    ).toBe("https://example.gov/report");
  });

  it("extracts readable HTML when structured source text is too thin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<article><h1>Evidence</h1><p>Readable official evidence text ".repeat(30) + "</p></article>", {
        headers: { "content-type": "text/html" }
      }))
    );

    const result = await resolveAndExtractEvidence([raw({ text: "thin" })], {
      minFullTextChars: 120,
      minDegradedTextChars: 20
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.extraction.extraction_method).toBe("readability_html");
    expect(result.documents[0]?.extraction.extraction_status).toBe("full_text");
    expect(result.diagnostics.deepened_document_count).toBe(1);
  });

  it("parses PDF text when the canonical document is a PDF", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "content-type": "application/pdf" }
      }))
    );

    const result = await resolveAndExtractEvidence([raw({ url: "https://example.gov/report.pdf", text: "" })], {
      minFullTextChars: 80,
      minDegradedTextChars: 20
    });

    expect(result.documents[0]?.extraction.extraction_method).toBe("pdf_text");
    expect(result.documents[0]?.extraction.extraction_status).toBe("full_text");
    expect(result.documents[0]?.extraction.attempts.some((attempt) => attempt.retrieval_method === "pdf_fetch")).toBe(true);
  });

  it("records timeout failures and keeps metadata-only degraded evidence visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
      )
    );

    const result = await resolveAndExtractEvidence([raw({ text: "", summary: null, title: null })], {
      fetchTimeoutMs: 1,
      minFullTextChars: 80,
      minDegradedTextChars: 20
    });

    const extraction = result.documents[0]?.extraction;
    expect(extraction?.extraction_status).toBe("metadata_only");
    expect(extraction?.attempts.some((attempt) => attempt.status === "failed" && attempt.error_code === "timeout")).toBe(true);
    expect(result.diagnostics.metadata_only_count).toBe(1);
  });
});

function raw(overrides: Partial<RawItem> = {}): RawItem {
  return {
    id: overrides.id ?? "raw-1",
    source: overrides.source ?? "official_docs",
    source_type: overrides.source_type ?? "government",
    url: overrides.url ?? "https://example.gov/page",
    title: overrides.title ?? "Example source",
    author: overrides.author ?? null,
    publish_date: overrides.publish_date ?? null,
    text: overrides.text ?? "Structured source snippet",
    summary: overrides.summary ?? "Short summary",
    metadata: overrides.metadata ?? {},
    ...overrides
  };
}
