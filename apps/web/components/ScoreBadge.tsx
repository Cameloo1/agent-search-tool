import type { ScoreStatus } from "../lib/types";

type ScoreBadgeProps = {
  status?: ScoreStatus;
  evidenceChecked?: boolean;
};

const LABELS: Record<ScoreStatus, string> = {
  scored: "Scored",
  blocked_missing_gold: "Scoring unavailable",
  blocked_invalid_gold: "Gold invalid",
  scoring_unavailable: "Scoring unavailable"
};

export function ScoreBadge({ status = "scoring_unavailable", evidenceChecked = false }: ScoreBadgeProps) {
  if (evidenceChecked && status !== "scored") {
    return <span className="score-badge evidence">Evidence Checked</span>;
  }

  const className =
    status === "scored"
      ? "score-badge scored"
      : status === "blocked_invalid_gold"
        ? "score-badge invalid"
        : status === "blocked_missing_gold"
          ? "score-badge blocked"
          : "score-badge unavailable";

  return <span className={className}>{LABELS[status]}</span>;
}
