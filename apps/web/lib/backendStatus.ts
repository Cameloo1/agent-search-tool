import type { BackendStatusState, PipelineProgressEvent } from "./types";

export const BACKEND_STALL_AFTER_MS = 6_000;

export function statusFromBackendEvent(event: PipelineProgressEvent): BackendStatusState {
  return event.type === "final" ? "done" : "live";
}

export function deriveBackendStatus(input: {
  current: BackendStatusState;
  isLoading: boolean;
  lastBackendEventAt: number | null;
  now: number;
  stallAfterMs?: number;
}): BackendStatusState {
  if (!input.isLoading || (input.current !== "live" && input.current !== "stalled")) {
    return input.current;
  }

  if (!input.lastBackendEventAt) {
    return input.current;
  }

  const stallAfterMs = input.stallAfterMs ?? BACKEND_STALL_AFTER_MS;
  return input.now - input.lastBackendEventAt >= stallAfterMs ? "stalled" : "live";
}
