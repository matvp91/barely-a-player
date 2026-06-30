import * as BufferUtils from "./buffer_utils";
import * as StringUtils from "./string_utils";

/**
 * Prepares a PlayReady license request from a CDM message.
 *
 * PlayReady CDM messages may be a UTF-16-LE `PlayReadyKeyMessage` SOAP
 * envelope wrapping a base64 `<Challenge>` plus `<HttpHeader>` pairs; the
 * license server wants the raw challenge with those headers. Modern
 * `com.microsoft.playready.recommendation` may emit the challenge directly.
 *
 * Returns the request body (the unwrapped challenge, or the message
 * unchanged when not enveloped) and headers (copied from the envelope's
 * `<HttpHeader>`s, defaulting `Content-Type: text/xml; charset=utf-8`).
 *
 * @public
 */
export function buildPlayReadyRequest(message: ArrayBuffer): {
  body: ArrayBuffer;
  headers: Headers;
} {
  const headers = new Headers();
  let body = message;
  if (message.byteLength >= 2) {
    const xml = new TextDecoder("utf-16le").decode(message);
    const challenge = /<Challenge[^>]*>([^<]+)<\/Challenge>/.exec(xml);
    if (challenge && challenge[1] !== undefined) {
      body = BufferUtils.toArrayBuffer(StringUtils.decodeBase64(challenge[1]));
    }
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
  return { body, headers };
}
