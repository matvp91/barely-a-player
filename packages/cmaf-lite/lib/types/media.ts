import type {
  PROP_DECODING_INFO,
  PROP_HIERARCHY,
  PROP_KEY_SYSTEM_ACCESS,
} from "../constants";
import type { SwitchingSet, Track } from "./manifest";

/**
 * Supported media types.
 *
 * @public
 */
export enum MediaType {
  VIDEO = "video",
  AUDIO = "audio",
  SUBTITLE = "subtitle",
}

/**
 * Media types backed by a SourceBuffer.
 *
 * @public
 */
export type SourceBufferMediaType = MediaType.VIDEO | MediaType.AUDIO;

/**
 * Reference into the manifest that a {@link Stream} is a view of.
 * `switchingSet` and `track` are the exact manifest objects — not
 * copies — so reference equality can be used to detect a switching-set
 * change (which drives MSE `changeType`).
 *
 * @public
 */
export interface StreamHierarchy<T extends MediaType = MediaType> {
  switchingSet: SwitchingSet<T>;
  track: Track<T>;
}

/**
 * Shared fields across all stream types.
 *
 * @public
 */
export interface BaseStream {
  /** Normalized codec. */
  codec: string;
  /** Bitrate in bits per second. */
  bandwidth: number;
}

/**
 * Video stream with resolution and hierarchy.
 *
 * @public
 */
export interface VideoStream extends BaseStream {
  type: MediaType.VIDEO;
  /** Video width. */
  width: number;
  /** Video height. */
  height: number;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.VIDEO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
  [PROP_KEY_SYSTEM_ACCESS]?: MediaKeySystemAccess;
}

/**
 * Audio stream with hierarchy.
 *
 * @public
 */
export interface AudioStream extends BaseStream {
  type: MediaType.AUDIO;
  /** Language */
  language: string;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.AUDIO>;
  [PROP_DECODING_INFO]: MediaCapabilitiesDecodingInfo;
  [PROP_KEY_SYSTEM_ACCESS]?: MediaKeySystemAccess;
}

/**
 * Subtitle stream. No additional fields today; subtitle streams
 * are part of the stream model but not yet wired through
 * the stream controller.
 *
 * @public
 */
export interface SubtitleStream extends BaseStream {
  type: MediaType.SUBTITLE;
  [PROP_HIERARCHY]: StreamHierarchy<MediaType.SUBTITLE>;
}

/**
 * Set of compatible, switchable tracks sharing a codec
 * and media type. Discriminated by {@link MediaType}.
 *
 * @public
 */
export type Stream<T extends MediaType = MediaType> = Extract<
  VideoStream | AudioStream | SubtitleStream,
  {
    type: T;
  }
>;

/**
 * Shared preferences across all preference.
 *
 * @public
 */
export interface BasePreference {
  codec?: string;
}

/**
 * Video preference.
 *
 * @public
 */
export interface VideoPreference extends BasePreference {
  type: MediaType.VIDEO;
}

/**
 * Audio preference.
 *
 * @public
 */
export interface AudioPreference extends BasePreference {
  type: MediaType.AUDIO;
  language?: string;
  channels?: number;
}

/**
 * Subtitle preference.
 *
 * @public
 */
export interface SubtitlePreference extends BasePreference {
  type: MediaType.SUBTITLE;
  language?: string;
}

/**
 * Set of preferences. Discriminated by {@link MediaType}.
 *
 * @public
 */
export type Preference<T extends MediaType = MediaType> = Extract<
  VideoPreference | AudioPreference | SubtitlePreference,
  {
    type: T;
  }
>;

/**
 * Presentation timeline state. The object returned by
 * {@link Player.getTimeline} is stable across calls; its fields
 * compute on read, reflecting the current manifest, config, and
 * media state without caching.
 *
 * @public
 */
export type Timeline = {
  /** Presentation start (DVR start for live). */
  readonly start: number;
  /**
   * Presentation end. For VOD this is the manifest end; for live
   * this is the seekable end (`liveEdge - liveDelay`, clamped to
   * `start`).
   */
  readonly end: number;
  /** Current playhead position, or `0` when no media is attached. */
  readonly currentTime: number;
  /** Seek to time */
  seekTo(time: number): void;
  /** Is live? */
  readonly isLive: boolean;
};
