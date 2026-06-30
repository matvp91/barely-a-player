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

/**
 * Builds the request headers for a PlayReady license POST. When the CDM
 * message is the legacy `PlayReadyKeyMessage` SOAP envelope, copies its
 * `<HttpHeader>` name/value pairs (notably `Content-Type` and
 * `SOAPAction`). Otherwise defaults to `text/xml; charset=utf-8`, which is
 * what modern `com.microsoft.playready.recommendation` challenges expect.
 *
 * @public
 */
export function playReadyRequestHeaders(buffer: ArrayBuffer): Headers {
  const headers = new Headers();
  if (buffer.byteLength >= 2) {
    const xml = new TextDecoder("utf-16le").decode(buffer);
    if (xml.includes("PlayReadyKeyMessage")) {
      const headerRe =
        /<HttpHeader>\s*<name>([^<]+)<\/name>\s*<value>([^<]*)<\/value>\s*<\/HttpHeader>/g;
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
      while ((match = headerRe.exec(xml)) !== null) {
        if (match[1] !== undefined && match[2] !== undefined) {
          headers.set(match[1], match[2]);
        }
      }
    }
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/xml; charset=utf-8");
  }
  return headers;
}
