import { vi } from "vitest";
import type { DrmConfig, PlayerConfig } from "../../lib/config";
import { DEFAULT_CONFIG as LIB_DEFAULT_CONFIG } from "../../lib/config";
import { KeySystem } from "../../lib/types/drm";
import type {
  InitSegment,
  Manifest,
  Protection,
  Segment,
  SwitchingSet,
  Track,
} from "../../lib/types/manifest";
import { LANGUAGE_UNKNOWN } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";

export function createInitSegment(
  overrides?: Partial<InitSegment>,
): InitSegment {
  return {
    url: "https://cdn.test/init.mp4",
    ...overrides,
  };
}

export function createSegment(overrides?: Partial<Segment>): Segment {
  return {
    url: "https://cdn.test/seg-1.m4s",
    start: 0,
    end: 4,
    initSegment: createInitSegment(),
    ...overrides,
  };
}

export function createVideoTrack(
  overrides?: Partial<Track<MediaType.VIDEO>>,
): Track<MediaType.VIDEO> {
  return {
    id: "video-track-1",
    type: MediaType.VIDEO,
    bandwidth: 2_000_000,
    width: 1920,
    height: 1080,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createAudioTrack(
  overrides?: Partial<Track<MediaType.AUDIO>>,
): Track<MediaType.AUDIO> {
  return {
    id: "audio-track-1",
    type: MediaType.AUDIO,
    bandwidth: 128_000,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createVideoSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.VIDEO>>,
): SwitchingSet<MediaType.VIDEO> {
  return {
    id: "video:avc1.64001f",
    type: MediaType.VIDEO,
    codec: "avc1.64001f",
    tracks: [createVideoTrack()],
    ...overrides,
  };
}

export function createAudioSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.AUDIO>>,
): SwitchingSet<MediaType.AUDIO> {
  return {
    id: "audio:mp4a.40.2:unk",
    type: MediaType.AUDIO,
    codec: "mp4a.40.2",
    language: LANGUAGE_UNKNOWN,
    tracks: [createAudioTrack()],
    ...overrides,
  };
}

export function createSubtitleTrack(
  overrides?: Partial<Track<MediaType.SUBTITLE>>,
): Track<MediaType.SUBTITLE> {
  return {
    id: "subtitle-track-1",
    type: MediaType.SUBTITLE,
    bandwidth: 1_000,
    segments: [createSegment()],
    maxSegmentDuration: 4,
    ...overrides,
  };
}

export function createSubtitleSwitchingSet(
  overrides?: Partial<SwitchingSet<MediaType.SUBTITLE>>,
): SwitchingSet<MediaType.SUBTITLE> {
  return {
    id: "subtitle:wvtt:unk",
    type: MediaType.SUBTITLE,
    codec: "wvtt",
    language: LANGUAGE_UNKNOWN,
    tracks: [createSubtitleTrack()],
    ...overrides,
  };
}

export function createManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    start: 0,
    end: 60,
    isLive: false,
    switchingSets: [createVideoSwitchingSet(), createAudioSwitchingSet()],
    ...overrides,
  };
}

export function createDecodingInfo(
  overrides?: Partial<MediaCapabilitiesDecodingInfo>,
): MediaCapabilitiesDecodingInfo {
  return {
    supported: true,
    smooth: true,
    powerEfficient: true,
    keySystemAccess: null,
    ...overrides,
  };
}

/**
 * Installs a stub for `navigator.mediaCapabilities.decodingInfo`
 * that returns `info` for every probe. Returns the spy so callers
 * can inspect call count / arguments. Caller is responsible for
 * restoring with `vi.restoreAllMocks()` (or per-test cleanup).
 */
export function mockMediaCapabilities(
  info: MediaCapabilitiesDecodingInfo = createDecodingInfo(),
) {
  // happy-dom doesn't ship `navigator.mediaCapabilities` by default.
  // Define it lazily so we can vi.spyOn it.
  const nav = navigator as Navigator & {
    mediaCapabilities?: MediaCapabilities;
  };
  if (!nav.mediaCapabilities) {
    Object.defineProperty(nav, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo: async () => info },
    });
  }
  return vi
    .spyOn(nav.mediaCapabilities!, "decodingInfo")
    .mockResolvedValue(info);
}

export function createProtection(overrides?: Partial<Protection>): Protection {
  return {
    defaultKid: "abcdef0123456789abcdef0123456789",
    keySystems: {
      [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1, 2, 3, 4]) },
    },
    ...overrides,
  };
}

export function createKeySystemAccess(keySystem: string): MediaKeySystemAccess {
  return {
    keySystem,
    getConfiguration: () => ({}) as MediaKeySystemConfiguration,
    createMediaKeys: async () => ({}) as MediaKeys,
  } as MediaKeySystemAccess;
}

export const DEFAULT_DRM_CONFIG: DrmConfig = {
  preferredKeySystems: [
    KeySystem.FAIRPLAY,
    KeySystem.WIDEVINE,
    KeySystem.PLAYREADY,
  ],
  licenseUrls: {},
  serverCertificates: {},
};

/**
 * Full PlayerConfig fixture for tests. Override individual slices by
 * spreading: `{ ...DEFAULT_CONFIG, drm: { ...DEFAULT_DRM_CONFIG, ... } }`.
 */
export const DEFAULT_CONFIG: PlayerConfig = {
  ...LIB_DEFAULT_CONFIG,
  drm: DEFAULT_DRM_CONFIG,
};
