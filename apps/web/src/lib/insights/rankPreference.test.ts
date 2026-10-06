// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RANK_PREFERENCE_KEY, readRankPreference, resetRankPreferenceForTests, subscribeRankPreference, writeRankPreference,
} from "./rankPreference";

beforeEach(() => {
  window.localStorage.clear();
  resetRankPreferenceForTests();
  vi.restoreAllMocks();
});

describe("rank preference", () => {
  it("is off by default and remembers a choice in localStorage", () => {
    expect(readRankPreference()).toBe(false);
    writeRankPreference(true);
    expect(window.localStorage.getItem(RANK_PREFERENCE_KEY)).toBe("1");
    resetRankPreferenceForTests();
    expect(readRankPreference()).toBe(true);
  });

  it("notifies subscribers on write and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRankPreference(listener);
    writeRankPreference(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeRankPreference(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still works for the page when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRankPreference()).toBe(false);
    writeRankPreference(true);
    expect(readRankPreference()).toBe(true);
  });
});
