import { describe, expect, it } from "vitest";
import { BACKEND_STALL_AFTER_MS, deriveBackendStatus, statusFromBackendEvent } from "./backendStatus";

describe("backend status indicator", () => {
  it("keeps the indicator live while fresh backend updates are arriving", () => {
    expect(
      deriveBackendStatus({
        current: "live",
        isLoading: true,
        lastBackendEventAt: 10_000,
        now: 10_000 + BACKEND_STALL_AFTER_MS - 1
      })
    ).toBe("live");
  });

  it("pauses into stalled after six seconds without backend updates", () => {
    expect(
      deriveBackendStatus({
        current: "live",
        isLoading: true,
        lastBackendEventAt: 10_000,
        now: 10_000 + BACKEND_STALL_AFTER_MS
      })
    ).toBe("stalled");
  });

  it("does not overwrite terminal states", () => {
    expect(
      deriveBackendStatus({
        current: "done",
        isLoading: false,
        lastBackendEventAt: 10_000,
        now: 30_000
      })
    ).toBe("done");
    expect(
      deriveBackendStatus({
        current: "broken",
        isLoading: true,
        lastBackendEventAt: 10_000,
        now: 30_000
      })
    ).toBe("broken");
  });

  it("maps final stream events to done and other backend events to live", () => {
    expect(statusFromBackendEvent({ type: "final", at: new Date().toISOString(), response: {} as never })).toBe("done");
    expect(statusFromBackendEvent({ type: "stage_start", stage: "stage1", message: "Starting", at: new Date().toISOString() })).toBe("live");
  });
});
