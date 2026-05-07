import { describe, expect, it } from "vitest";
import { getHistoryNavigationState, resolveHistoryOffsetIndex } from "./SearchBox";

describe("SearchBox history navigation", () => {
  it("stops at newest and oldest matching runs instead of wrapping", () => {
    expect(
      getHistoryNavigationState({
        matchingRunCount: 3,
        activeMatchingIndex: 0,
        isLoading: false,
        hasSelectHandler: true
      })
    ).toEqual({
      canSelectNewerRun: false,
      canSelectOlderRun: true
    });

    expect(
      getHistoryNavigationState({
        matchingRunCount: 3,
        activeMatchingIndex: 2,
        isLoading: false,
        hasSelectHandler: true
      })
    ).toEqual({
      canSelectNewerRun: true,
      canSelectOlderRun: false
    });
  });

  it("starts from the nearest boundary when no matching run is active", () => {
    expect(resolveHistoryOffsetIndex({ matchingRunCount: 3, activeMatchingIndex: -1, offset: 1 })).toBe(0);
    expect(resolveHistoryOffsetIndex({ matchingRunCount: 3, activeMatchingIndex: -1, offset: -1 })).toBe(2);
  });
});
