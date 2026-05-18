"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { CompareResult, RunFeedbackRating, SearchRunFeedback } from "../lib/types";
import { ScoreBadge } from "./ScoreBadge";
import { SourceList } from "./SourceList";
import { TraceSummary } from "./TraceSummary";

type ResultColumnProps = {
  result: CompareResult;
  title?: string;
  titleAddon?: ReactNode;
  showBadges?: boolean;
  onFeedbackSubmit?: (
    result: CompareResult,
    rating: RunFeedbackRating,
    note?: string
  ) => Promise<SearchRunFeedback>;
};

const FEEDBACK_OPTIONS: Array<{ rating: RunFeedbackRating; label: string }> = [
  { rating: "up", label: "Thumbs up" },
  { rating: "neutral", label: "Neutral" },
  { rating: "down", label: "Thumbs down" }
];

export function ResultColumn({ result, titleAddon, onFeedbackSubmit }: ResultColumnProps) {
  return (
    <article className="result-column">
      <ResultColumnHeader result={result} titleAddon={titleAddon} onFeedbackSubmit={onFeedbackSubmit} />
      <ResultMetricsSection result={result} />
      <ResultAnswerSection result={result} />
      <ResultSourcesSection result={result} />
      <ResultFlagsSection result={result} />
      <ResultTraceSection result={result} />
    </article>
  );
}

export function ResultColumnHeader({ result, title, titleAddon, showBadges = true, onFeedbackSubmit }: ResultColumnProps) {
  const evaluation = result.evaluation;
  const requestId = result.pipeline?.trace?.request_id;
  const canReview = Boolean(requestId && onFeedbackSubmit);
  const evidenceHealth = result.pipeline?.evidence_health ?? result.pipeline?.trace?.evidence_health;
  const hasGoldMetrics = Boolean(evaluation && (evaluation.score_status === "scored" || evaluation.facts_total > 0));

  return (
    <header className="column-header">
      <div className="column-title">
        <div className="engine-title-row">
          <h2 className="engine-name">{title ?? result.engine_name}</h2>
          {titleAddon}
        </div>
        <p className="question-id">Question: {result.question_id || "ad-hoc"}</p>
      </div>
      <div className="column-header-actions">
        {showBadges ? (
          <div className="column-badges">
            <ScoreBadge status={evaluation?.score_status} evidenceChecked={Boolean(evidenceHealth && !hasGoldMetrics)} />
            <span className="mode-label">{result.mode}</span>
          </div>
        ) : null}
        {canReview && onFeedbackSubmit ? (
          <RunFeedbackControl
            feedback={result.feedback}
            onSubmit={(rating, note) => onFeedbackSubmit(result, rating, note)}
          />
        ) : null}
      </div>
    </header>
  );
}

export function ResultAnswerSection({ result }: { result: CompareResult }) {
  const chunks = result.pipeline?.chunks ?? [];

  return (
    <CollapsibleSection title={result.pipeline?.synthesized_answer ? "Synthesized from chunks" : "Final answer or selected chunks"} defaultOpen>
      {result.final_answer ? (
        <p className="answer-text">{result.final_answer}</p>
      ) : chunks.length ? (
        <ul className="chunk-list">
          {chunks.slice(0, 4).map((chunk) => (
            <li className="chunk-item" key={chunk.id}>
              <div className="chunk-meta">
                <span className="tag">{chunk.metadata.source_name}</span>
                <span className="tag">{chunk.metadata.source_type}</span>
                <span className="tag">{Math.round(chunk.metadata.confidence_score * 100)}% confidence</span>
              </div>
              <p className="chunk-content">{chunk.content}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-text">No synthesized answer or chunks yet.</p>
      )}
    </CollapsibleSection>
  );
}

export function ResultDiagnosticsSections({ result }: { result: CompareResult }) {
  return (
    <>
      <ResultMetricsSection result={result} />
      <ResultSourcesSection result={result} />
      <ResultFlagsSection result={result} />
      <ResultTraceSection result={result} />
    </>
  );
}

function ResultMetricsSection({ result }: { result: CompareResult }) {
  if (isLoadingResult(result)) {
    return (
      <section className="column-section">
        <div className="section-title">Metrics</div>
        <p className="empty-text">Loading run metrics...</p>
      </section>
    );
  }

  const evaluation = result.evaluation;
  const evidenceHealth = result.pipeline?.evidence_health ?? result.pipeline?.trace?.evidence_health;
  const hasGoldMetrics = Boolean(evaluation && (evaluation.score_status === "scored" || evaluation.facts_total > 0));
  const showEvidenceMetrics = Boolean(evidenceHealth && !hasGoldMetrics);
  const factsValue =
    evaluation && evaluation.facts_total > 0
      ? `${evaluation.facts_hit}/${evaluation.facts_total}`
      : "Unavailable";
  const requiredSources =
    evaluation && evaluation.required_source_types_total > 0
      ? `${evaluation.required_source_types_hit}/${evaluation.required_source_types_total} required types`
      : evaluation?.score_status === "scored"
        ? `${evaluation.primary_source_count} primary sources`
        : "Unavailable";
  const factsTone =
    evaluation && evaluation.facts_total > 0
      ? evaluation.facts_hit === evaluation.facts_total
        ? "good"
        : evaluation.facts_hit > 0
          ? "warn"
          : "danger"
      : "muted";
  const requiredSourcesTone =
    evaluation && evaluation.score_status === "scored"
      ? evaluation.required_source_types_total > 0 && evaluation.required_source_types_hit < evaluation.required_source_types_total
        ? "warn"
        : "good"
      : "muted";
  const evidenceTone = evidenceHealth?.status ?? "muted";

  return (
    <section className="column-section">
      <div className="section-title">Metrics</div>
      <div className={evidenceHealth ? "metrics-overview" : undefined}>
        <div className="metrics-grid">
          <Metric label="Token count" value={formatNumber(result.token_count)} tone={result.token_count > 0 ? "neutral" : "muted"} />
          <Metric label="Time" value={formatTime(result.time_to_result_ms)} tone={result.time_to_result_ms > 0 ? "neutral" : "muted"} />
          {showEvidenceMetrics ? (
            <>
              <Metric
                label="Evidence coverage"
                value={formatEvidenceScore(evidenceHealth?.evidence_coverage_score, evidenceHealth?.status)}
                title={evidenceTooltip(evidenceHealth)}
                tone={evidenceTone}
              />
              <Metric
                label="Evidence quality"
                value={formatEvidenceScore(evidenceHealth?.evidence_quality_score, evidenceHealth?.status)}
                title={evidenceTooltip(evidenceHealth)}
                tone={evidenceTone}
              />
            </>
          ) : (
            <>
              <Metric label="Facts hit" value={factsValue} tone={factsTone} />
              <Metric label="Required sources" value={requiredSources} tone={requiredSourcesTone} />
            </>
          )}
        </div>
        {evidenceHealth ? <EvidenceHealthSummary health={evidenceHealth} /> : null}
      </div>
    </section>
  );
}

function ResultSourcesSection({ result }: { result: CompareResult }) {
  if (isLoadingResult(result)) {
    return (
      <CollapsibleSection title="Sources and provenance" defaultOpen>
        <p className="empty-text">Loading sources...</p>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Sources and provenance" defaultOpen>
      <SourceList sources={result.sources_cited} />
    </CollapsibleSection>
  );
}

function ResultFlagsSection({ result }: { result: CompareResult }) {
  if (isLoadingResult(result)) {
    return (
      <CollapsibleSection title="Hallucination flags">
        <p className="empty-text">Loading review signals...</p>
      </CollapsibleSection>
    );
  }

  const evaluation = result.evaluation;
  const hallucinationFlags = evaluation?.hallucination_flags ?? [];
  const unsourcedClaims = evaluation?.unsourced_claims ?? [];
  const review = result.pipeline?.synthesis_review ?? result.pipeline?.trace?.synthesis_review;
  const issueFlags = [
    ...hallucinationFlags,
    ...unsourcedClaims.map((claim) => `Unsourced claim: ${claim}`),
    ...(evaluation?.score_status === "scored" ? [] : review?.unsupported_or_weak_claims ?? []),
    ...(evaluation?.score_status === "scored" ? [] : review?.keyword_context_warnings ?? [])
  ];

  return (
    <CollapsibleSection title="Hallucination flags">
      {evaluation?.score_status !== "scored" && !issueFlags.length ? (
        <p className="empty-text">Scoring unavailable, so hallucination flags are not evaluated.</p>
      ) : issueFlags.length ? (
        <ul className="flag-list">
          {issueFlags.map((flag, index) => (
            <li className="trace-row" key={`flag-${index}-${flag}`}>
              <p className="trace-value">{flag}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-text">None reported.</p>
      )}
    </CollapsibleSection>
  );
}

function ResultTraceSection({ result }: { result: CompareResult }) {
  if (isLoadingResult(result)) {
    return (
      <CollapsibleSection title="Trace summary">
        <p className="empty-text">Loading trace...</p>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Trace summary">
      <TraceSummary trace={result.pipeline?.trace} />
    </CollapsibleSection>
  );
}

function isLoadingResult(result: CompareResult) {
  return result.id.includes("-loading-");
}

function RunFeedbackControl({
  feedback,
  onSubmit
}: {
  feedback?: SearchRunFeedback;
  onSubmit: (rating: RunFeedbackRating, note?: string) => Promise<SearchRunFeedback>;
}) {
  const [savedFeedback, setSavedFeedback] = useState<SearchRunFeedback | undefined>(feedback);
  const [pendingRating, setPendingRating] = useState<RunFeedbackRating>(feedback?.rating ?? "neutral");
  const [note, setNote] = useState(feedback?.note ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSavedFeedback(feedback);
    if (!isOpen) {
      setPendingRating(feedback?.rating ?? "neutral");
      setNote(feedback?.note ?? "");
    }
  }, [feedback, isOpen]);

  function openFeedback(rating: RunFeedbackRating) {
    setPendingRating(rating);
    setNote(savedFeedback?.rating === rating ? savedFeedback.note ?? "" : "");
    setError(undefined);
    setIsOpen(true);
  }

  async function saveFeedback(includeNote: boolean) {
    setIsSaving(true);
    setError(undefined);
    try {
      const saved = await onSubmit(pendingRating, includeNote ? note : undefined);
      setSavedFeedback(saved);
      setPendingRating(saved.rating);
      setNote(saved.note ?? "");
      setIsOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Feedback could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="run-feedback">
      <div className="review-button-row" role="group" aria-label="Review this run">
        {FEEDBACK_OPTIONS.map((option) => (
          <button
            className={[
              "review-button",
              savedFeedback?.rating === option.rating ? "active" : "",
              isOpen && pendingRating === option.rating ? "pending" : ""
            ].filter(Boolean).join(" ")}
            type="button"
            key={option.rating}
            aria-label={option.label}
            aria-pressed={savedFeedback?.rating === option.rating}
            title={option.label}
            onClick={() => openFeedback(option.rating)}
          >
            {option.rating === "neutral" ? <NeutralIcon /> : <ThumbIcon down={option.rating === "down"} />}
          </button>
        ))}
      </div>

      {isOpen ? (
        <div className="review-popover" role="dialog" aria-label="Optional run feedback">
          <div className="review-popover-header">
            <span className="tag">{feedbackLabel(pendingRating)}</span>
            <button className="review-close" type="button" onClick={() => setIsOpen(false)}>
              Close
            </button>
          </div>
          <textarea
            className="review-textarea"
            value={note}
            maxLength={2000}
            placeholder="Optional note"
            disabled={isSaving}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="review-actions">
            <button className="review-action secondary" type="button" disabled={isSaving} onClick={() => saveFeedback(false)}>
              Skip
            </button>
            <button className="review-action primary" type="button" disabled={isSaving} onClick={() => saveFeedback(true)}>
              {isSaving ? "Saving" : "Save"}
            </button>
          </div>
          {error ? <p className="review-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg
      className={down ? "review-icon review-icon-down" : "review-icon"}
      viewBox="0 0 24 24"
      focusable="false"
      aria-hidden="true"
    >
      <path d="M7 10v10" />
      <path d="M7 11H4.7A1.7 1.7 0 0 0 3 12.7v5.6A1.7 1.7 0 0 0 4.7 20H7" />
      <path d="M7 11c1.9 0 2.7-1.1 3.5-2.7l1.7-3.4c.6-1.2 2.4-.8 2.4.6 0 .7-.2 1.6-.5 2.5l-.7 2h4.3c1.4 0 2.4 1.4 1.9 2.7l-1.6 4.8A3.6 3.6 0 0 1 14.6 20H7" />
    </svg>
  );
}

function NeutralIcon() {
  return (
    <svg className="review-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

function feedbackLabel(rating: RunFeedbackRating) {
  if (rating === "up") return "Thumbs up";
  if (rating === "down") return "Thumbs down";
  return "Neutral";
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="column-section collapsible-section" open={defaultOpen}>
      <summary className="section-title collapsible-title">
        <span>{title}</span>
        <span className="collapse-indicator" aria-hidden="true" />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

function Metric({
  label,
  value,
  title,
  tone = "neutral"
}: {
  label: string;
  value: string;
  title?: string;
  tone?: "neutral" | "muted" | "good" | "warn" | "danger" | "strong" | "adequate" | "weak" | "insufficient";
}) {
  return (
    <div className={`metric metric-${tone}`} title={title}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function EvidenceHealthSummary({ health }: { health: NonNullable<CompareResult["pipeline"]>["evidence_health"] }) {
  if (!health) return null;
  return (
    <div className="evidence-summary" title={evidenceTooltip(health)}>
      <span className={`evidence-status ${health.status}`}>{health.status}</span>
      <ul className="evidence-reasons">
        {health.reasons.slice(0, 3).map((reason, index) => (
          <li key={`reason-${index}-${reason}`}>{reason}</li>
        ))}
        {health.warnings.slice(0, 2).map((warning, index) => (
          <li key={`warning-${index}-${warning}`}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function formatEvidenceScore(value: number | undefined, status: string | undefined) {
  if (typeof value !== "number") {
    return "Unavailable";
  }

  return `${Math.round(value)}/100${status ? ` (${status})` : ""}`;
}

function evidenceTooltip(health: NonNullable<CompareResult["pipeline"]>["evidence_health"] | undefined) {
  if (!health) return undefined;
  const components = health.components;
  return [
    `Relevance/confidence: ${components.relevance_confidence}/100`,
    `Source authority: ${components.source_authority}/100`,
    `Coverage/diversity: ${components.coverage_diversity}/100`,
    `Freshness/failures: ${components.freshness_failure}/100`,
    `Selected claims: ${health.details.selected_claim_count}`,
    `Source types: ${health.details.distinct_source_type_count}`
  ].join("\n");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTime(value: number) {
  if (!value) {
    return "Unavailable";
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
}
