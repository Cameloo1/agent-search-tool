"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { BackendStatusState, CostSummary, QualityMode, SearchFormValues } from "../lib/types";

export type PreviousRunNavItem = {
  id: string;
  query: string;
};

type SearchBoxProps = {
  isLoading: boolean;
  costSummary?: CostSummary;
  previousRuns?: PreviousRunNavItem[];
  activeRunId?: string;
  onSearch: (values: SearchFormValues) => Promise<void>;
  onCancel?: () => void;
  onSelectPreviousRun?: (runId: string) => void;
};

export function SearchBox({
  isLoading,
  costSummary,
  previousRuns = [],
  activeRunId,
  onSearch,
  onCancel,
  onSelectPreviousRun
}: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [tokenBudget, setTokenBudget] = useState(4000);
  const [qualityMode, setQualityMode] = useState<QualityMode>("fast");
  const [synthesizeAnswer, setSynthesizeAnswer] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  useEffect(() => {
    const savedMode = window.localStorage.getItem("agent-search-quality-mode");
    if (savedMode === "fast" || savedMode === "balanced" || savedMode === "quality") {
      setQualityMode(savedMode);
      setSynthesizeAnswer(savedMode !== "fast");
    }
  }, []);

  function chooseQualityMode(nextMode: QualityMode) {
    setQualityMode(nextMode);
    setSynthesizeAnswer(nextMode !== "fast");
    window.localStorage.setItem("agent-search-quality-mode", nextMode);
    setModeMenuOpen(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery || isLoading) {
      return;
    }

    await onSearch({
      query: trimmedQuery,
      tokenBudget,
      qualityMode,
      synthesizeAnswer
    });
  }

  const matchingPreviousRuns = previousRuns.filter((run) =>
    run.query.toLowerCase().includes(historyQuery.trim().toLowerCase())
  );
  const activeMatchingIndex = matchingPreviousRuns.findIndex((run) => run.id === activeRunId);
  const historyNavigation = getHistoryNavigationState({
    matchingRunCount: matchingPreviousRuns.length,
    activeMatchingIndex,
    isLoading,
    hasSelectHandler: Boolean(onSelectPreviousRun)
  });
  const canSelectNewerRun = historyNavigation.canSelectNewerRun;
  const canSelectOlderRun = historyNavigation.canSelectOlderRun;

  function canSelectHistoryOffset(offset: -1 | 1) {
    return offset < 0 ? canSelectNewerRun : canSelectOlderRun;
  }

  function selectHistoryOffset(offset: -1 | 1) {
    if (!canSelectHistoryOffset(offset) || !onSelectPreviousRun) {
      return;
    }

    const nextIndex = resolveHistoryOffsetIndex({
      matchingRunCount: matchingPreviousRuns.length,
      activeMatchingIndex,
      offset
    });
    if (nextIndex === undefined) {
      return;
    }

    onSelectPreviousRun(matchingPreviousRuns[nextIndex].id);
  }

  return (
    <section className="search-panel" aria-label="Run your own query">
      <form className="search-form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="query">Query</label>
          <input
            id="query"
            className="text-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask a benchmark-style research question"
            autoComplete="off"
          />
        </div>

        <div className="button-row">
          <button
            className="primary-button"
            type="submit"
            disabled={!query.trim() || isLoading}
            aria-label={isLoading ? "Running search" : "Run search"}
            title={isLoading ? "Running search" : "Run search"}
          >
            <svg className="run-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
            </svg>
          </button>
          {isLoading && onCancel ? (
            <button className="secondary-button" type="button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>

        <div className="field budget-field">
          <label htmlFor="token-budget">Budget</label>
          <input
            id="token-budget"
            className="number-input"
            type="number"
            min={500}
            max={12000}
            step={250}
            value={tokenBudget}
            onChange={(event) => setTokenBudget(Number(event.target.value))}
          />
          <span className="budget-tooltip" role="tooltip">
            Maximum token budget for evidence selection and synthesis.
          </span>
        </div>

        <div className="field mode-field">
          <span className="field-label">Mode</span>
          <div
            className="mode-dropdown"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setModeMenuOpen(false);
              }
            }}
          >
            <button
              className="mode-dropdown-trigger"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={modeMenuOpen}
              onClick={() => setModeMenuOpen((current) => !current)}
            >
              <span>{qualityModeLabel(qualityMode)}</span>
              <span className="mode-dropdown-chevron" aria-hidden="true" />
            </button>
            {modeMenuOpen ? (
              <div className="mode-dropdown-menu" role="listbox" aria-label="Quality mode">
                {QUALITY_MODE_OPTIONS.map((option) => (
                  <button
                    className={option.value === qualityMode ? "mode-dropdown-option active" : "mode-dropdown-option"}
                    type="button"
                    role="option"
                    aria-selected={option.value === qualityMode}
                    key={option.value}
                    onClick={() => chooseQualityMode(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={synthesizeAnswer}
            onChange={(event) => setSynthesizeAnswer(event.target.checked)}
          />
          <span>Synthesize</span>
        </label>

        <div className="helper-actions">
          <CostSummaryPill summary={costSummary} />
          <div className="previous-runs-control" aria-label="Previous runs">
            <input
              className="history-input"
              type="search"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder={previousRuns.length ? "Previous runs" : "No previous runs"}
              disabled={!previousRuns.length}
            />
            <button
              className="history-arrow"
              type="button"
              aria-label="Previous run"
              disabled={!canSelectNewerRun}
              onClick={() => selectHistoryOffset(-1)}
            >
              {"<"}
            </button>
            <button
              className="history-arrow"
              type="button"
              aria-label="Next run"
              disabled={!canSelectOlderRun}
              onClick={() => selectHistoryOffset(1)}
            >
              {">"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

const QUALITY_MODE_OPTIONS: Array<{ value: QualityMode; label: string }> = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "quality", label: "Quality" }
];

function qualityModeLabel(mode: QualityMode) {
  return QUALITY_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "Fast";
}

export function getHistoryNavigationState({
  matchingRunCount,
  activeMatchingIndex,
  isLoading,
  hasSelectHandler
}: {
  matchingRunCount: number;
  activeMatchingIndex: number;
  isLoading: boolean;
  hasSelectHandler: boolean;
}) {
  const hasSelectableRuns = matchingRunCount > 0 && hasSelectHandler && !isLoading;
  return {
    canSelectNewerRun: hasSelectableRuns && (activeMatchingIndex < 0 || activeMatchingIndex > 0),
    canSelectOlderRun: hasSelectableRuns && (activeMatchingIndex < 0 || activeMatchingIndex < matchingRunCount - 1)
  };
}

export function resolveHistoryOffsetIndex({
  matchingRunCount,
  activeMatchingIndex,
  offset
}: {
  matchingRunCount: number;
  activeMatchingIndex: number;
  offset: -1 | 1;
}) {
  if (matchingRunCount <= 0) {
    return undefined;
  }

  const baseIndex = activeMatchingIndex >= 0 ? activeMatchingIndex : offset > 0 ? -1 : matchingRunCount;
  return clampIndex(baseIndex + offset, matchingRunCount);
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index));
}

export function BackendStatusSpiral({ status }: { status: BackendStatusState }) {
  if (status === "idle") {
    return null;
  }

  return (
    <span className={`backend-spiral ${status}`} aria-hidden="true">
      <svg className="backend-spiral-svg" viewBox="0 0 24 24" focusable="false">
        <g className="spiral-track" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 12 C14.8 6.9 20.1 7.4 20.8 11.1" />
          <path
            d="M12 12 C14.8 6.9 20.1 7.4 20.8 11.1"
            transform="rotate(120 12 12)"
          />
          <path
            d="M12 12 C14.8 6.9 20.1 7.4 20.8 11.1"
            transform="rotate(240 12 12)"
          />
        </g>
        <g className="spiral-highlight" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 12 C14.8 6.9 20.1 7.4 20.8 11.1" />
          <circle className="spiral-roller" cx="20.8" cy="11.1" r="1.75" />
        </g>
      </svg>
    </span>
  );
}

function CostSummaryPill({ summary }: { summary?: CostSummary }) {
  if (!summary) {
    return null;
  }

  const unavailable = summary.pricing_source === "unavailable" && summary.total_cost_usd === 0;
  const label = unavailable
    ? "Cost unavailable"
    : `Cost ${summary.estimated ? "~" : ""}${formatUsd(summary.total_cost_usd)}`;

  return (
    <details className="cost-popover">
      <summary className={unavailable ? "cost-pill unavailable" : "cost-pill"}>
        <span>{label}</span>
      </summary>
      <div className="cost-menu" role="tooltip">
        <div className="cost-menu-header">
          <strong>{unavailable ? "Cost unavailable" : `${summary.estimated ? "Estimated " : ""}${formatUsd(summary.total_cost_usd)}`}</strong>
          <span>{summary.total_tokens.toLocaleString()} tokens</span>
        </div>

        <div className="cost-token-grid">
          <Metric label="Prompt" value={summary.total_prompt_tokens.toLocaleString()} />
          <Metric label="Completion" value={summary.total_completion_tokens.toLocaleString()} />
          <Metric label="Reasoning" value={summary.total_reasoning_tokens.toLocaleString()} />
          <Metric label="Cached" value={summary.total_cached_tokens.toLocaleString()} />
        </div>

        <CostGroupTable title="By stage" groups={summary.by_stage} />
        <CostGroupTable title="By model" groups={summary.by_model} />

        <div className="cost-lines">
          <h3>Calls</h3>
          {summary.line_items.map((item) => (
            <div className="cost-line" key={item.id}>
              <div>
                <strong>{item.stage}</strong>
                <span>{item.model}</span>
              </div>
              <div>
                <span>{item.usage.total_tokens.toLocaleString()} tok</span>
                <strong>{item.total_cost_usd === null ? "unavailable" : `${item.estimated ? "~" : ""}${formatUsd(item.total_cost_usd)}`}</strong>
              </div>
            </div>
          ))}
        </div>

        {summary.warnings.length ? (
          <ul className="cost-warnings">
            {summary.warnings.slice(0, 5).map((warning, index) => (
              <li key={`cost-warning-${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CostGroupTable({ title, groups }: { title: string; groups: CostSummary["by_stage"] }) {
  const rows = Object.entries(groups).sort(([, a], [, b]) => b.total_cost_usd - a.total_cost_usd);
  if (!rows.length) return null;

  return (
    <div className="cost-group">
      <h3>{title}</h3>
      <table>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <th>{key}</th>
              <td>{value.total_tokens.toLocaleString()} tok</td>
              <td>{value.estimated ? "~" : ""}{formatUsd(value.total_cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "$0.0000";
  if (value === 0) return "$0.0000";
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
