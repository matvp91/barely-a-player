import { describe, expect, it } from "vitest";
import { bytesEqual, toArrayBuffer, toHex } from "../../lib/utils/buffer_utils";

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
