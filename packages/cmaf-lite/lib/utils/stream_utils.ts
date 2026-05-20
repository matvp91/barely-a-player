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

  const maybeStreams = await Promise.all(promises);
  const streams = maybeStreams.filter((s): s is Stream => s !== null);

  const result = new Map<MediaType, Stream[]>([
    [MediaType.VIDEO, []],
    [MediaType.AUDIO, []],
    [MediaType.SUBTITLE, []],
  ]);
  for (const stream of streams) {
    const list = result.get(stream.type);
    asserts.assertExists(list, `No list for ${stream.type}`);
    list.push(stream);
  }

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
  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    const probe = await probeDecodingInfo(
      switchingSet.codec,
      track,
      switchingSet,
      config,
    );
    if (!probe.info.supported) {
      return null;
    }
    const stream: VideoStream = {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: probe.info,
    };
    if (probe.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = probe.keySystemAccess;
    }
    return stream;
  }
  if (track.type === MediaType.AUDIO && switchingSet.type === MediaType.AUDIO) {
    const probe = await probeDecodingInfo(
      switchingSet.codec,
      track,
      switchingSet,
      config,
    );
    if (!probe.info.supported) {
      return null;
    }
    const stream: AudioStream = {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: switchingSet.language,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: probe.info,
    };
    if (probe.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = probe.keySystemAccess;
    }
    return stream;
  }
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
  throw new Error(`Failed to map track for type ${track.type}`);
}

type DecodingProbe = {
  info: MediaCapabilitiesDecodingInfo;
  keySystemAccess?: MediaKeySystemAccess;
};

async function probeDecodingInfo(
  codec: string,
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<DecodingProbe> {
  const candidates = candidateKeySystems(switchingSet, config.drm);
  if (candidates.length === 0) {
    const info = await probeOnce(codec, track, undefined);
    return { info };
  }
  for (const keySystem of candidates) {
    const config = buildKeySystemConfig(keySystem, switchingSet, track);
    const info = await probeOnce(codec, track, config);
    if (info.supported) {
      return { info, keySystemAccess: info.keySystemAccess ?? undefined };
    }
  }
  return {
    info: {
      supported: false,
      smooth: false,
      powerEfficient: false,
      keySystemAccess: null,
    },
  };
}

function candidateKeySystems(
  switchingSet: SwitchingSet,
  drm: DrmConfig,
): KeySystem[] {
  if (!switchingSet.protection) {
    return [];
  }
  const present = switchingSet.protection.keySystems;
  return drm.preferredKeySystems.filter((ks) => present[ks] !== undefined);
}

type KeySystemProbeConfig = MediaKeySystemConfiguration & {
  keySystem: string;
};

function buildKeySystemConfig(
  keySystem: KeySystem,
  switchingSet: SwitchingSet,
  track: Track,
): KeySystemProbeConfig {
  const contentType =
    track.type === MediaType.VIDEO
      ? `video/mp4; codecs="${switchingSet.codec}"`
      : `audio/mp4; codecs="${switchingSet.codec}"`;
  const cap: MediaKeySystemMediaCapability = {
    contentType,
    robustness: defaultRobustness(keySystem),
  };
  const config: KeySystemProbeConfig = {
    keySystem,
    initDataTypes: ["cenc"],
    distinctiveIdentifier: "optional",
    persistentState: "optional",
    sessionTypes: ["temporary"],
  };
  if (track.type === MediaType.VIDEO) {
    config.videoCapabilities = [cap];
  } else {
    config.audioCapabilities = [cap];
  }
  return config;
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

async function probeOnce(
  codec: string,
  track: Track,
  keySystemConfiguration: KeySystemProbeConfig | undefined,
): Promise<MediaCapabilitiesDecodingInfo> {
  const base: MediaDecodingConfiguration =
    track.type === MediaType.VIDEO
      ? {
          type: "media-source",
          video: {
            contentType: `video/mp4; codecs="${codec}"`,
            width: track.width,
            height: track.height,
            bitrate: track.bandwidth,
            framerate: 30,
          },
        }
      : {
          type: "media-source",
          audio: {
            contentType: `audio/mp4; codecs="${codec}"`,
            bitrate: track.bandwidth,
            channels: "2",
            samplerate: 48000,
          },
        };
  if (keySystemConfiguration) {
    (
      base as MediaDecodingConfiguration & {
        keySystemConfiguration: KeySystemProbeConfig;
      }
    ).keySystemConfiguration = keySystemConfiguration;
  }
  return navigator.mediaCapabilities.decodingInfo(base);
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
