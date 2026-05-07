export interface StageError {
  stage: string;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function stageError(
  stage: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable?: boolean
): StageError {
  return { stage, code, message, retryable, details };
}
