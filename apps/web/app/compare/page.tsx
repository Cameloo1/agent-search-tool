"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ResultAnswerSection,
  ResultColumn,
  ResultColumnHeader,
  ResultDiagnosticsSections
} from "../../components/ResultColumn";
import { SearchBox, type PreviousRunNavItem } from "../../components/SearchBox";
import { BACKEND_STALL_AFTER_MS, deriveBackendStatus, statusFromBackendEvent } from "../../lib/backendStatus";
import {
  createInitialResults,
  createLoadingResults,
  ensureSideBySide,
  fetchSearchDebug,
  fetchSearchDebugRuns,
  getApiBaseUrl,
  normalizeComparePayload,
  providerOpponentSearch,
  search,
  searchStream,
  submitRunFeedback
} from "../../lib/api";
import type {
  ApiPipelineResponse,
  BackendStatusState,
  CompareResult,
  PipelineProgressEvent,
  ProviderOpponent,
  RunFeedbackRating,
  SearchDebugRecord,
  SearchRunFeedback,
  SearchFormValues,
  Trace
} from "../../lib/types";

const RUN_HISTORY_STORAGE_KEY = "agent-search-compare-run-history-v1";
const MAX_RUN_HISTORY = 30;
const MAX_PERSISTED_RUN_HISTORY = 12;
const MAX_BACKEND_DEBUG_RUNS = 12;
const TIMELINE_ROW_HEIGHT = 44;
const TIMELINE_VIEWPORT_HEIGHT = 260;
const TIMELINE_OVERSCAN = 10;

type PreviousRunEntry = PreviousRunNavItem & {
  createdAt: string;
  results: CompareResult[];
  progressEvents: PipelineProgressEvent[];
  debugRecord?: SearchDebugRecord;
  debugOpen: boolean;
  selectedOpponent?: ProviderOpponent;
  opponentError?: string;
};

type ComparePaneView = "run_metrics" | "opponent";

export default function ComparePage() {
  const [results, setResults] = useState<CompareResult[]>(() => createInitialResults());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [progressEvents, setProgressEvents] = useState<PipelineProgressEvent[]>([]);
  const [progressOpen, setProgressOpen] = useState(false);
  const [debugRecord, setDebugRecord] = useState<SearchDebugRecord>();
  const [debugOpen, setDebugOpen] = useState(false);
  const [currentQuery, setCurrentQuery] = useState("");
  const [selectedOpponent, setSelectedOpponent] = useState<ProviderOpponent>();
  const [opponentLoading, setOpponentLoading] = useState<ProviderOpponent>();
  const [opponentError, setOpponentError] = useState<string>();
  const [backendStatus, setBackendStatus] = useState<BackendStatusState>("idle");
  const [lastBackendEventAt, setLastBackendEventAt] = useState<number | null>(null);
  const [runHistory, setRunHistory] = useState<PreviousRunEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [comparePaneView, setComparePaneView] = useState<ComparePaneView>("run_metrics");
  const abortRef = useRef<AbortController | null>(null);
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const statusMessage = useMemo(() => latestProgressMessage(progressEvents), [progressEvents]);
  const agentCostSummary = results[0]?.pipeline?.trace?.cost_summary;
  const sideBySideResults = ensureSideBySide(results, currentQuery || results[0]?.pipeline?.query || "");
  const agentResult = sideBySideResults[0];
  const opponentResult = sideBySideResults[1];
  const previousRunItems = useMemo<PreviousRunNavItem[]>(
    () => runHistory.map((run) => ({ id: run.id, query: run.query })),
    [runHistory]
  );

  useEffect(() => {
    let canceled = false;
    let restoredFromStorage: PreviousRunEntry[] = [];

    try {
      const rawHistory = window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY);
      if (rawHistory) {
        const parsed: unknown = JSON.parse(rawHistory);
        if (Array.isArray(parsed)) {
          restoredFromStorage = parsed.filter(isStoredPreviousRunEntry).slice(0, MAX_RUN_HISTORY);
          setRunHistory(restoredFromStorage);
          restorePreviousRunState(restoredFromStorage[0]);
        } else {
          window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
        }
      }
    } catch {
      window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    } finally {
      setHistoryHydrated(true);
    }

    fetchSearchDebugRuns(MAX_BACKEND_DEBUG_RUNS)
      .then((records) => {
        if (canceled) return;
        const backendRuns = records.flatMap((record) => {
          const run = runEntryFromDebugRecord(record);
          return run ? [run] : [];
        });

        if (!backendRuns.length) return;

        setRunHistory((current) => {
          const merged = mergeRunHistory([...current, ...restoredFromStorage, ...backendRuns]);
          if (!current.length) {
            restorePreviousRunState(merged[0]);
          }
          return merged;
        });
      })
      .catch(() => undefined);

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyHydrated) {
      return;
    }

    try {
      const persisted = runHistory.slice(0, MAX_PERSISTED_RUN_HISTORY).map(toStoredPreviousRunEntry);
      window.localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Browser storage is best-effort. A failed write should not break search.
    }
  }, [historyHydrated, runHistory]);

  useEffect(() => {
    if (!isLoading || (backendStatus !== "live" && backendStatus !== "stalled")) {
      return;
    }

    const timer = window.setInterval(() => {
      setBackendStatus((current) =>
        deriveBackendStatus({
          current,
          isLoading: true,
          lastBackendEventAt,
          now: Date.now(),
          stallAfterMs: BACKEND_STALL_AFTER_MS
        })
      );
    }, 1000);

    return () => window.clearInterval(timer);
  }, [backendStatus, isLoading, lastBackendEventAt]);

  function markBackendEvent(event: PipelineProgressEvent) {
    setLastBackendEventAt(Date.now());
    setBackendStatus(statusFromBackendEvent(event));
  }

  async function handleSearch(values: SearchFormValues) {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setIsLoading(true);
    setError(undefined);
    setProgressEvents([]);
    setDebugRecord(undefined);
    setProgressOpen(true);
    setCurrentQuery(values.query);
    setResults(createLoadingResults(values.query));
    setOpponentError(undefined);
    setBackendStatus("idle");
    setLastBackendEventAt(null);
    setActiveRunId(undefined);
    setComparePaneView("run_metrics");

    try {
      const collectedEvents: PipelineProgressEvent[] = [];
      const requestPayload = {
        query: values.query,
        token_budget: values.tokenBudget,
        quality_mode: values.qualityMode,
        synthesize_answer: values.synthesizeAnswer,
        debug: true
      };
      let payload;
      try {
        payload = await searchStream(requestPayload, (event) => {
          collectedEvents.push(event);
          markBackendEvent(event);
          setProgressEvents((current) => [...current, event]);
        }, abortController.signal);
      } catch (streamError) {
        if (abortController.signal.aborted) {
          throw streamError;
        }
        const streamDroppedEvent: PipelineProgressEvent = {
          type: "stage_error",
          stage: "stream",
          message: "Streaming connection dropped; retrying with blocking search.",
          at: new Date().toISOString(),
          error: streamError instanceof Error ? streamError.message : String(streamError)
        };
        const fallbackStartEvent: PipelineProgressEvent = {
          type: "stage_start",
          stage: "fallback_search",
          message: "Running blocking search fallback.",
          at: new Date().toISOString()
        };
        markBackendEvent(fallbackStartEvent);
        collectedEvents.push(streamDroppedEvent, fallbackStartEvent);
        setProgressEvents((current) => [
          ...current,
          streamDroppedEvent,
          fallbackStartEvent
        ]);
        payload = await search(requestPayload);
        const fallbackCompleteEvent: PipelineProgressEvent = {
          type: "stage_complete",
          stage: "fallback_search",
          message: "Blocking search fallback completed.",
          at: new Date().toISOString()
        };
        markBackendEvent(fallbackCompleteEvent);
        collectedEvents.push(fallbackCompleteEvent);
        setProgressEvents((current) => [
          ...current,
          fallbackCompleteEvent
        ]);
      }
      const normalized = normalizeComparePayload(payload, values.query);
      const nextResults = ensureSideBySide(normalized, values.query);
      setResults(nextResults);
      setBackendStatus("done");
      setLastBackendEventAt(Date.now());
      const requestId = normalized[0]?.pipeline?.trace?.request_id;
      const runId = requestId || `run-${Date.now()}`;
      setActiveRunId(runId);
      setRunHistory((current) => [
        {
          id: runId,
          createdAt: new Date().toISOString(),
          query: values.query,
          results: nextResults,
          progressEvents: collectedEvents,
          debugOpen: false
        },
        ...current.filter((run) => run.id !== runId)
      ].slice(0, MAX_RUN_HISTORY));
      if (requestId) {
        fetchSearchDebug(requestId)
          .then((record) => {
            setDebugRecord(record);
            const nextDebugOpen = record.response?.gap_analysis?.status !== "no_retry";
            setDebugOpen(nextDebugOpen);
            setRunHistory((current) =>
              current.map((run) =>
                run.id === runId
                  ? {
                      ...run,
                      debugRecord: record,
                      debugOpen: nextDebugOpen
                    }
                  : run
              )
            );
          })
          .catch(() => undefined);
      }
    } catch (caught) {
      if (abortController.signal.aborted) {
        setError("Search canceled.");
        setBackendStatus("broken");
        setResults(ensureSideBySide([], values.query));
        return;
      }
      const message = caught instanceof Error ? caught.message : "Search backend unavailable.";
      setError(`Search failed: ${message}`);
      setBackendStatus("broken");
      setResults(ensureSideBySide([], values.query));
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    setIsLoading(false);
    setError("Search canceled.");
    setBackendStatus("broken");
  }

  async function handleProviderOpponent(provider: ProviderOpponent) {
    const query = currentQuery || results[0]?.pipeline?.query || "";
    if (!query.trim() || opponentLoading) return;
    setSelectedOpponent(provider);
    setOpponentLoading(provider);
    setOpponentError(undefined);
    try {
      const payload = await providerOpponentSearch({ provider, query });
      const [opponent] = normalizeComparePayload(payload, query);
      const sideBySide = ensureSideBySide(results, query);
      const nextResults: CompareResult[] = [sideBySide[0], opponent];
      setResults(nextResults);
      if (activeRunId) {
        setRunHistory((history) =>
          history.map((run) =>
            run.id === activeRunId
              ? {
                  ...run,
                  results: nextResults,
                  selectedOpponent: provider,
                  opponentError: undefined
                }
              : run
          )
        );
      }
    } catch (caught) {
      const nextError = caught instanceof Error ? caught.message : "Provider opponent unavailable.";
      setOpponentError(nextError);
      if (activeRunId) {
        setRunHistory((history) =>
          history.map((run) =>
            run.id === activeRunId
              ? {
                  ...run,
                  selectedOpponent: provider,
                  opponentError: nextError
                }
              : run
          )
        );
      }
    } finally {
      setOpponentLoading(undefined);
    }
  }

  function handleSelectPreviousRun(runId: string) {
    const run = runHistory.find((item) => item.id === runId);
    if (!run || isLoading) {
      return;
    }

    restorePreviousRunState(run);
    setError(undefined);
  }

  function restorePreviousRunState(run: PreviousRunEntry | undefined) {
    if (!run) {
      return;
    }

    setActiveRunId(run.id);
    setResults(run.results);
    setProgressEvents(run.progressEvents);
    setProgressOpen(Boolean(run.progressEvents.length));
    setDebugRecord(run.debugRecord);
    setDebugOpen(run.debugOpen);
    setCurrentQuery(run.query);
    setSelectedOpponent(run.selectedOpponent);
    setOpponentError(run.opponentError);
    setBackendStatus("done");
    setComparePaneView("run_metrics");
  }

  async function handleFeedbackSubmit(
    result: CompareResult,
    rating: RunFeedbackRating,
    note?: string
  ): Promise<SearchRunFeedback> {
    const requestId = result.pipeline?.trace?.request_id;
    if (!requestId) {
      throw new Error("This result is not attached to a persisted search run.");
    }

    const feedback = await submitRunFeedback(requestId, { rating, note });
    setResults((current) => applyFeedbackToResults(current, requestId, feedback));
    setDebugRecord((current) => applyFeedbackToDebugRecord(current, requestId, feedback));
    setRunHistory((history) =>
      history.map((run) =>
        run.id === requestId || run.results.some((item) => resultRequestId(item) === requestId)
          ? {
              ...run,
              results: applyFeedbackToResults(run.results, requestId, feedback),
              debugRecord: applyFeedbackToDebugRecord(run.debugRecord, requestId, feedback)
            }
          : run
      )
    );
    return feedback;
  }

  return (
    <main className="page-shell">
      <header className="page-header">
        <div className="title-row">
          <div>
            <h1>Research-grade agent tool</h1>
          </div>
          <div className="header-api-stack" aria-label="API endpoints">
            <span className="header-api-text">API {apiBaseUrl}</span>
            <span className="header-api-text">{apiBaseUrl}/search/stream</span>
          </div>
        </div>

        <SearchBox
          isLoading={isLoading}
          costSummary={agentCostSummary}
          previousRuns={previousRunItems}
          activeRunId={activeRunId}
          onSearch={handleSearch}
          onCancel={handleCancel}
          onSelectPreviousRun={handleSelectPreviousRun}
        />
        <ProgressPanel
          events={progressEvents}
          isOpen={progressOpen}
          statusMessage={error || statusMessage}
          statusTone={error ? "error" : "status"}
          isProgressActive={isLoading && (backendStatus === "live" || backendStatus === "stalled")}
          trace={debugRecord?.response?.trace ?? results[0]?.pipeline?.trace}
          onToggle={() => setProgressOpen((current) => !current)}
        />
        <RunDebugPanel
          record={debugRecord}
          isOpen={debugOpen}
          onToggle={() => setDebugOpen((current) => !current)}
        />
      </header>

      <section className="columns-grid" aria-label="Engine comparison results">
        <article className="result-column compare-answer-card">
          <ResultColumnHeader
            result={agentResult}
            title="Synthesized answer from pipeline"
            onFeedbackSubmit={handleFeedbackSubmit}
          />
          <ResultAnswerSection result={agentResult} />
        </article>

        <div className="compare-side-panel">
          <ComparePaneTabs selected={comparePaneView} onSelect={setComparePaneView} />
          {comparePaneView === "run_metrics" ? (
            <article className="result-column">
              <ResultColumnHeader
                result={agentResult}
                title="Last Run Metrics"
                showBadges={false}
              />
              <ResultDiagnosticsSections result={agentResult} />
            </article>
          ) : (
            <ResultColumn
              result={opponentResult}
              onFeedbackSubmit={handleFeedbackSubmit}
              titleAddon={
                <ProviderOpponentControls
                  selected={selectedOpponent}
                  loading={opponentLoading}
                  disabled={!currentQuery.trim() || isLoading}
                  error={opponentError}
                  onSelect={handleProviderOpponent}
                />
              }
            />
          )}
        </div>
      </section>
    </main>
  );
}

function toStoredPreviousRunEntry(run: PreviousRunEntry): PreviousRunEntry {
  return {
    id: run.id,
    createdAt: run.createdAt,
    query: run.query,
    results: run.results,
    progressEvents: [],
    debugOpen: false,
    selectedOpponent: run.selectedOpponent,
    opponentError: run.opponentError
  };
}

function runEntryFromDebugRecord(record: SearchDebugRecord): PreviousRunEntry | undefined {
  const response = record.response;
  if (!response) {
    return undefined;
  }

  const query = record.request.query;
  const pipeline = {
    query,
    intent: response.intent ?? {},
    sub_queries_executed: response.sub_queries_executed ?? [],
    chunks: response.selected_chunks ?? [],
    trace: response.trace,
    evidence_health: response.evidence_health ?? response.trace?.evidence_health,
    synthesized_answer: response.synthesized_answer,
    synthesis_review: response.synthesis_review,
    adjudication: response.adjudication
  } as ApiPipelineResponse;
  const tokenCount = response.ui_metrics?.token_count ?? response.trace?.selection?.estimated_tokens_used ?? 0;
  const timeToResultMs = response.ui_metrics?.time_to_result_ms ?? 0;
  const agentResult: CompareResult = {
    id: `agent-search-${response.request_id}`,
    engine_name: "Agent Search",
    question_id: "ad-hoc",
    final_answer: response.synthesized_answer ?? "",
    sources_cited: response.selected_sources ?? [],
    token_count: tokenCount,
    time_to_result_ms: timeToResultMs,
    mode: "live",
    pipeline,
    notes: response.warnings,
    feedback: record.feedback
  };

  return {
    id: response.request_id,
    createdAt: record.written_at,
    query,
    results: ensureSideBySide([agentResult], query),
    progressEvents: record.events ?? [],
    debugRecord: record,
    debugOpen: false
  };
}

function applyFeedbackToResults(
  results: CompareResult[],
  requestId: string,
  feedback: SearchRunFeedback
): CompareResult[] {
  return results.map((result) =>
    resultRequestId(result) === requestId
      ? {
          ...result,
          feedback
        }
      : result
  );
}

function applyFeedbackToDebugRecord(
  record: SearchDebugRecord | undefined,
  requestId: string,
  feedback: SearchRunFeedback
): SearchDebugRecord | undefined {
  if (record?.response?.request_id !== requestId) {
    return record;
  }
  return {
    ...record,
    feedback
  };
}

function resultRequestId(result: CompareResult): string | undefined {
  return result.pipeline?.trace?.request_id;
}

function mergeRunHistory(runs: PreviousRunEntry[]): PreviousRunEntry[] {
  const byId = new Map<string, PreviousRunEntry>();
  for (const run of runs) {
    const existing = byId.get(run.id);
    byId.set(run.id, {
      ...run,
      debugRecord: run.debugRecord ?? existing?.debugRecord,
      debugOpen: run.debugOpen || existing?.debugOpen || false
    });
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_RUN_HISTORY);
}

function isStoredPreviousRunEntry(value: unknown): value is PreviousRunEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.query === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.results) &&
    Array.isArray(value.progressEvents)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const COMPARE_PANE_TABS: Array<{ id: ComparePaneView; label: string }> = [
  { id: "run_metrics", label: "Run metrics" },
  { id: "opponent", label: "Opponent" }
];

function ComparePaneTabs({
  selected,
  onSelect
}: {
  selected: ComparePaneView;
  onSelect: (view: ComparePaneView) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Record<ComparePaneView, HTMLButtonElement | null>>({
    run_metrics: null,
    opponent: null
  });
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useEffect(() => {
    function updateIndicator() {
      const container = containerRef.current;
      const button = buttonRefs.current[selected];
      if (!container || !button) return;
      const containerRect = container.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      setIndicator({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width
      });
    }

    updateIndicator();
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [selected]);

  return (
    <div className="compare-view-tabs" role="tablist" aria-label="Right pane view" ref={containerRef}>
      {COMPARE_PANE_TABS.map((tab) => (
        <button
          className={`compare-view-tab ${selected === tab.id ? "active" : ""}`}
          type="button"
          role="tab"
          key={tab.id}
          aria-selected={selected === tab.id}
          aria-pressed={selected === tab.id}
          ref={(node) => {
            buttonRefs.current[tab.id] = node;
          }}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
      <span
        className="compare-view-tab-underline"
        aria-hidden="true"
        style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
      />
    </div>
  );
}

function ProviderOpponentControls({
  selected,
  loading,
  disabled,
  error,
  onSelect
}: {
  selected?: ProviderOpponent;
  loading?: ProviderOpponent;
  disabled: boolean;
  error?: string;
  onSelect: (provider: ProviderOpponent) => void;
}) {
  const providers: Array<{ id: ProviderOpponent; label: string }> = [
    { id: "openai", label: "OpenAI" },
    { id: "claude", label: "Claude" },
    { id: "gemini", label: "Gemini" }
  ];

  return (
    <div className="provider-button-row" role="group" aria-label="Provider web-search opponents">
        {providers.map((provider) => (
          <button
            className={[
              "provider-button",
              selected === provider.id ? "active" : "",
              loading === provider.id ? "loading" : ""
            ].filter(Boolean).join(" ")}
            type="button"
            key={provider.id}
            disabled={disabled || Boolean(loading)}
            aria-label={`${loading === provider.id ? "Running " : ""}${provider.label} web search`}
            title={provider.label}
            onClick={() => onSelect(provider.id)}
          >
            <span className={`provider-icon ${provider.id}`} aria-hidden="true" />
          </button>
        ))}
        {error ? <span className="provider-error-dot" title={error} aria-label={error} /> : null}
    </div>
  );
}

function ProgressPanel({
  events,
  isOpen,
  statusMessage,
  statusTone,
  isProgressActive,
  trace,
  onToggle
}: {
  events: PipelineProgressEvent[];
  isOpen: boolean;
  statusMessage?: string;
  statusTone: "error" | "status";
  isProgressActive: boolean;
  trace?: Trace;
  onToggle: () => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [selectedRowId, setSelectedRowId] = useState<string>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => buildTimelineRows(events), [events]);
  const selectedRow = rows.find((row) => row.id === selectedRowId);
  const totalHeight = rows.length * TIMELINE_ROW_HEIGHT;
  const maxScrollTop = Math.max(0, totalHeight - TIMELINE_VIEWPORT_HEIGHT);
  const effectiveScrollTop = Math.min(scrollTop, maxScrollTop);
  const startIndex = Math.max(0, Math.floor(effectiveScrollTop / TIMELINE_ROW_HEIGHT) - TIMELINE_OVERSCAN);
  const visibleCount = Math.ceil(TIMELINE_VIEWPORT_HEIGHT / TIMELINE_ROW_HEIGHT) + TIMELINE_OVERSCAN * 2;
  const visibleRows = rows.slice(startIndex, startIndex + visibleCount);

  useEffect(() => {
    if (scrollTop <= maxScrollTop) return;
    setScrollTop(maxScrollTop);
    if (listRef.current) {
      listRef.current.scrollTop = maxScrollTop;
    }
  }, [maxScrollTop, scrollTop]);

  useEffect(() => {
    if (events.length > 0) return;
    setScrollTop(0);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [events.length]);

  if (!events.length && !statusMessage) {
    return null;
  }

  return (
    <section className="progress-panel">
      {events.length ? (
        <button className="progress-toggle" type="button" onClick={onToggle}>
          {isOpen ? "Hide progress" : "Show progress"} - {events.length} events
        </button>
      ) : null}
      {isOpen && events.length ? (
        <div
          ref={listRef}
          className="progress-list progress-timeline"
          role="list"
          style={{ height: TIMELINE_VIEWPORT_HEIGHT }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="progress-timeline-inner" style={{ height: totalHeight }}>
            {visibleRows.map((row) => (
              <button
                className={`progress-row progress-row-button ${row.severity === "error" ? "progress-row-error" : ""}`}
                key={row.id}
                style={{ transform: `translateY(${row.index * TIMELINE_ROW_HEIGHT}px)`, height: TIMELINE_ROW_HEIGHT }}
                type="button"
                onClick={() => setSelectedRowId(row.id)}
              >
                <span className="tag">{row.event.type}</span>
                <p>{row.message}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {isOpen && selectedRow ? (
        <EventDetailPanel row={selectedRow} trace={trace} onClose={() => setSelectedRowId(undefined)} />
      ) : null}
      {isOpen && statusMessage ? (
        <p className={statusTone === "error" ? "progress-status-line error-text" : "progress-status-line status-text"} aria-live="polite">
          <span
            className={statusTone === "status" && isProgressActive ? "progress-status-shimmer" : undefined}
            data-shimmer-text={statusMessage}
          >
            {statusMessage}
          </span>
        </p>
      ) : null}
    </section>
  );
}

type TimelineRow = {
  id: string;
  index: number;
  event: PipelineProgressEvent;
  message: string;
  elapsedMs: number;
  deltaMs: number;
  durationMs?: number;
  severity: "error" | "normal";
};

function buildTimelineRows(events: PipelineProgressEvent[]): TimelineRow[] {
  const runStartedAt = parseEventTime(events[0]?.at);
  let previousAt = runStartedAt;
  return events.map((event, index) => {
    const at = parseEventTime(event.at);
    const elapsedMs = runStartedAt !== undefined && at !== undefined ? Math.max(0, at - runStartedAt) : 0;
    const deltaMs = previousAt !== undefined && at !== undefined ? Math.max(0, at - previousAt) : 0;
    previousAt = at ?? previousAt;
    return {
      id: `${index}-${event.at}-${event.type}`,
      index,
      event,
      message: progressEventMessage(event),
      elapsedMs,
      deltaMs,
      durationMs: eventDurationMs(event),
      severity: event.type === "fatal" || event.type === "stage_error" || (event.type === "source_complete" && !event.ok) ? "error" : "normal"
    };
  });
}

function EventDetailPanel({ row, trace, onClose }: { row: TimelineRow; trace?: Trace; onClose: () => void }) {
  const related = relatedTraceDetails(row, trace);
  const details = "details" in row.event ? row.event.details : undefined;
  const counts = "counts" in row.event ? row.event.counts : undefined;
  const error = "error" in row.event ? row.event.error : undefined;
  return (
    <div className="event-detail-panel" role="dialog" aria-label="Event details">
      <div className="event-detail-header">
        <div>
          <span className="tag">{row.event.type}</span>
          {eventStage(row.event) ? <span className="event-detail-stage">{eventStage(row.event)}</span> : null}
        </div>
        <button className="event-detail-close" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="event-detail-grid">
        <div>
          <dt>Timestamp</dt>
          <dd>{row.event.at}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatMs(row.elapsedMs)}</dd>
        </div>
        <div>
          <dt>Delta</dt>
          <dd>{formatMs(row.deltaMs)}</dd>
        </div>
        {row.durationMs !== undefined ? (
          <div>
            <dt>Duration</dt>
            <dd>{formatMs(row.durationMs)}</dd>
          </div>
        ) : null}
        {"source" in row.event ? (
          <div>
            <dt>Source</dt>
            <dd>{row.event.source}</dd>
          </div>
        ) : null}
        {related.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="event-detail-message">{row.message}</p>
      {details ? (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(details, null, 2)}</pre>
        </details>
      ) : null}
      {counts ? (
        <details>
          <summary>Counts</summary>
          <pre>{JSON.stringify(counts, null, 2)}</pre>
        </details>
      ) : null}
      {error ? (
        <details>
          <summary>Error</summary>
          <pre>{JSON.stringify(error, null, 2)}</pre>
        </details>
      ) : null}
      <details>
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(row.event, null, 2)}</pre>
      </details>
    </div>
  );
}

function latestProgressMessage(events: PipelineProgressEvent[]): string | undefined {
  const latest = events[events.length - 1];
  return latest ? progressEventMessage(latest) : undefined;
}

function progressEventMessage(event: PipelineProgressEvent): string {
  if (event.type === "stage_start" || event.type === "stage_complete" || event.type === "stage_error" || event.type === "stage_progress") {
    return event.message;
  }
  if (event.type === "source_start") {
    return `${event.source}: querying ${event.sub_query}`;
  }
  if (event.type === "source_complete") {
    return `${event.source}: ${event.ok ? `${event.item_count} item(s)` : event.error?.message ?? "failed"}`;
  }
  if (event.type === "counts") {
    return `Counts updated: ${Object.entries(event.counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")}`;
  }
  if (event.type === "retrieval_round") {
    return event.message;
  }
  if (event.type === "gap_analysis") {
    return event.message;
  }
  if (event.type === "final") {
    return "Search complete.";
  }
  return event.error;
}

function parseEventTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eventDurationMs(event: PipelineProgressEvent): number | undefined {
  if (event.type === "stage_complete" && typeof event.timing_ms === "number") return event.timing_ms;
  if (event.type === "source_complete" && typeof event.timing_ms === "number") return event.timing_ms;
  return undefined;
}

function formatMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0 ms";
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}s`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${Math.round(value)} ms`;
}

function relatedTraceDetails(row: TimelineRow, trace?: Trace): Array<[string, string]> {
  if (!trace) return [];
  const entries: Array<[string, string]> = [];
  const stage = eventStage(row.event);
  if (stage) {
    const timing = trace.stage_timings_ms?.[`${stage}_ms`] ?? trace.stage_timings_ms?.[stage];
    if (typeof timing === "number") entries.push(["Trace timing", formatMs(timing)]);
    const calls = trace.structured_llm_calls?.filter((call) => call.stage === stage || call.task.includes(stage)) ?? [];
    if (calls.length) {
      entries.push(["LLM calls", String(calls.length)]);
      entries.push(["Reasoning", calls.some((call) => call.reasoning_enabled) ? "on" : "off"]);
    }
    const batches = trace.scoring_batches?.filter((batch) => batch.stage_label === stage) ?? [];
    if (batches.length) {
      const cacheHits = batches.reduce((sum, batch) => sum + (batch.cache_hit_count ?? 0), 0);
      entries.push(["Scoring batches", String(batches.length)]);
      entries.push(["Cache hits", String(cacheHits)]);
    }
  }
  if (row.event.type === "source_complete") {
    const sourceResult = trace.source_results?.[row.event.source];
    if (sourceResult) {
      entries.push(["Source total", `${sourceResult.ok}/${sourceResult.queried} ok`]);
      entries.push(["Source aggregate time", formatMs(sourceResult.timing_ms)]);
    }
  }
  return entries;
}

function eventStage(event: PipelineProgressEvent): string | undefined {
  return "stage" in event && typeof event.stage === "string" ? event.stage : undefined;
}

function RunDebugPanel({
  record,
  isOpen,
  onToggle
}: {
  record: SearchDebugRecord | undefined;
  isOpen: boolean;
  onToggle: () => void;
}) {
  if (!record?.response) {
    return null;
  }

  const rounds = record.response.retrieval_rounds ?? [];
  const gap = record.response.gap_analysis;
  const review = record.response.synthesis_review;
  const summary = record.response.trace_summary;

  return (
    <section className="progress-panel">
      <button className="progress-toggle" type="button" onClick={onToggle}>
        {isOpen ? "Hide debug" : "Show debug"} - {rounds.length} round(s), {record.events.length} events
      </button>
      {isOpen ? (
        <div className="trace-grid debug-grid">
          <div className="trace-block">
            <h3>Gap analysis</h3>
            {gap ? (
              <ul className="trace-list">
                <li className="trace-row">
                  <span className="tag">{gap.status}</span>
                  <p className="trace-value">{gap.reasons.slice(0, 4).join(" ") || "No critical gaps detected."}</p>
                </li>
                {gap.missing_facets.slice(0, 6).map((facet, index) => (
                  <li className="trace-row" key={`facet-${index}-${facet}`}>
                    <span className="tag">facet</span>
                    <p className="trace-value">{facet}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-text">No gap analysis returned.</p>
            )}
          </div>

          <div className="trace-block">
            <h3>Retrieval rounds</h3>
            {rounds.length ? (
              <table className="compact-table">
                <tbody>
                  {rounds.map((round) => (
                    <tr key={round.round_index}>
                      <th>Round {round.round_index}</th>
                      <td>
                        {round.reason}
                        <br />
                        {round.raw_item_count} raw, {round.selected_chunk_count} selected,{" "}
                        {round.evidence_health?.status ?? "no health"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty-text">No round records returned.</p>
            )}
          </div>

          <div className="trace-block">
            <h3>Trace summary</h3>
            {summary ? (
              <table className="compact-table">
                <tbody>
                  <tr>
                    <th>Sources</th>
                    <td>{summary.sources_queried.join(", ") || "none"}</td>
                  </tr>
                  <tr>
                    <th>Failures</th>
                    <td>{summary.source_failures.length}</td>
                  </tr>
                  <tr>
                    <th>Counts</th>
                    <td>
                      {summary.raw_item_count} raw, {summary.normalized_chunk_count} normalized,{" "}
                      {summary.scored_chunk_count} scored, {summary.deduped_chunk_count} deduped,{" "}
                      {summary.selected_chunk_count} selected
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : null}
          </div>

          <div className="trace-block">
            <h3>Synthesis review</h3>
            {review ? (
              <ul className="trace-list">
                <li className="trace-row">
                  <span className="tag">{review.coverage_status}</span>
                  <p className="trace-value">
                    {[...review.remaining_gaps, ...review.keyword_context_warnings].slice(0, 4).join(" ") ||
                      "No reviewer gaps reported."}
                  </p>
                </li>
              </ul>
            ) : (
              <p className="empty-text">Reviewer did not run.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
