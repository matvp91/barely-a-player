import { describe, expect, it } from "vitest";
import {
  keySystemFromSchemeIdUri,
  keySystemInfoFromRaw,
} from "../../lib/drm/drm_utils";
import { KeySystem } from "../../lib/types/drm";

describe("keySystemFromSchemeIdUri", () => {
  it("maps known Widevine UUID", () => {
    expect(
      keySystemFromSchemeIdUri("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"),
    ).toBe(KeySystem.WIDEVINE);
  });

  it("maps known PlayReady UUID", () => {
    expect(
      keySystemFromSchemeIdUri("urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"),
    ).toBe(KeySystem.PLAYREADY);
  });

  it("maps known FairPlay UUID", () => {
    expect(
      keySystemFromSchemeIdUri("urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"),
    ).toBe(KeySystem.FAIRPLAY);
  });

  it("is case-insensitive on the UUID", () => {
    expect(
      keySystemFromSchemeIdUri("urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"),
    ).toBe(KeySystem.WIDEVINE);
  });

  it("returns null for unknown UUIDs", () => {
    expect(
      keySystemFromSchemeIdUri("urn:uuid:01020304-0506-0708-0900-aabbccddeeff"),
    ).toBeNull();
  });

  it("returns null for non-uuid scheme URIs", () => {
    expect(
      keySystemFromSchemeIdUri("urn:mpeg:dash:mp4protection:2011"),
    ).toBeNull();
  });
});

describe("keySystemInfoFromRaw", () => {
  it("returns FairPlay contentId from the value attribute", () => {
    expect(
      keySystemInfoFromRaw(KeySystem.FAIRPLAY, "skd://example/abc", undefined),
    ).toEqual({ contentId: "skd://example/abc" });
  });

  it("returns FairPlay contentId from pssh text when value is absent", () => {
    expect(
      keySystemInfoFromRaw(KeySystem.FAIRPLAY, undefined, "skd://child/def"),
    ).toEqual({ contentId: "skd://child/def" });
  });

  it("returns an empty object for FairPlay when neither value nor psshText looks like skd://", () => {
    expect(
      keySystemInfoFromRaw(KeySystem.FAIRPLAY, undefined, undefined),
    ).toEqual({});
    expect(
      keySystemInfoFromRaw(KeySystem.FAIRPLAY, "not-skd", "also-not-skd"),
    ).toEqual({});
  });

  it("base64-decodes the pssh blob for CENC key systems", () => {
    const out = keySystemInfoFromRaw(KeySystem.WIDEVINE, undefined, "AQIDBA==");
    expect(out.pssh).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.pssh!)).toEqual([1, 2, 3, 4]);
  });

  it("returns an empty object for CENC key systems when no psshText is provided", () => {
    expect(
      keySystemInfoFromRaw(KeySystem.WIDEVINE, undefined, undefined),
    ).toEqual({});
  });
});
