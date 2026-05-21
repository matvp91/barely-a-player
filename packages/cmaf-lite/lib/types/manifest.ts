import type { EncryptionScheme, KeySystem } from "./drm";
import type { MediaType } from "./media";

/**
 * Unknown language.
 *
 * @public
 */
export const LANGUAGE_UNKNOWN = "unk";

/**
 * Encryption metadata.
 *
 * @public
 */
export interface Protection {
  /** Encryption scheme. */
  scheme: EncryptionScheme;
  /** Default Key ID. */
  defaultKid: string;
  /** Per-key-system init material. */
  keySystems: Partial<Record<KeySystem, KeySystemInfo>>;
}

/**
 * Per-key-system init material.
 *
 * @public
 */
export interface KeySystemInfo {
  /** CENC PSSH blob (Widevine, PlayReady). */
  pssh?: Uint8Array;
  /** FairPlay content identifier (from `skd://...`). */
  contentId?: string;
}

/**
 * Parsed manifest representing a CMAF presentation.
 *
 * @public
 */
export interface Manifest {
  /** True if the presentation is live (dynamic); false for on-demand (static). */
  isLive: boolean;
  /** Presentation start */
  start: number;
  /** Presenation end */
  end: number;
  /** Groups of switchable tracks. */
  switchingSets: SwitchingSet[];
  /** Base time in UTC */
  baseDateTime?: Date;
}

/**
 * Shared fields across all switching set types.
 *
 * @public
 */
export interface BaseSwitchingSet {
  id: string;
  /** Codec string. */
  codec: string;
  protection?: Protection;
}

/**
 * Video switching set.
 *
 * @public
 */
export interface VideoSwitchingSet extends BaseSwitchingSet {
  type: MediaType.VIDEO;
  /** Video tracks. */
  tracks: VideoTrack[];
}

/**
 * Audio switching set.
 *
 * @public
 */
export interface AudioSwitchingSet extends BaseSwitchingSet {
  type: MediaType.AUDIO;
  /** Language */
  language: string;
  /** Audio tracks. */
  tracks: AudioTrack[];
}

/**
 * Subtitle switching set.
 *
 * @public
 */
export interface SubtitleSwitchingSet extends BaseSwitchingSet {
  type: MediaType.SUBTITLE;
  /** Language */
  language: string;
  /** Subtitle tracks. */
  tracks: SubtitleTrack[];
}

/**
 * CMAF switching set — tracks that can be seamlessly
 * switched between (same codec, same type).
 *
 * @public
 */
export type SwitchingSet<T extends MediaType = MediaType> = Extract<
  VideoSwitchingSet | AudioSwitchingSet | SubtitleSwitchingSet,
  {
    type: T;
  }
>;

/**
 * Shared fields across all track types.
 *
 * @public
 */
export interface BaseTrack {
  id: string;
  /** Bitrate in bits per second. */
  bandwidth: number;
  /** Ordered chunks on the presentation timeline. */
  segments: Segment[];
  /** Longest segment duration in seconds. */
  maxSegmentDuration: number;
}

/**
 * Video track with resolution.
 *
 * @public
 */
export interface VideoTrack extends BaseTrack {
  type: MediaType.VIDEO;
  /** Video width. */
  width: number;
  /** Video height. */
  height: number;
  /** Frames per second. Decimal form (e.g. 30 or 29.97). */
  frameRate: number;
}

/**
 * Audio track.
 *
 * @public
 */
export interface AudioTrack extends BaseTrack {
  type: MediaType.AUDIO;
  /** Channel count (e.g. 2 for stereo, 6 for 5.1). */
  channels: number;
  /** Sample rate in Hz. */
  sampleRate: number;
}

/**
 * Subtitle track.
 *
 * @public
 */
export interface SubtitleTrack extends BaseTrack {
  type: MediaType.SUBTITLE;
}

/**
 * Single track with its segment list, discriminated
 * by {@link MediaType}.
 *
 * @public
 */
export type Track<T extends MediaType = MediaType> = Extract<
  VideoTrack | AudioTrack | SubtitleTrack,
  {
    type: T;
  }
>;

/**
 * CMAF initialization segment (moov box).
 *
 * @public
 */
export type InitSegment = {
  /** Fully resolved URL. */
  url: string;
};

/**
 * Addressable media chunk on the presentation timeline.
 *
 * @public
 */
export type Segment = {
  /** Fully resolved URL. */
  url: string;
  /** Start time in seconds on the presentation timeline. */
  start: number;
  /** End time in seconds on the presentation timeline. */
  end: number;
  /** Associated initialization segment. */
  initSegment: InitSegment;
};
