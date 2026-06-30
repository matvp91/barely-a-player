import { describe, expect, it } from "vitest";
import { buildPlayReadyRequest } from "../../lib/utils/playready_utils";

function utf16LE(s: string): ArrayBuffer {
  const buf = new ArrayBuffer(s.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < s.length; i++) {
    view.setUint16(i * 2, s.charCodeAt(i), true);
  }
  return buf;
}

describe("buildPlayReadyRequest", () => {
  it("decodes the base64 Challenge and copies HttpHeaders from a PlayReadyKeyMessage envelope", () => {
    const inner = btoa("hello-soap");
    const xml =
      '<PlayReadyKeyMessage type="LicenseAcquisition">' +
      '<LicenseAcquisition Version="1">' +
      "<HttpHeaders>" +
      "<HttpHeader><name>Content-Type</name><value>application/soap+xml</value></HttpHeader>" +
      "<HttpHeader>" +
      "<name>SOAPAction</name>" +
      '<value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value>' +
      "</HttpHeader>" +
      "</HttpHeaders>" +
      `<Challenge encoding="base64encoded">${inner}</Challenge>` +
      "</LicenseAcquisition>" +
      "</PlayReadyKeyMessage>";
    const { body, headers } = buildPlayReadyRequest(utf16LE(xml));
    expect(new TextDecoder().decode(body)).toBe("hello-soap");
    expect(headers.get("Content-Type")).toBe("application/soap+xml");
    expect(headers.get("SOAPAction")).toContain("AcquireLicense");
  });

  it("returns the original buffer and default Content-Type for a raw (non-envelope) message", () => {
    const raw = new Uint8Array([1, 2, 3, 4]).buffer;
    const { body, headers } = buildPlayReadyRequest(raw);
    expect(body).toBe(raw);
    expect(headers.get("Content-Type")).toBe("text/xml; charset=utf-8");
  });
});
