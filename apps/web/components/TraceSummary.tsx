import type { Trace } from "../lib/types";

type TraceSummaryProps = {
  trace?: Trace;
};

export function TraceSummary({ trace }: TraceSummaryProps) {
  if (!trace) {
    return <p className="empty-text">Trace unavailable until a live search completes.</p>;
  }

  const stageTimings = Object.entries(trace.stage_timings_ms ?? {});
  const sourceResults = Object.entries(trace.source_results ?? {});
  const counts = Object.entries(trace.counts ?? {});
  const selected = trace.selection?.selected_chunk_ids ?? [];
  const rejected = trace.selection?.rejected_chunk_ids ?? [];
  const warnings = trace.warnings ?? [];
  const errors = trace.errors ?? [];
  const modelUsage = Object.entries(trace.model_usage ?? {});
  const escalations = trace.escalations ?? [];
  const dedupClusters = trace.deduplication?.clusters ?? [];
  const evidenceHealth = trace.evidence_health;
  const retrievalRounds = trace.retrieval_rounds ?? [];
  const preRank = trace.pre_rank ?? [];
  const gapAnalysis = trace.gap_analysis;
  const synthesisReview = trace.synthesis_review;
  const scoringBatches = trace.scoring_batches ?? [];
  const structuredCalls = trace.structured_llm_calls ?? [];
  const wallTimeMs = durationBetween(trace.started_at, trace.finished_at);
  const stageTotalMs = stageTimings.reduce((sum, [, timing]) => sum + timing, 0);
  const cacheHitCount = scoringBatches.reduce((sum, batch) => sum + (batch.cache_hit_count ?? 0), 0);
  const cacheMissCount = scoringBatches.reduce((sum, batch) => sum + (batch.cache_miss_count ?? 0), 0);
  const timedOutCalls = structuredCalls.filter((call) => call.timeout).length;
  const reasoningOnCalls = structuredCalls.filter((call) => call.reasoning_enabled === true).length;

  return (
    <div className="trace-grid">
      <div className="trace-block">
        <h3>Request</h3>
        <ul className="trace-list">
          <li className="trace-row">
            <div className="trace-meta">
              <span className="tag">request</span>
            </div>
            <p className="trace-value">{trace.request_id}</p>
          </li>
          <li className="trace-row">
            <div className="trace-meta">
              <span className="tag">selection</span>
            </div>
            <p className="trace-value">
              {selected.length} selected, {rejected.length} rejected, {trace.selection?.estimated_tokens_used ?? 0}{" "}
              tokens used
            </p>
          </li>
        </ul>
      </div>

      <div className="trace-block">
        <h3>Runtime</h3>
        <table className="compact-table">
          <tbody>
            <tr>
              <th>Total wall</th>
              <td>{formatMs(wallTimeMs)}</td>
            </tr>
            <tr>
              <th>Stage sum</th>
              <td>{formatMs(stageTotalMs)}</td>
            </tr>
            <tr>
              <th>LLM calls</th>
              <td>
                {structuredCalls.length} total, {timedOutCalls} timed out, {reasoningOnCalls} reasoning on
              </td>
            </tr>
            <tr>
              <th>Score cache</th>
              <td>
                {cacheHitCount} hit(s), {cacheMissCount} miss(es)
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="trace-block">
        <h3>Counts</h3>
        <table className="compact-table">
          <tbody>
            {counts.map(([key, value]) => (
              <tr key={key}>
                <th>{labelize(key)}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="trace-block">
        <h3>Stage timings</h3>
        {stageTimings.length ? (
          <table className="compact-table">
            <tbody>
              {stageTimings.map(([stage, timing]) => (
                <tr key={stage}>
                  <th>{labelize(stage)}</th>
                  <td>{formatMs(timing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No stage timings returned.</p>
        )}
      </div>

      <div className="trace-block">
        <h3>Sources queried</h3>
        {sourceResults.length ? (
          <table className="compact-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>OK</th>
                <th>Failed</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {sourceResults.map(([source, result]) => (
                <tr key={source}>
                  <th>{source}</th>
                  <td>{result.ok}/{result.queried}</td>
                  <td>{result.failed}</td>
                  <td>{formatMs(result.timing_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No source results returned.</p>
        )}
      </div>

      <div className="trace-block">
        <h3>Model routing</h3>
        {modelUsage.length ? (
          <table className="compact-table">
            <tbody>
              {modelUsage.map(([stage, usage]) => (
                <tr key={stage}>
                  <th>{labelize(stage)}</th>
                  <td>
                    {usage.model}
                    {usage.escalated ? " escalated" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No model routing returned.</p>
        )}
      </div>

      <div className="trace-block">
        <h3>Structured LLM calls</h3>
        {structuredCalls.length ? (
          <table className="compact-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Time</th>
                <th>Reasoning</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {structuredCalls.slice(0, 12).map((call, index) => (
                <tr key={`${call.stage}-${call.task}-${call.attempt}-${index}`}>
                  <th>{labelize(call.stage)}</th>
                  <td>{formatMs(call.duration_ms)}</td>
                  <td>{call.reasoning_enabled === true ? "on" : "off"}</td>
                  <td>{call.ok ? "ok" : call.timeout ? "timeout" : "failed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No structured LLM calls returned.</p>
        )}
      </div>

      <div className="trace-block">
        <h3>Scoring batches</h3>
        {scoringBatches.length ? (
          <table className="compact-table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Time</th>
                <th>Kept</th>
                <th>Cache</th>
              </tr>
            </thead>
            <tbody>
              {scoringBatches.slice(0, 12).map((batch) => (
                <tr key={`${batch.stage_label}-${batch.batch_index}-${batch.batch_start}`}>
                  <th>{batch.stage_label}</th>
                  <td>{formatMs(batch.duration_ms)}</td>
                  <td>{batch.kept_count}/{batch.chunk_count}</td>
                  <td>
                    {batch.cache_hit_count ?? 0}/{batch.cache_miss_count ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No scoring batch diagnostics returned.</p>
        )}
      </div>

      <div className="trace-block">
        <h3>Deduplication</h3>
        {dedupClusters.length ? (
          <table className="compact-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>Members</th>
                <th>Novelty</th>
              </tr>
            </thead>
            <tbody>
              {dedupClusters.slice(0, 8).map((cluster) => (
                <tr key={cluster.id}>
                  <th>{cluster.duplicate_level}</th>
                  <td>{cluster.member_ids.length}</td>
                  <td>{formatRatio(cluster.novelty_score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-text">No duplicate clusters reported.</p>
        )}
      </div>

      {evidenceHealth ? (
        <div className="trace-block">
          <h3>Evidence health</h3>
          <table className="compact-table">
            <tbody>
              <tr>
                <th>Status</th>
                <td>{evidenceHealth.status}</td>
              </tr>
              <tr>
                <th>Quality</th>
                <td>{evidenceHealth.evidence_quality_score}/100</td>
              </tr>
              <tr>
                <th>Coverage</th>
                <td>{evidenceHealth.evidence_coverage_score}/100</td>
              </tr>
              <tr>
                <th>Claims</th>
                <td>{evidenceHealth.details.selected_claim_count}</td>
              </tr>
              <tr>
                <th>Source types</th>
                <td>{evidenceHealth.details.distinct_source_type_count}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {retrievalRounds.length ? (
        <div className="trace-block">
          <h3>Retrieval rounds</h3>
          <table className="compact-table">
            <tbody>
              {retrievalRounds.map((round) => (
                <tr key={round.round_index}>
                  <th>Round {round.round_index}</th>
                  <td>
                    {round.reason}: {round.raw_item_count} raw, {round.selected_chunk_count} selected,{" "}
                    {round.evidence_health?.status ?? "no health"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preRank.length ? (
        <div className="trace-block">
          <h3>Pre-rank</h3>
          <table className="compact-table">
            <thead>
              <tr>
                <th>Round</th>
                <th>Selected</th>
                <th>Rejected</th>
                <th>Dupes</th>
              </tr>
            </thead>
            <tbody>
              {preRank.map((round) => (
                <tr key={round.round_index}>
                  <th>{round.round_index}</th>
                  <td>{round.selected_for_llm_count}/{round.input_chunk_count}</td>
                  <td>{round.rejected_count}</td>
                  <td>{round.duplicate_group_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {gapAnalysis ? (
        <div className="trace-block">
          <h3>Gap analysis</h3>
          <ul className="trace-list">
            <li className="trace-row">
              <span className="tag">{gapAnalysis.status}</span>
              <p className="trace-value">{gapAnalysis.reasons.slice(0, 4).join(" ") || "No critical gaps."}</p>
            </li>
          </ul>
        </div>
      ) : null}

      {synthesisReview ? (
        <div className="trace-block">
          <h3>Synthesis review</h3>
          <ul className="trace-list">
            <li className="trace-row">
              <span className="tag">{synthesisReview.coverage_status}</span>
              <p className="trace-value">
                {[...synthesisReview.remaining_gaps, ...synthesisReview.keyword_context_warnings].slice(0, 4).join(" ") ||
                  "No reviewer gaps reported."}
              </p>
            </li>
          </ul>
        </div>
      ) : null}

      {escalations.length ? (
        <div className="trace-block">
          <h3>Escalations</h3>
          <ul className="trace-list">
            {escalations.map((escalation) => (
              <li className="trace-row" key={`${escalation.stage}-${escalation.from_model}-${escalation.to_model}`}>
                <span className="tag">{escalation.stage}</span>
                <p className="trace-value">
                  {escalation.from_model} {"->"} {escalation.to_model}: {escalation.reason}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length || errors.length ? (
        <div className="trace-block">
          <h3>Warnings and errors</h3>
          <ul className="trace-list">
            {warnings.map((warning, index) => (
              <li className="trace-row" key={`warning-${index}-${warning}`}>
                <span className="tag">warning</span>
                <p className="trace-value">{warning}</p>
              </li>
            ))}
            {errors.map((error) => (
              <li className="trace-row" key={`${error.stage}-${error.code}-${error.message}`}>
                <span className="tag">{error.stage}</span>
                <p className="trace-value">{error.code}: {error.message}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function labelize(value: string) {
  return value.replace(/_/g, " ");
}

function durationBetween(start: string | undefined, finish: string | undefined): number {
  if (!start || !finish) {
    return 0;
  }
  const startMs = Date.parse(start);
  const finishMs = Date.parse(finish);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) {
    return 0;
  }
  return Math.max(0, finishMs - startMs);
}

function formatMs(value: number | undefined) {
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

function formatRatio(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toFixed(2);
}
