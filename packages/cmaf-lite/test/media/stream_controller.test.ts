import { afterEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../lib/events";
import { Player } from "../../lib/player";
import { KeySystem } from "../../lib/types/drm";
import { MediaType } from "../../lib/types/media";
import { createFakeKeySystemAccess } from "../__framework__/eme";
import {
  createManifest,
  createProtection,
  createVideoSwitchingSet,
  createVideoTrack,
} from "../__framework__/factories";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Builds a manifest with two video switching sets, each protected by a
 * distinct default_KID. The audio switching set is omitted so the test only
 * exercises VIDEO restriction switching.
 */
const twoProtectedVideoManifest = () => {
  const mkSet = (kid: string, bandwidth: number) =>
    createVideoSwitchingSet({
      id: `video:${kid}`,
      protection: createProtection({
        defaultKid: kid,
        keySystems: { [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) } },
      }),
      tracks: [createVideoTrack({ id: `track:${kid}`, bandwidth })],
    });

  return createManifest({
    switchingSets: [
      mkSet("aaaaaaaa000000000000000000000000", 1_000_000),
      mkSet("bbbbbbbb000000000000000000000000", 2_000_000),
    ],
  });
};

describe("StreamController restrictions", () => {
  it("switches the active stream off a newly restricted key", async () => {
    const player = new Player();
    const manifest = twoProtectedVideoManifest();

    // Mock decodingInfo so selectKeySystem finds Widevine supported and
    // buildStreams marks every track as supported.
    const fakeAccess = createFakeKeySystemAccess(KeySystem.WIDEVINE);
    const nav = navigator as Navigator & {
      mediaCapabilities?: MediaCapabilities;
    };
    if (!nav.mediaCapabilities) {
      Object.defineProperty(nav, "mediaCapabilities", {
        configurable: true,
        value: { decodingInfo: async () => ({}) },
      });
    }
    vi.spyOn(nav.mediaCapabilities!, "decodingInfo").mockResolvedValue({
      supported: true,
      smooth: true,
      powerEfficient: true,
      keySystemAccess: fakeAccess,
    });

    // Drive the controller's internal streams_ via the real MANIFEST_UPDATED
    // path so that onStreamsUpdating_ has streams to iterate.
    player.emit(Events.MANIFEST_UPDATED, { manifest, isUpdate: false });

    // onManifestUpdated_ is async — wait for STREAMS_UPDATED which fires
    // after this.streams_ is populated.
    await vi.waitFor(() => {
      expect(player.getStreams(MediaType.VIDEO)).toHaveLength(2);
    });

    const streams = player.getStreams(MediaType.VIDEO);

    // streams are sorted ascending by bandwidth, so index 0 = 1 Mbps (aaaa),
    // index 1 = 2 Mbps (bbbb).
    const restrictedStream = streams[0]!;
    const safeStream = streams[1]!;

    // Make the restricted stream the active one.
    player.setActiveStream(restrictedStream);
    expect(player.getActiveStream(MediaType.VIDEO)).toBe(restrictedStream);

    // Restrict the key ID that belongs to the first stream.
    player.emit(Events.STREAMS_UPDATING, {
      restrictedKeyIds: new Set(["aaaaaaaa000000000000000000000000"]),
    });

    // StreamController must have switched the active stream to the
    // non-restricted one.
    expect(player.getActiveStream(MediaType.VIDEO)).toBe(safeStream);
  });
});
