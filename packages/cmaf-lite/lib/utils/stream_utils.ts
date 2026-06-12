import type { DrmConfig, PlayerConfig } from "../config";
import {
  PROP_DECODING_INFO,
  PROP_HIERARCHY,
  PROP_KEY_SYSTEM_ACCESS,
} from "../constants";
import { KeySystem } from "../types/drm";
import type { Manifest, SwitchingSet, Track } from "../types/manifest";
import type {
  AudioStream,
  Preference,
  Stream,
  VideoStream,
} from "../types/media";
import { MediaType } from "../types/media";
import * as asserts from "./asserts";
import * as CodecUtils from "./codec_utils";
import * as Functional from "./functional";

export async function buildStreams(
  manifest: Manifest,
  config: PlayerConfig,
): Promise<Map<MediaType, Stream[]>> {
  const promises: Promise<Stream | null>[] = [];
  for (const switchingSet of manifest.switchingSets) {
    for (const track of switchingSet.tracks) {
      promises.push(buildStream(switchingSet, track, config));
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
  config: PlayerConfig,
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

  const info = await probeTrack(track, switchingSet, config);
  if (!info.supported) {
    return null;
  }

  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    const stream: VideoStream = {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
    if (info.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = info.keySystemAccess;
    }
    return stream;
  }
  if (track.type === MediaType.AUDIO && switchingSet.type === MediaType.AUDIO) {
    const stream: AudioStream = {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: switchingSet.language,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
    if (info.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = info.keySystemAccess;
    }
    return stream;
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}

async function probeTrack(
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<MediaCapabilitiesDecodingInfo> {
  const candidates = candidateKeySystems(switchingSet, config.drm);
  if (candidates.length === 0) {
    return navigator.mediaCapabilities.decodingInfo(
      buildDecodingConfig(track, switchingSet),
    );
  }
  let last: MediaCapabilitiesDecodingInfo | null = null;
  for (const keySystem of candidates) {
    const info = await navigator.mediaCapabilities.decodingInfo(
      buildDecodingConfig(track, switchingSet, keySystem),
    );
    if (info.supported) {
      return info;
    }
    last = info;
  }
  return (
    last ?? {
      supported: false,
      smooth: false,
      powerEfficient: false,
      keySystemAccess: null,
    }
  );
}

function candidateKeySystems(
  switchingSet: SwitchingSet,
  drm: DrmConfig,
): KeySystem[] {
  if (
    switchingSet.type === MediaType.AUDIO ||
    switchingSet.type === MediaType.VIDEO
  ) {
    return [...drm.preferredKeySystems];
  }
  return [];
}

const DEFAULT_VIDEO_FRAMERATE = 30;
const DEFAULT_AUDIO_CHANNELS = "2";
const DEFAULT_AUDIO_SAMPLERATE = 48_000;

type KeySystemProbeConfig = MediaKeySystemConfiguration & {
  keySystem: string;
};

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
    const cap: MediaKeySystemMediaCapability = {
      contentType,
      robustness: defaultRobustness(keySystem),
    };
    const ksConfig: KeySystemProbeConfig = {
      keySystem,
      initDataTypes: ["cenc"],
      distinctiveIdentifier: "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
    };
    if (track.type === MediaType.VIDEO) {
      ksConfig.videoCapabilities = [cap];
    } else {
      ksConfig.audioCapabilities = [cap];
    }
    (
      base as MediaDecodingConfiguration & {
        keySystemConfiguration: KeySystemProbeConfig;
      }
    ).keySystemConfiguration = ksConfig;
  }

  return base;
}

function defaultRobustness(keySystem: KeySystem): string {
  if (keySystem === KeySystem.WIDEVINE) {
    return "SW_SECURE_CRYPTO";
  }
  if (keySystem === KeySystem.PLAYREADY) {
    return "150";
  }
  return "";
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
