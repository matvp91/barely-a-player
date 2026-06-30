import { describe, expect, it } from "vitest";
import {
  playReadyRequestHeaders,
  unwrapPlayReadyChallenge,
} from "../../lib/utils/playready_utils";

function utf16LE(s: string): ArrayBuffer {
  const buf = new ArrayBuffer(s.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < s.length; i++) {
    view.setUint16(i * 2, s.charCodeAt(i), true);
  }
  return buf;
}

describe("unwrapPlayReadyChallenge", () => {
  it("returns the base64-decoded body of the inner Challenge element", () => {
    const inner = btoa("hello-soap");
    const xml =
      `<PlayReadyKeyMessage type="LicenseAcquisition">` +
      `<LicenseAcquisition Version="1">` +
      `<Challenge encoding="base64encoded">${inner}</Challenge>` +
      `</LicenseAcquisition>` +
      `</PlayReadyKeyMessage>`;
    const wrapped = utf16LE(xml);
    const out = unwrapPlayReadyChallenge(wrapped);
    expect(new TextDecoder().decode(out)).toBe("hello-soap");
  });

  it("returns the original buffer if it does not look like a PlayReady envelope", () => {
    const raw = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(unwrapPlayReadyChallenge(raw)).toBe(raw);
  });
});

describe("playReadyRequestHeaders", () => {
  it("defaults to text/xml when the message is already unwrapped", () => {
    const message = new TextEncoder().encode("raw-challenge").buffer;
    const headers = playReadyRequestHeaders(message);
    expect(headers.get("Content-Type")).toBe("text/xml; charset=utf-8");
  });

  it("copies SOAPAction and Content-Type from a PlayReadyKeyMessage envelope", () => {
    const xml =
      "<PlayReadyKeyMessage><LicenseAcquisition>" +
      "<HttpHeaders><HttpHeader>" +
      "<name>Content-Type</name><value>application/soap+xml</value>" +
      "</HttpHeader><HttpHeader>" +
      '<name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value>' +
      "</HttpHeader></HttpHeaders>" +
      "<Challenge>Y2hhbGxlbmdl</Challenge>" +
      "</LicenseAcquisition></PlayReadyKeyMessage>";
    const bytes = new Uint8Array(xml.length * 2);
    for (let i = 0; i < xml.length; i++) {
      bytes[i * 2] = xml.charCodeAt(i) & 0xff;
      bytes[i * 2 + 1] = xml.charCodeAt(i) >> 8;
    }
    const headers = playReadyRequestHeaders(bytes.buffer);
    expect(headers.get("Content-Type")).toBe("application/soap+xml");
    expect(headers.get("SOAPAction")).toContain("AcquireLicense");
  });
});
