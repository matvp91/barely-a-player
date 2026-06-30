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
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
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
