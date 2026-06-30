import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  getBufferedEnd,
  getNextBufferedStart,
  toArrayBuffer,
  toHex,
} from "../../lib/utils/buffer_utils";
import { createTimeRanges } from "../__framework__/time_ranges";

describe("BufferUtils", () => {
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

describe("toArrayBuffer", () => {
  it("copies the exact bytes into a standalone ArrayBuffer", () => {
    const view = new Uint8Array([1, 2, 3, 4]);
    const buf = toArrayBuffer(view);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3, 4]);
  });

  it("copies only the view's window of a larger backing buffer", () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    const view = backing.subarray(1, 3);
    expect(Array.from(new Uint8Array(toArrayBuffer(view)))).toEqual([1, 2]);
  });
});

describe("toHex", () => {
  it("renders each byte as two lowercase hex digits", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });

  it("returns an empty string for empty input", () => {
    expect(toHex(new Uint8Array([]))).toBe("");
  });
});

describe("bytesEqual", () => {
  it("is true for identical contents", () => {
    expect(
      bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    ).toBe(true);
  });

  it("is false for differing lengths", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    );
  });

  it("is false for same length, different bytes", () => {
    expect(
      bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3])),
    ).toBe(false);
  });
});
