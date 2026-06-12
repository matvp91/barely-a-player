/**
 * Canonical key system identifiers for EME.
 *
 * @public
 */
export enum KeySystem {
  WIDEVINE = "com.widevine.alpha",
  PLAYREADY = "com.microsoft.playready.recommendation",
  FAIRPLAY = "com.apple.fps",
}

/**
 * @public
 */
export enum EncryptionScheme {
  CBCS = "cbcs",
  CENC = "cenc",
}
