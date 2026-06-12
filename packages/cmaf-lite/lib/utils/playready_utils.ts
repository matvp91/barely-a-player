/**
 * Unwraps a PlayReady CDM license challenge.
 *
 * PlayReady challenges arrive as UTF-16-LE encoded XML wrapping a
 * base64-encoded inner SOAP body. License servers expect the raw
 * inner body, not the envelope.
 *
 * Returns the original buffer unchanged when it does not match the
 * PlayReady envelope shape (some content/CDM combinations emit the
 * SOAP body directly).
 *
 * @public
 */
export function unwrapPlayReadyChallenge(buffer: ArrayBuffer): ArrayBuffer {
  if (buffer.byteLength < 2) {
    return buffer;
  }
  const xml = new TextDecoder("utf-16le").decode(buffer);
  const match = /<Challenge[^>]*>([^<]+)<\/Challenge>/.exec(xml);
  if (!match || match[1] === undefined) {
    return buffer;
  }
  const bin = atob(match[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out.buffer;
}
