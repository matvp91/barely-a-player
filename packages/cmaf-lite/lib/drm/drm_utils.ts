import { KeySystem } from "../types/drm";
import type { KeySystemInfo, Manifest } from "../types/manifest";
import { MediaType } from "../types/media";
import * as StringUtils from "../utils/string_utils";

const KEY_SYSTEM_BY_UUID: Record<string, KeySystem> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": KeySystem.WIDEVINE,
  "9a04f079-9840-4286-ab92-e65be0885f95": KeySystem.PLAYREADY,
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": KeySystem.FAIRPLAY,
};

/** True when any audio/video switching set carries protection. */
export function hasProtectedContent(manifest: Manifest): boolean {
  return manifest.switchingSets.some(
    (ss) =>
      (ss.type === MediaType.VIDEO || ss.type === MediaType.AUDIO) &&
      ss.protection != null,
  );
}

/**
 * Maps a `urn:uuid:<uuid>` schemeIdUri to a canonical {@link KeySystem},
 * or `null` if the UUID is not a key system we support.
 */
export function keySystemFromSchemeIdUri(uri: string): KeySystem | null {
  const match = /^urn:uuid:([0-9a-f-]+)$/i.exec(uri);
  if (!match) {
    return null;
  }
  const uuid = match[1]?.toLowerCase();
  if (!uuid) {
    return null;
  }
  return KEY_SYSTEM_BY_UUID[uuid] ?? null;
}

/**
 * Builds a {@link KeySystemInfo} from the raw strings extracted from
 * a key-system `<ContentProtection>` element. FairPlay carries a
 * `skd://` content identifier (in `value=` or in a child); other key
 * systems carry a base64 PSSH blob inside `<cenc:pssh>`. Returns an
 * empty object when nothing usable is present.
 */
export function keySystemInfoFromRaw(
  keySystem: KeySystem,
  value: string | undefined,
  psshText: string | undefined,
): KeySystemInfo {
  if (keySystem === KeySystem.FAIRPLAY) {
    if (value?.startsWith("skd://")) {
      return { contentId: value };
    }
    if (psshText?.startsWith("skd://")) {
      return { contentId: psshText };
    }
    return {};
  }
  if (!psshText) {
    return {};
  }
  const trimmedPsshText = psshText.trim();
  return {
    pssh: StringUtils.decodeBase64(trimmedPsshText),
  };
}

/**
 * Verdict from a batch of key statuses. `restrictedKeyIds` holds the
 * normalized (dashless, lowercase hex) key IDs whose keys cannot be used
 * for playback.
 */
export interface KeyStatusVerdict {
  allExpired: boolean;
  restrictedKeyIds: Set<string>;
}

/**
 * Classifies a merged key-status map. `expired` across the board is fatal
 * (handled by the caller); `internal-error`/`output-restricted` keys
 * restrict their streams; every other status is usable.
 */
export function classifyKeyStatuses(
  statuses: Map<string, MediaKeyStatus>,
): KeyStatusVerdict {
  const restrictedKeyIds = new Set<string>();
  let allExpired = statuses.size > 0;
  for (const [keyId, status] of statuses) {
    if (status !== "expired") {
      allExpired = false;
    }
    if (status === "internal-error" || status === "output-restricted") {
      restrictedKeyIds.add(keyId);
    }
  }
  return { allExpired, restrictedKeyIds };
}

/** Normalizes a key ID to dashless lowercase hex for comparison. */
export function normalizeKeyId(keyId: string): string {
  return keyId.replace(/-/g, "").toLowerCase();
}
