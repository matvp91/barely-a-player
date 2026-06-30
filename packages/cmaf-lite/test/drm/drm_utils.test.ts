import { describe, expect, it } from "vitest";
import {
  classifyKeyStatuses,
  hasProtectedContent,
  keySystemFromSchemeIdUri,
  keySystemInfoFromRaw,
  normalizeKeyId,
  psshFromPlayReadyPro,
} from "../../lib/drm/drm_utils";
import { KeySystem } from "../../lib/types/drm";
import {
  createManifest,
  createProtection,
  createVideoSwitchingSet,
} from "../__framework__/factories";

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

describe("psshFromPlayReadyPro", () => {
  it("wraps a PlayReady Object in a v0 pssh box with correct byte layout", () => {
    const pro = new Uint8Array([1, 2, 3]);
    const box = psshFromPlayReadyPro(pro);
    // Total size: 4 (size) + 4 ("pssh") + 4 (version+flags) + 16 (system id) + 4 (dataSize) + 3 (data) = 35
    expect(box.length).toBe(35);
    // Bytes 0..4: big-endian box size = 35
    expect(Array.from(box.subarray(0, 4))).toEqual([0, 0, 0, 35]);
    // Bytes 4..8: "pssh"
    expect(Array.from(box.subarray(4, 8))).toEqual([0x70, 0x73, 0x73, 0x68]);
    // Bytes 8..12: version 0 + flags 0
    expect(Array.from(box.subarray(8, 12))).toEqual([0, 0, 0, 0]);
    // Bytes 12..28: PlayReady system id
    expect(Array.from(box.subarray(12, 28))).toEqual([
      0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6, 0x5b,
      0xe0, 0x88, 0x5f, 0x95,
    ]);
    // Bytes 28..32: data size = 3
    expect(Array.from(box.subarray(28, 32))).toEqual([0, 0, 0, 3]);
    // Bytes 32..35: pro data
    expect(Array.from(box.subarray(32, 35))).toEqual([1, 2, 3]);
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

  it("synthesizes a PlayReady PSSH from proText when psshText is absent", () => {
    // "AQID" is base64 for [1, 2, 3]
    const out = keySystemInfoFromRaw(
      KeySystem.PLAYREADY,
      undefined,
      undefined,
      "AQID",
    );
    expect(out.pssh).toBeInstanceOf(Uint8Array);
    // Synthesized box starts after size (4 bytes) with "pssh"
    expect(Array.from(out.pssh!.subarray(4, 8))).toEqual([
      0x70, 0x73, 0x73, 0x68,
    ]);
    // Contains PlayReady system id at bytes 12..28
    expect(Array.from(out.pssh!.subarray(12, 28))).toEqual([
      0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6, 0x5b,
      0xe0, 0x88, 0x5f, 0x95,
    ]);
  });

  it("uses cenc:pssh (psshText wins) when both psshText and proText are present for PlayReady", () => {
    // psshText = base64 of [0xAA, 0xBB] → "qrs=" is not right; use btoa approach: [170, 187] → "qrs="
    // "qrs=" decodes to [0xaa, 0xbb] — but let's use a clean known value: "AQIDBA==" = [1,2,3,4]
    const out = keySystemInfoFromRaw(
      KeySystem.PLAYREADY,
      undefined,
      "AQIDBA==",
      "AQID",
    );
    expect(out.pssh).toBeInstanceOf(Uint8Array);
    // Should be the raw psshText bytes [1, 2, 3, 4], NOT a synthesized box
    expect(Array.from(out.pssh!)).toEqual([1, 2, 3, 4]);
  });
});

describe("hasProtectedContent", () => {
  it("is true when an A/V switching set carries protection", () => {
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({ protection: createProtection() }),
      ],
    });
    expect(hasProtectedContent(manifest)).toBe(true);
  });

  it("is false for clear content", () => {
    expect(hasProtectedContent(createManifest())).toBe(false);
  });
});

describe("classifyKeyStatuses", () => {
  it("reports allExpired when every key is expired", () => {
    const v = classifyKeyStatuses(
      new Map([
        ["aa", "expired"],
        ["bb", "expired"],
      ]),
    );
    expect(v.allExpired).toBe(true);
    expect(v.restrictedKeyIds.size).toBe(0);
  });

  it("does not report allExpired when any key is not expired", () => {
    const v = classifyKeyStatuses(
      new Map([
        ["aa", "expired"],
        ["bb", "usable"],
      ]),
    );
    expect(v.allExpired).toBe(false);
  });

  it("collects internal-error and output-restricted keys as restricted", () => {
    const v = classifyKeyStatuses(
      new Map<string, MediaKeyStatus>([
        ["aa", "usable"],
        ["bb", "output-restricted"],
        ["cc", "internal-error"],
      ]),
    );
    expect([...v.restrictedKeyIds].sort()).toEqual(["bb", "cc"]);
  });

  it("treats an empty map as not expired with no restrictions", () => {
    const v = classifyKeyStatuses(new Map());
    expect(v.allExpired).toBe(false);
    expect(v.restrictedKeyIds.size).toBe(0);
  });
});

describe("normalizeKeyId", () => {
  it("strips dashes and lowercases", () => {
    expect(normalizeKeyId("ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
  });
});
