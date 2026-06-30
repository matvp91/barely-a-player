import { describe, expect, it } from "vitest";
import {
  getBufferedEnd,
  getNextBufferedStart,
} from "../../lib/utils/time_ranges_utils";
import { createTimeRanges } from "../__framework__/time_ranges";

describe("TimeRangesUtils", () => {
  describe("getBufferedEnd", () => {
    it("returns end of range containing position", () => {
      const buffered = createTimeRanges([0, 10]);
      expect(getBufferedEnd(buffered, 5, 0.1)).toBe(10);
    });

    it("returns null when position is outside all ranges", () => {
      const buffered = createTimeRanges([0, 10]);
      expect(getBufferedEnd(buffered, 15, 0.1)).toBeNull();
    });

    it("returns null for empty TimeRanges", () => {
      const buffered = createTimeRanges();
      expect(getBufferedEnd(buffered, 0, 0.1)).toBeNull();
    });

    it("merges adjacent ranges with gap smaller than maxHole", () => {
      const buffered = createTimeRanges([0, 5], [5.05, 10]);
      expect(getBufferedEnd(buffered, 3, 0.1)).toBe(10);
    });

    it("does not merge ranges with gap larger than maxHole", () => {
      const buffered = createTimeRanges([0, 5], [6, 10]);
      expect(getBufferedEnd(buffered, 3, 0.1)).toBe(5);
    });

    it("tolerates position slightly before range start", () => {
      const buffered = createTimeRanges([1, 10]);
      expect(getBufferedEnd(buffered, 0.95, 0.1)).toBe(10);
    });
  });

  describe("getNextBufferedStart", () => {
    it("returns start of first range after position", () => {
      const buffered = createTimeRanges([0, 5], [10, 15]);
      expect(getNextBufferedStart(buffered, 6)).toBe(10);
    });

    it("returns null when no range starts after position", () => {
      const buffered = createTimeRanges([0, 5]);
      expect(getNextBufferedStart(buffered, 6)).toBeNull();
    });

    it("returns null for empty TimeRanges", () => {
      const buffered = createTimeRanges();
      expect(getNextBufferedStart(buffered, 0)).toBeNull();
    });

    it("skips ranges that start at or before position", () => {
      const buffered = createTimeRanges([0, 5], [5, 10], [15, 20]);
      expect(getNextBufferedStart(buffered, 5)).toBe(15);
    });
  });
});
