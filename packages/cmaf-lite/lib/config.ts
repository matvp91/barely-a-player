import { KeySystem } from "./types/drm";
import type { Path, PathValue } from "./types/helpers";
import type { Preference } from "./types/media";
import type { NetworkRequestOptions } from "./types/net";

/**
 * Dot-notation paths for PlayerConfig.
 *
 * @public
 */
export type ConfigPath = Path<PlayerConfig>;

/**
 * Value at a given config path.
 *
 * @public
 */
export type ConfigPathValue<P extends ConfigPath> = PathValue<PlayerConfig, P>;

/**
 * ABR configuration.
 *
 * @public
 */
export interface AbrConfig {
  /**
   * Initial bandwidth estimate in bits/s, used before the EWMA
   * estimator has seen any samples.
   */
  defaultBandwidthEstimate: number;
  /**
   * Bandwidth fraction required to upgrade to a higher quality.
   * Lower values make upgrades harder (resists oscillation).
   */
  bandwidthUpgradeTarget: number;
  /**
   * Bandwidth fraction that triggers a downgrade below current
   * quality.
   */
  bandwidthDowngradeTarget: number;
  /**
   * Minimum seconds between consecutive `ADAPTATION` emits. The ABR
   * evaluator runs on a fixed 1-second tick; this throttle gates the
   * actual switch decision so users don't see rapid quality flips.
   */
  switchInterval: number;
  /** EWMA fast estimator half-life in seconds. */
  fastHalfLife: number;
  /** EWMA slow estimator half-life in seconds. */
  slowHalfLife: number;
  /**
   * Minimum bytes of real samples before switching from
   * `defaultBandwidthEstimate` to the EWMA estimate.
   */
  minTotalBytes: number;
}

/**
 * DRM configuration.
 *
 * @public
 */
export interface DrmConfig {
  /**
   * Order in which to probe key systems for protected content.
   * The first key system supported on the device (and present in
   * the manifest) is selected.
   */
  preferredKeySystems: KeySystem[];
  /** License server URL per key system. */
  licenseUrls: Partial<Record<KeySystem, string>>;
  /**
   * Server certificate per key system, applied before the first
   * license challenge.
   */
  serverCertificates: Partial<Record<KeySystem, Uint8Array>>;
}

/**
 * Player configuration. Override defaults via
 * `Player.setConfig`.
 *
 * @public
 */
export interface PlayerConfig {
  /**
   * Maximum seconds of media to buffer ahead of the
   * playback position.
   */
  frontBufferLength: number;
  /**
   * Maximum seconds of media to retain behind the
   * playback position. Set to `Infinity` to keep all
   * played data.
   */
  backBufferLength: number;
  /**
   * Extra seconds added to {@link PlayerConfig.backBufferLength} when
   * evicting data under a QuotaExceededError.
   */
  backBufferQuotaPadding: number;
  /**
   * Maximum gap in seconds between buffered ranges that
   * the player will automatically skip over.
   */
  maxBufferHole: number;
  /**
   * Tolerance in seconds when matching the playback
   * position to a segment's time range.
   */
  maxSegmentLookupTolerance: number;
  /**
   * Seconds behind the live edge to start playback for live presentations.
   * Ignored for on-demand manifests.
   */
  liveDelay: number;
  /**
   * Seconds between manifest refreshes for live presentations. Actual
   * cadence is `liveUpdateTime + fetchDuration` because refreshes are
   * scheduled after each response lands.
   */
  liveUpdateTime: number;
  /** Network options for manifest requests. */
  manifestRequestOptions: NetworkRequestOptions;
  /** Network options for segment requests. */
  segmentRequestOptions: NetworkRequestOptions;
  /** ABR configuration. */
  abr: AbrConfig;
  /** Preferences */
  preferences: Preference[];
  /** DRM configuration. */
  drm: DrmConfig;
}

/**
 * Default config.
 *
 * @public
 */
export const DEFAULT_CONFIG: PlayerConfig = {
  frontBufferLength: 30,
  backBufferLength: Infinity,
  backBufferQuotaPadding: 2,
  maxBufferHole: 0.1,
  maxSegmentLookupTolerance: 0.25,
  liveDelay: 20,
  liveUpdateTime: 2,
  manifestRequestOptions: {
    maxAttempts: 3,
    delay: 1000,
  },
  segmentRequestOptions: {
    maxAttempts: 3,
    delay: 500,
  },
  abr: {
    defaultBandwidthEstimate: 1_000_000,
    bandwidthUpgradeTarget: 0.7,
    bandwidthDowngradeTarget: 0.95,
    switchInterval: 8,
    fastHalfLife: 3,
    slowHalfLife: 9,
    minTotalBytes: 128_000,
  },
  preferences: [],
  drm: {
    preferredKeySystems: [
      KeySystem.FAIRPLAY,
      KeySystem.WIDEVINE,
      KeySystem.PLAYREADY,
    ],
    licenseUrls: {},
    serverCertificates: {},
  },
};
