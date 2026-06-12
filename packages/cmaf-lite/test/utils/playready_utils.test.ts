import { describe, expect, it } from "vitest";
import { unwrapPlayReadyChallenge } from "../../lib/utils/playready_utils";

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
