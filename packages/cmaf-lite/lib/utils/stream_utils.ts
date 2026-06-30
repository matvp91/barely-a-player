import type { DrmConfig, PlayerConfig } from "../config";
import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../constants";
import { normalizeKeyId } from "../drm/drm_utils";
import { KeySystem } from "../types/drm";
import type {
  AudioSwitchingSet,
  Manifest,
  SwitchingSet,
  Track,
  VideoSwitchingSet,
} from "../types/manifest";
import type { Preference, Stream } from "../types/media";
import { MediaType } from "../types/media";
import * as asserts from "./asserts";
import * as CodecUtils from "./codec_utils";
import * as Functional from "./functional";

/** A chosen key system and the access used to create its MediaKeys. */
export interface KeySystemSelection {
  keySystem: KeySystem;
  access: MediaKeySystemAccess;
}

interface RepresentativeSet {
  switchingSet: VideoSwitchingSet | AudioSwitchingSet;
  track: Track;
}

/**
 * Picks one key system for the whole presentation. Runs a single
 * `decodingInfo` probe per candidate, combining a representative video
 * and audio track under one `keySystemConfiguration`. Candidates are
 * the configured `preferredKeySystems` that also appear in the
 * manifest, in preference order; the first supported one wins.
 * Returns `null` for clear content or when nothing is supported.
 */
export async function selectKeySystem(
  manifest: Manifest,
  drm: DrmConfig,
): Promise<KeySystemSelection | null> {
  const protectedSets = manifest.switchingSets.filter(
    (ss): ss is VideoSwitchingSet | AudioSwitchingSet =>
      (ss.type === MediaType.VIDEO || ss.type === MediaType.AUDIO) &&
      ss.protection != null,
  );
  if (protectedSets.length === 0) {
    return null;
  }

  const present = new Set<KeySystem>();
  for (const ss of protectedSets) {
    // biome-ignore lint/style/noNonNullAssertion: filter above guarantees protection != null
    for (const ks of Object.keys(ss.protection!.keySystems)) {
      present.add(ks as KeySystem);
    }
  }

  const video = pickRepresentativeVideo(protectedSets);
  const audio = pickRepresentativeAudio(protectedSets);

  for (const keySystem of drm.preferredKeySystems) {
    if (!present.has(keySystem)) {
      continue;
    }
    const config = buildPresentationDecodingConfig(video, audio, keySystem);
    const info = await navigator.mediaCapabilities.decodingInfo(config);
    if (info.supported && info.keySystemAccess) {
      return { keySystem, access: info.keySystemAccess };
    }
  }
  return null;
}

function pickRepresentativeVideo(
  sets: (VideoSwitchingSet | AudioSwitchingSet)[],
): RepresentativeSet | null {
  let best: RepresentativeSet | null = null;
  for (const ss of sets) {
    if (ss.type !== MediaType.VIDEO) {
      continue;
    }
    for (const track of ss.tracks) {
      if (!best || track.bandwidth > best.track.bandwidth) {
        best = { switchingSet: ss, track };
      }
    }
  }
  return best;
}

function pickRepresentativeAudio(
  sets: (VideoSwitchingSet | AudioSwitchingSet)[],
): RepresentativeSet | null {
  for (const ss of sets) {
    if (ss.type === MediaType.AUDIO && ss.tracks[0]) {
      return { switchingSet: ss, track: ss.tracks[0] };
    }
  }
  return null;
}

function buildPresentationDecodingConfig(
  video: RepresentativeSet | null,
  audio: RepresentativeSet | null,
  keySystem: KeySystem,
): MediaDecodingConfiguration {
  const ksConfig: MediaCapabilitiesKeySystemConfiguration = {
    keySystem,
    initDataType: initDataTypeForKeySystem(keySystem),
    distinctiveIdentifier: "optional",
    persistentState: "optional",
    sessionTypes: ["temporary"],
  };
  const config: MediaDecodingConfiguration = {
    type: "media-source",
    keySystemConfiguration: ksConfig,
  };

  if (video) {
    const contentType = CodecUtils.getContentType(
      MediaType.VIDEO,
      video.switchingSet.codec,
    );
    const track = video.track as Track<MediaType.VIDEO>;
    config.video = {
      contentType,
      width: track.width,
      height: track.height,
      bitrate: track.bandwidth,
      framerate: track.frameRate ?? DEFAULT_VIDEO_FRAMERATE,
    };
    ksConfig.video = { robustness: defaultVideoRobustness(keySystem) };
  }

  if (audio) {
    const contentType = CodecUtils.getContentType(
      MediaType.AUDIO,
      audio.switchingSet.codec,
    );
    const track = audio.track as Track<MediaType.AUDIO>;
    config.audio = {
      contentType,
      bitrate: track.bandwidth,
      channels: String(track.channels ?? DEFAULT_AUDIO_CHANNELS),
      samplerate: track.sampleRate ?? DEFAULT_AUDIO_SAMPLERATE,
    };
    ksConfig.audio = { robustness: defaultAudioRobustness(keySystem) };
  }

  return config;
}

export async function buildStreams(
  manifest: Manifest,
  _config: PlayerConfig,
  selection?: KeySystemSelection | null,
): Promise<Map<MediaType, Stream[]>> {
  const promises: Promise<Stream | null>[] = [];
  for (const switchingSet of manifest.switchingSets) {
    for (const track of switchingSet.tracks) {
      promises.push(buildStream(switchingSet, track, selection ?? null));
    }
  }

  const streams = await Promise.all(promises);
  const result = Functional.groupBy(streams, (s) => s.type);

  // Sorted by bandwidth ascending — index 0 is lowest quality.
  // Required for ABR rules to reason about the quality ladder.
  for (const streams of result.values()) {
    streams.sort((a, b) => a.bandwidth - b.bandwidth);
  }

  return result;
}

export function findStreamsMatchingPreferences(
  type: MediaType,
  streams: Stream[],
  preferences: Preference[],
): Stream[] {
  asserts.assertExists(streams[0], "No Streams");

  for (const preference of preferences) {
    if (preference.type !== type) {
      continue;
    }
    const matches = streams.filter((s) => matchesPreference(s, preference));
    if (matches.length === 0) {
      continue;
    }
    return matches;
  }

  return [];
}

function matchesPreference(stream: Stream, preference: Preference): boolean {
  if (stream.type !== preference.type) {
    throw new Error("Type is not the same for matching");
  }

  // BasePreference comparison
  if (preference.codec !== undefined) {
    if (stream.codec !== preference.codec) {
      return false;
    }
  }

  // TODO(matvp): language/channels matching once those fields
  // are added to AudioStream/SubtitleStream.

  return true;
}

async function buildStream(
  switchingSet: SwitchingSet,
  track: Track,
  selection: KeySystemSelection | null,
): Promise<Stream | null> {
  const codec = CodecUtils.getNormalizedCodec(switchingSet.codec);

  if (
    track.type === MediaType.SUBTITLE &&
    switchingSet.type === MediaType.SUBTITLE
  ) {
    return {
      type: MediaType.SUBTITLE,
      codec,
      bandwidth: track.bandwidth,
      [PROP_HIERARCHY]: { switchingSet, track },
    };
  }

  const info = await probeTrack(track, switchingSet, selection);
  if (!info.supported) {
    return null;
  }

  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    return {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  if (track.type === MediaType.AUDIO && switchingSet.type === MediaType.AUDIO) {
    return {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: switchingSet.language,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}

async function probeTrack(
  track: Track,
  switchingSet: SwitchingSet,
  selection: KeySystemSelection | null,
): Promise<MediaCapabilitiesDecodingInfo> {
  const protection =
    switchingSet.type === MediaType.SUBTITLE ? null : switchingSet.protection;

  if (!protection) {
    return navigator.mediaCapabilities.decodingInfo(
      buildDecodingConfig(track, switchingSet),
    );
  }
  if (!selection) {
    // Protected, but no key system was selected for the presentation —
    // the track cannot be decrypted, so drop it.
    return {
      supported: false,
      smooth: false,
      powerEfficient: false,
      keySystemAccess: null,
    };
  }
  return navigator.mediaCapabilities.decodingInfo(
    buildDecodingConfig(track, switchingSet, selection.keySystem),
  );
}

const DEFAULT_VIDEO_FRAMERATE = 30;
const DEFAULT_AUDIO_CHANNELS = "2";
const DEFAULT_AUDIO_SAMPLERATE = 48_000;

export function buildDecodingConfig(
  track: Track,
  switchingSet: SwitchingSet,
  keySystem?: KeySystem,
): MediaDecodingConfiguration {
  const contentType = CodecUtils.getContentType(track.type, switchingSet.codec);
  let base: MediaDecodingConfiguration;
  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    base = {
      type: "media-source",
      video: {
        contentType,
        width: track.width,
        height: track.height,
        bitrate: track.bandwidth,
        framerate: track.frameRate ?? DEFAULT_VIDEO_FRAMERATE,
      },
    };
  } else if (
    track.type === MediaType.AUDIO &&
    switchingSet.type === MediaType.AUDIO
  ) {
    base = {
      type: "media-source",
      audio: {
        contentType,
        bitrate: track.bandwidth,
        channels: String(track.channels ?? DEFAULT_AUDIO_CHANNELS),
        samplerate: track.sampleRate ?? DEFAULT_AUDIO_SAMPLERATE,
      },
    };
  } else {
    throw new Error(
      `buildDecodingConfig: unsupported track type ${track.type}`,
    );
  }

  if (keySystem !== undefined) {
    const ksConfig: MediaCapabilitiesKeySystemConfiguration = {
      keySystem,
      initDataType: initDataTypeForKeySystem(keySystem),
      distinctiveIdentifier: "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
    };
    const trackCfg: KeySystemTrackConfiguration = {
      robustness:
        track.type === MediaType.VIDEO
          ? defaultVideoRobustness(keySystem)
          : defaultAudioRobustness(keySystem),
    };
    if (track.type === MediaType.VIDEO) {
      ksConfig.video = trackCfg;
    } else {
      ksConfig.audio = trackCfg;
    }
    base.keySystemConfiguration = ksConfig;
  }

  return base;
}

function defaultVideoRobustness(keySystem: KeySystem): string {
  if (keySystem === KeySystem.WIDEVINE) {
    return "SW_SECURE_DECODE";
  }
  if (keySystem === KeySystem.PLAYREADY) {
    return "150";
  }
  return "";
}

function defaultAudioRobustness(keySystem: KeySystem): string {
  if (keySystem === KeySystem.WIDEVINE) {
    return "SW_SECURE_CRYPTO";
  }
  if (keySystem === KeySystem.PLAYREADY) {
    return "150";
  }
  return "";
}

/**
 * EME Initialization Data Format for the probe (and sessions): the
 * key-system init-data format, NOT the encryption scheme. Widevine and
 * PlayReady carry a CENC PSSH box (`"cenc"`) for both cenc- and
 * cbcs-encrypted content; FairPlay carries an `skd://` content id
 * (`"skd"`).
 */
function initDataTypeForKeySystem(keySystem: KeySystem): string {
  return keySystem === KeySystem.FAIRPLAY ? "skd" : "cenc";
}

/**
 * True when a stream's switching set is protected by a key ID present in
 * the restricted set (e.g. `output-restricted` / `internal-error`). Clear
 * and subtitle streams are never restricted.
 */
export function isStreamRestricted(
  stream: Stream,
  restrictedKeyIds: Set<string>,
): boolean {
  if (restrictedKeyIds.size === 0 || stream.type === MediaType.SUBTITLE) {
    return false;
  }
  const protection = stream[PROP_HIERARCHY].switchingSet.protection;
  if (!protection) {
    return false;
  }
  return restrictedKeyIds.has(normalizeKeyId(protection.defaultKid));
}

export function pickClosestByBandwidth(
  streams: Stream[],
  lookupStream: Stream,
): Stream | null {
  if (!streams[0]) {
    return null;
  }
  let best = streams[0];
  let bestDelta = Math.abs(best.bandwidth - lookupStream.bandwidth);
  for (let i = 1; i < streams.length; i++) {
    const candidate = streams[i];
    if (candidate === undefined) {
      break;
    }
    const delta = Math.abs(candidate.bandwidth - lookupStream.bandwidth);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}
