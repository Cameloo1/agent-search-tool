import type {
  EvaluationResult,
  GoldAnswer,
  GoldQuestion,
  NormalizedSourceType,
  OpponentMode,
  OpponentResultFixture,
  PipelineResponse,
  RequiredSource,
  ScoreStatus
} from "@agent-search/shared";

export type SourceProvenance = "primary" | "secondary" | "tertiary" | "forum/opinion" | "unknown";

export interface CitedSource {
  url?: string;
  title?: string | null;
  source_name?: string;
  provenance: SourceProvenance;
  source_type?: NormalizedSourceType;
}

export interface GoldArtifact {
  version: string;
  methodology: string;
  questions: GoldQuestion[];
  answers: GoldAnswer[];
}

export type GoldArtifactStatus = "valid" | "missing" | "invalid";

export interface GoldValidationResult {
  status: Exclude<GoldArtifactStatus, "missing">;
  artifact?: GoldArtifact;
  errors: string[];
  warnings: string[];
}

export interface GoldLoadResult {
  status: GoldArtifactStatus;
  path: string;
  artifact?: GoldArtifact;
  errors: string[];
  warnings: string[];
}

export interface GoldMarkdownParseResult {
  artifact: unknown;
  errors: string[];
  warnings: string[];
}

export interface ScoreAgainstGoldInput {
  engineName: string;
  questionId?: string;
  finalAnswer: string;
  sourcesCited?: CitedSource[];
  tokenCount?: number;
  timeToResultMs?: number;
  gold: GoldArtifact | GoldLoadResult | GoldValidationResult | null | undefined;
  notes?: string[];
}

export interface ComparisonCandidate {
  engine_name: string;
  question_id?: string;
  final_answer?: string;
  sources_cited?: CitedSource[];
  token_count?: number;
  time_to_result_ms?: number;
  mode?: OpponentMode;
  notes?: string[];
  pipeline?: PipelineResponse;
}

export interface ComparisonItem {
  engine_name: string;
  question_id: string;
  final_answer: string;
  sources_cited: CitedSource[];
  token_count: number;
  time_to_result_ms: number;
  mode: OpponentMode;
  evaluation: EvaluationResult;
  pipeline?: PipelineResponse;
}

export interface OpponentFixtureLoadResult {
  status: "valid" | "missing" | "invalid";
  path: string;
  fixtures: OpponentResultFixture[];
  errors: string[];
  warnings: string[];
}

export interface RunComparisonOptions {
  questionId?: string;
  query?: string;
  goldPath?: string;
  goldArtifact?: GoldArtifact;
  goldLoadResult?: GoldLoadResult;
  candidates?: ComparisonCandidate[];
  opponentFixtures?: OpponentResultFixture[];
  opponentFixturePaths?: string[];
}

export interface ComparisonRunResult {
  question_id?: string;
  query?: string;
  gold_status: GoldArtifactStatus;
  items: ComparisonItem[];
  warnings: string[];
  errors: string[];
}

export interface BlockedEvaluationOptions {
  engineName: string;
  questionId: string;
  scoreStatus: ScoreStatus;
  tokenCount?: number;
  timeToResultMs?: number;
  notes?: string[];
}
