import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  EvidenceDocumentSchema,
  ExtractionMetadataSchema,
  ExtractionTraceSchema,
  type EvidenceDocument,
  type ExtractionAttempt,
  type ExtractionMetadata,
  type ExtractionTrace,
  type RawItem
} from "@agent-search/shared";

export interface EvidenceExtractionOptions {
  enabled?: boolean;
  maxDocuments?: number;
  fetchTimeoutMs?: number;
  concurrency?: number;
  maxExtractedTextChars?: number;
  maxPdfPages?: number;
  minFullTextChars?: number;
  minDegradedTextChars?: number;
}

export interface EvidenceExtractionResult {
  rawItems: RawItem[];
  documents: EvidenceDocument[];
  diagnostics: ExtractionTrace;
}

interface CanonicalGroup {
  key: string;
  canonicalUrl: string;
  documentType: ExtractionMetadata["document_type"];
  items: RawItem[];
}

interface ExtractionWorkResult {
  document: EvidenceDocument;
  deepened: boolean;
}

const DEFAULT_EXTRACTION_OPTIONS: Required<EvidenceExtractionOptions> = {
  enabled: true,
  maxDocuments: 12,
  fetchTimeoutMs: 4_000,
  concurrency: 4,
  maxExtractedTextChars: 30_000,
  maxPdfPages: 8,
  minFullTextChars: 1_200,
  minDegradedTextChars: 300
};

const THIN_TEXT_SOURCES = new Set(["arxiv", "semantic_scholar", "openalex", "crossref", "core", "pubmed"]);
const QUERY_PARAMS_TO_DROP = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid"
]);

export function resolveExtractionOptions(options: EvidenceExtractionOptions = {}): Required<EvidenceExtractionOptions> {
  return { ...DEFAULT_EXTRACTION_OPTIONS, ...options };
}

export function canonicalizeEvidenceUrl(item: RawItem): {
  key: string;
  canonicalUrl: string;
  documentType: ExtractionMetadata["document_type"];
} {
  const metadata = item.metadata ?? {};
  const doi = readString(metadata.doi) ?? readString(metadata.DOI);
  if (doi) {
    const normalizedDoi = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
    return {
      key: `doi:${normalizedDoi}`,
      canonicalUrl: `https://doi.org/${normalizedDoi}`,
      documentType: "paper"
    };
  }

  const arxivId = extractArxivId(item.url) ?? readString(metadata.arxiv_id) ?? readString(metadata.arxivId);
  if (arxivId) {
    const normalized = arxivId.replace(/\.pdf$/i, "");
    return {
      key: `arxiv:${normalized.toLowerCase()}`,
      canonicalUrl: `https://arxiv.org/abs/${normalized}`,
      documentType: "paper"
    };
  }

  const githubRepo = extractGithubRepo(item.url);
  if (githubRepo) {
    return {
      key: `github:${githubRepo.toLowerCase()}`,
      canonicalUrl: `https://github.com/${githubRepo}`,
      documentType: "repository"
    };
  }

  const normalizedUrl = normalizeUrl(item.url, item.source);
  const titleKey = item.source_type === "academic" && item.title ? `title:${stableText(item.title)}` : normalizedUrl;
  return {
    key: titleKey,
    canonicalUrl: normalizedUrl,
    documentType: documentTypeForItem(item, normalizedUrl)
  };
}

export async function resolveAndExtractEvidence(
  rawItems: RawItem[],
  options: EvidenceExtractionOptions = {}
): Promise<EvidenceExtractionResult> {
  const resolved = resolveExtractionOptions(options);
  const started = Date.now();

  if (!resolved.enabled || rawItems.length === 0) {
    const passthroughDocuments = rawItems.map((item) =>
      documentFromRawItem(item, canonicalizeEvidenceUrl(item), {
        attempts: [],
        text: item.text,
        status: item.text.trim() ? "snippet" : "metadata_only",
        method: item.text.trim() ? "source_snippet" : "metadata_only",
        retrievalMethod: "source_api",
        confidence: item.text.trim() ? 0.35 : 0.1,
        coverage: item.text.trim() ? 0.25 : 0,
        degradationReason: item.text.trim() ? "Extraction ladder disabled." : "No usable source text."
      })
    );
    const diagnostics = buildDiagnostics(passthroughDocuments, 0, Date.now() - started, rawItems.length, 0, resolved.maxDocuments);
    return { rawItems: passthroughDocuments.map(rawItemFromDocument), documents: passthroughDocuments, diagnostics };
  }

  const groups = groupCanonicalDocuments(rawItems);
  const deepenSet = new Set(groups.slice(0, resolved.maxDocuments).map((group) => group.key));
  const workResults = await mapWithConcurrency(groups, resolved.concurrency, async (group) =>
    extractGroup(group, resolved, deepenSet.has(group.key))
  );

  const documents = workResults.map((result) => result.document);
  const diagnostics = buildDiagnostics(
    documents,
    workResults.filter((result) => result.deepened).length,
    Date.now() - started,
    rawItems.length,
    groups.length,
    resolved.maxDocuments
  );

  return {
    rawItems: documents.map(rawItemFromDocument),
    documents,
    diagnostics
  };
}

export function mergeExtractionTrace(current: ExtractionTrace | undefined, next: ExtractionTrace): ExtractionTrace {
  if (!current) return next;
  return ExtractionTraceSchema.parse({
    document_count: current.document_count + next.document_count,
    source_item_count: current.source_item_count + next.source_item_count,
    deepened_document_count: current.deepened_document_count + next.deepened_document_count,
    degraded_document_count: current.degraded_document_count + next.degraded_document_count,
    metadata_only_count: current.metadata_only_count + next.metadata_only_count,
    failed_extraction_count: current.failed_extraction_count + next.failed_extraction_count,
    attempt_count: current.attempt_count + next.attempt_count,
    duration_ms: current.duration_ms + next.duration_ms,
    max_documents: Math.max(current.max_documents, next.max_documents),
    documents: [...current.documents, ...next.documents]
  });
}

function groupCanonicalDocuments(rawItems: RawItem[]): CanonicalGroup[] {
  const groups = new Map<string, CanonicalGroup>();
  for (const item of rawItems) {
    const canonical = canonicalizeEvidenceUrl(item);
    const existing = groups.get(canonical.key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(canonical.key, {
        key: canonical.key,
        canonicalUrl: canonical.canonicalUrl,
        documentType: canonical.documentType,
        items: [item]
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => bestItemScore(selectPrimaryItem(b.items)) - bestItemScore(selectPrimaryItem(a.items)));
}

async function extractGroup(
  group: CanonicalGroup,
  options: Required<EvidenceExtractionOptions>,
  mayDeepen: boolean
): Promise<ExtractionWorkResult> {
  const primary = selectPrimaryItem(group.items);
  const apiAttempt = attemptFromStructuredText(primary, group, options);
  const enoughStructuredText = apiAttempt.status === "full_text";
  const shouldDeepen = mayDeepen && !enoughStructuredText && canFetchCanonicalUrl(primary, group);

  if (shouldDeepen) {
    const fetchAttempt = await attemptFromCanonicalUrl(group, options);
    const bestAttempt = chooseBestAttempt([apiAttempt, fetchAttempt]);
    return {
      deepened: true,
      document: documentFromRawItem(primary, group, {
        ...bestAttempt,
        attempts: [apiAttempt.attempt, fetchAttempt.attempt]
      })
    };
  }

  return {
    deepened: false,
    document: documentFromRawItem(primary, group, {
      ...apiAttempt,
      attempts: [apiAttempt.attempt]
    })
  };
}

function attemptFromStructuredText(primary: RawItem, group: CanonicalGroup, options: Required<EvidenceExtractionOptions>): InternalAttempt {
  const started = Date.now();
  const text = truncateText(composeRawText(primary), options.maxExtractedTextChars);
  const status = statusForStructuredText(text, primary, options);
  const confidence = confidenceForStatus(status);
  const coverage = coverageForStatus(status);
  const method = status === "metadata_only" ? "metadata_only" : status === "snippet" ? "source_snippet" : "source_api_text";
  return {
    text,
    status,
    method,
    retrievalMethod: "source_api",
    confidence,
    coverage,
    degradationReason: degradationReasonForStatus(status, group.documentType),
    attempt: {
      method,
      retrieval_method: "source_api",
      status,
      duration_ms: Date.now() - started,
      char_count: text.length,
      started_at: new Date(started).toISOString()
    }
  };
}

async function attemptFromCanonicalUrl(
  group: CanonicalGroup,
  options: Required<EvidenceExtractionOptions>
): Promise<InternalAttempt> {
  const started = Date.now();
  const isPdf = group.documentType === "pdf" || /\.pdf($|[?#])/i.test(group.canonicalUrl);
  const retrievalMethod = isPdf ? "pdf_fetch" : "html_fetch";
  const method = isPdf ? "pdf_text" : "readability_html";

  try {
    const response = await fetchWithTimeout(group.canonicalUrl, options.fetchTimeoutMs);
    const contentType = response.headers.get("content-type") ?? "";
    const finalIsPdf = isPdf || contentType.toLowerCase().includes("pdf");
    const extracted = finalIsPdf
      ? await extractPdfText(await response.arrayBuffer(), options)
      : extractReadableHtml(await response.text(), response.url || group.canonicalUrl, options);
    const text = truncateText(extracted, options.maxExtractedTextChars);
    const status = statusForExtractedText(text, options);
    const confidence = confidenceForStatus(status);
    const coverage = coverageForStatus(status);
    return {
      text,
      status,
      method: finalIsPdf ? "pdf_text" : "readability_html",
      retrievalMethod: finalIsPdf ? "pdf_fetch" : retrievalMethod,
      confidence,
      coverage,
      degradationReason: degradationReasonForStatus(status, group.documentType),
      attempt: {
        method: finalIsPdf ? "pdf_text" : "readability_html",
        retrieval_method: finalIsPdf ? "pdf_fetch" : retrievalMethod,
        status,
        duration_ms: Date.now() - started,
        char_count: text.length,
        started_at: new Date(started).toISOString()
      }
    };
  } catch (error) {
    return {
      text: "",
      status: "failed",
      method,
      retrievalMethod,
      confidence: 0,
      coverage: 0,
      degradationReason: error instanceof Error ? error.message : "Extraction fetch failed.",
      attempt: {
        method,
        retrieval_method: retrievalMethod,
        status: "failed",
        duration_ms: Date.now() - started,
        char_count: 0,
        started_at: new Date(started).toISOString(),
        error_code: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "extract_failed",
        error_message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "agent-search-tool/0.1 evidence-extractor"
      }
    });
    if (!response.ok) {
      throw new Error(`Extraction fetch failed with HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractPdfText(buffer: ArrayBuffer, options: Required<EvidenceExtractionOptions>): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) } as never);
  try {
    const result = await parser.getText({ first: options.maxPdfPages, parseHyperlinks: true });
    return cleanText(result.text ?? "");
  } finally {
    await parser.destroy();
  }
}

function extractReadableHtml(html: string, url: string, options: Required<EvidenceExtractionOptions>): string {
  const dom = new JSDOM(html, { url });
  try {
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent ?? dom.window.document.body?.textContent ?? "";
    return truncateText(cleanText(text), options.maxExtractedTextChars);
  } finally {
    dom.window.close();
  }
}

function documentFromRawItem(
  item: RawItem,
  canonical: Pick<CanonicalGroup, "canonicalUrl" | "documentType">,
  result: {
    text: string;
    status: ExtractionMetadata["extraction_status"];
    method: ExtractionMetadata["extraction_method"];
    retrievalMethod: ExtractionMetadata["retrieval_method"];
    confidence: number;
    coverage: number;
    degradationReason?: string;
    attempts: ExtractionAttempt[];
  }
): EvidenceDocument {
  const fallbackText = composeMetadataText(item);
  const text = result.text.trim() || fallbackText;
  const previousExtraction = ExtractionMetadataSchema.safeParse(item.metadata.extraction);
  const attempts = previousExtraction.success ? [...previousExtraction.data.attempts, ...result.attempts] : result.attempts;
  const extraction = ExtractionMetadataSchema.parse({
    canonical_url: canonical.canonicalUrl,
    document_type: canonical.documentType,
    retrieval_method: result.retrievalMethod,
    extraction_method: result.method,
    extraction_status: result.status,
    extraction_confidence: result.confidence,
    content_coverage: result.coverage,
    section_path: [],
    degradation_reason: result.degradationReason,
    attempts
  });
  return EvidenceDocumentSchema.parse({
    id: `doc:${hashStable(`${item.source}:${canonical.canonicalUrl}`)}`,
    source: item.source,
    source_type: item.source_type,
    url: canonical.canonicalUrl,
    title: item.title,
    author: item.author,
    publish_date: item.publish_date,
    text,
    summary: item.summary,
    metadata: { ...item.metadata, extraction },
    extraction
  });
}

function rawItemFromDocument(document: EvidenceDocument): RawItem {
  return {
    id: document.id,
    source: document.source,
    source_type: document.source_type,
    url: document.url,
    title: document.title,
    author: document.author,
    publish_date: document.publish_date,
    text: document.text,
    summary: document.summary,
    metadata: { ...document.metadata, extraction: document.extraction }
  };
}

interface InternalAttempt {
  text: string;
  status: ExtractionMetadata["extraction_status"];
  method: ExtractionMetadata["extraction_method"];
  retrievalMethod: ExtractionMetadata["retrieval_method"];
  confidence: number;
  coverage: number;
  degradationReason?: string;
  attempt: ExtractionAttempt;
}

function chooseBestAttempt(attempts: InternalAttempt[]): InternalAttempt {
  return attempts.reduce((best, attempt) => {
    if (scoreStatus(attempt.status) > scoreStatus(best.status)) return attempt;
    if (scoreStatus(attempt.status) === scoreStatus(best.status) && attempt.text.length > best.text.length) return attempt;
    return best;
  });
}

function statusForStructuredText(
  text: string,
  item: RawItem,
  options: Required<EvidenceExtractionOptions>
): ExtractionMetadata["extraction_status"] {
  if (item.metadata.mode === "mock" && text.trim()) return "full_text";
  if (text.length >= options.minFullTextChars) return "full_text";
  if (text.length >= options.minDegradedTextChars && THIN_TEXT_SOURCES.has(item.source)) {
    return "structured_abstract";
  }
  if (text.length >= options.minDegradedTextChars) return "snippet";
  return text.trim() ? "snippet" : "metadata_only";
}

function statusForExtractedText(
  text: string,
  options: Required<EvidenceExtractionOptions>
): ExtractionMetadata["extraction_status"] {
  if (text.length >= options.minFullTextChars) return "full_text";
  if (text.length >= options.minDegradedTextChars) return "section_text";
  return text.trim() ? "snippet" : "metadata_only";
}

function scoreStatus(status: ExtractionMetadata["extraction_status"]): number {
  switch (status) {
    case "full_text":
      return 5;
    case "section_text":
      return 4;
    case "structured_abstract":
      return 3;
    case "snippet":
      return 2;
    case "metadata_only":
      return 1;
    case "failed":
      return 0;
  }
}

function confidenceForStatus(status: ExtractionMetadata["extraction_status"]): number {
  switch (status) {
    case "full_text":
      return 0.9;
    case "section_text":
      return 0.8;
    case "structured_abstract":
      return 0.55;
    case "snippet":
      return 0.35;
    case "metadata_only":
      return 0.1;
    case "failed":
      return 0;
  }
}

function coverageForStatus(status: ExtractionMetadata["extraction_status"]): number {
  switch (status) {
    case "full_text":
      return 0.85;
    case "section_text":
      return 0.65;
    case "structured_abstract":
      return 0.45;
    case "snippet":
      return 0.25;
    case "metadata_only":
    case "failed":
      return 0;
  }
}

function degradationReasonForStatus(
  status: ExtractionMetadata["extraction_status"],
  documentType: ExtractionMetadata["document_type"]
): string | undefined {
  if (status === "full_text" || status === "section_text") return undefined;
  if (status === "structured_abstract") return "Only structured abstract-level text was available.";
  if (status === "snippet") return "Only snippet or short source text was available.";
  if (status === "metadata_only") return `Only ${documentType} metadata was available.`;
  return "Extraction failed.";
}

function canFetchCanonicalUrl(item: RawItem, group: CanonicalGroup): boolean {
  if (!group.canonicalUrl.startsWith("http://") && !group.canonicalUrl.startsWith("https://")) return false;
  if (item.metadata.mode === "mock") return false;
  if (item.source === "github") return false;
  return true;
}

function documentTypeForItem(item: RawItem, url: string): ExtractionMetadata["document_type"] {
  if (/\.pdf($|[?#])/i.test(url)) return "pdf";
  if (item.source === "github" || item.source_type === "code") return "repository";
  if (item.source === "sec_edgar" || item.source_type === "filing") return "filing";
  if (item.source === "data_gov" || item.source_type === "government") return "dataset";
  if (item.source_type === "academic" || ["arxiv", "semantic_scholar", "openalex", "crossref", "core"].includes(item.source)) {
    return "paper";
  }
  if (url.startsWith("http")) return "html";
  return "unknown";
}

function selectPrimaryItem(items: RawItem[]): RawItem {
  const primary = [...items].sort((a, b) => bestItemScore(b) - bestItemScore(a))[0];
  if (!primary) throw new Error("Canonical document group had no source items.");
  return primary;
}

function bestItemScore(item: RawItem): number {
  const sourceWeight = item.source_type === "government" || item.source_type === "filing" ? 20 : 0;
  return sourceWeight + composeRawText(item).length;
}

function composeRawText(item: RawItem): string {
  return cleanText([item.title, item.summary, item.text].filter(Boolean).join("\n\n"));
}

function composeMetadataText(item: RawItem): string {
  return cleanText([item.title, item.summary, item.text].filter(Boolean).join("\n\n"));
}

function cleanText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function normalizeUrl(value: string, source?: RawItem["source"]): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (QUERY_PARAMS_TO_DROP.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    if (source === "official_docs" || source === "sec_edgar" || source === "data_gov") {
      url.search = "";
    }
    if (url.hostname === "arxiv.org") {
      const arxivId = extractArxivId(url.toString());
      if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function extractArxivId(value: string): string | undefined {
  const match = value.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)(?:\.pdf)?/i);
  return match?.[1];
}

function extractGithubRepo(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashStable(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function buildDiagnostics(
  documents: EvidenceDocument[],
  deepenedDocumentCount: number,
  durationMs: number,
  sourceItemCount: number,
  documentCount: number,
  maxDocuments: number
): ExtractionTrace {
  const traces = documents.map((document) => {
    const degraded = isDegraded(document.extraction.extraction_status);
    return {
      document_id: document.id,
      source: document.source,
      canonical_url: document.extraction.canonical_url,
      document_type: document.extraction.document_type,
      extraction_status: document.extraction.extraction_status,
      extraction_method: document.extraction.extraction_method,
      duration_ms: document.extraction.attempts.reduce((sum, attempt) => sum + attempt.duration_ms, 0),
      char_count: document.text.length,
      degraded,
      attempts: document.extraction.attempts,
      degradation_reason: document.extraction.degradation_reason
    };
  });
  return ExtractionTraceSchema.parse({
    document_count: documentCount || documents.length,
    source_item_count: sourceItemCount,
    deepened_document_count: deepenedDocumentCount,
    degraded_document_count: traces.filter((trace) => trace.degraded).length,
    metadata_only_count: traces.filter((trace) => trace.extraction_status === "metadata_only").length,
    failed_extraction_count: traces.filter((trace) => trace.extraction_status === "failed").length,
    attempt_count: traces.reduce((sum, trace) => sum + trace.attempts.length, 0),
    duration_ms: durationMs,
    max_documents: maxDocuments,
    documents: traces
  });
}

function isDegraded(status: ExtractionMetadata["extraction_status"]): boolean {
  return status === "structured_abstract" || status === "snippet" || status === "metadata_only" || status === "failed";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
