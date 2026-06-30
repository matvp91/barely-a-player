/**
 * Find the end of the buffered range containing the given
 * position. Merges adjacent ranges with gaps smaller than
 * maxHole and tolerates the position being slightly before
 * a range start.
 */
export function getBufferedEnd(
  buffered: TimeRanges,
  pos: number,
  maxHole: number,
): number | null {
  let rangeStart = 0;
  let rangeEnd = 0;

  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);

    if (i > 0 && start - rangeEnd < maxHole) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      if (pos + maxHole >= rangeStart && pos < rangeEnd) {
        return rangeEnd;
      }
      rangeStart = start;
      rangeEnd = end;
    }
  }

  if (pos + maxHole >= rangeStart && pos < rangeEnd) {
    return rangeEnd;
  }

  return null;
}

/**
 * Find the start of the first buffered range after the
 * given position.
 */
export function getNextBufferedStart(
  buffered: TimeRanges,
  pos: number,
): number | null {
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    if (start > pos) {
      return start;
    }
  }
  return null;
}

/**
 * Copies a Uint8Array view into a standalone ArrayBuffer sized to the
 * view's window. EME APIs (`generateRequest`, `update`,
 * `setServerCertificate`) take an ArrayBuffer; passing a subarray's
 * backing buffer directly would leak neighbouring bytes.
 */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * Lowercase hex encoding of a byte array. Used to key key-status maps
 * and to compare key IDs.
 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Byte-wise equality of two arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
