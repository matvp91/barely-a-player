/**
 * Stable error codes surfaced via {@link Events.ERROR}. Only the DRM
 * codes needed today are defined; the surface is general so other
 * subsystems can adopt it without a new event.
 *
 * @public
 */
export enum ErrorCode {
  /** Protected content but no configured key system is usable. */
  NO_SUPPORTED_KEY_SYSTEM = "noSupportedKeySystem",
  /** createMediaKeys, server certificate, or attach failed. */
  MEDIA_KEYS_SETUP_FAILED = "mediaKeysSetupFailed",
  /** The license request never produced a usable response. */
  LICENSE_REQUEST_FAILED = "licenseRequestFailed",
  /** session.update rejected the license response. */
  LICENSE_RESPONSE_REJECTED = "licenseResponseRejected",
  /** Every key in the presentation has expired. */
  ALL_KEYS_EXPIRED = "allKeysExpired",
  /** Key statuses left no playable stream. */
  KEY_STATUS_RESTRICTED = "keyStatusRestricted",
}

/**
 * An error surfaced to the embedding application. `fatal` errors mean
 * playback cannot continue; non-fatal errors are advisory.
 *
 * @public
 */
export interface PlayerError {
  code: ErrorCode;
  fatal: boolean;
  cause?: unknown;
}
