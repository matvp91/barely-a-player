import { afterEach, describe, expect, it, vi } from "vitest";
import { PROP_HIERARCHY } from "../../lib/constants";
import { Events } from "../../lib/events";
import { Player } from "../../lib/player";
import { KeySystem } from "../../lib/types/drm";
import { ErrorCode } from "../../lib/types/error";
import type { Stream } from "../../lib/types/media";
import { MediaType } from "../../lib/types/media";
import {
  createFakeKeySystemAccess,
  FakeMediaElement,
  FakeMediaKeys,
} from "../__framework__/eme";
import {
  createAudioSwitchingSet,
  createManifest,
  createProtection,
  createVideoSwitchingSet,
} from "../__framework__/factories";

// Build a player whose manifest/streams/media report protected content with
// the given key system access. Uses the real EmeController via the Player ctor.
const protectedPlayer = (
  keySystem: string,
  mediaKeys = new FakeMediaKeys(),
) => {
  const player = new Player();
  const access = createFakeKeySystemAccess(keySystem, mediaKeys);
  const pssh = new Uint8Array([1, 2, 3, 4]);
  const manifest = createManifest({
    switchingSets: [
      createVideoSwitchingSet({
        protection: createProtection({
          keySystems: { [keySystem as KeySystem]: { pssh } },
        }),
      }),
    ],
  });
  vi.spyOn(player, "getManifest").mockReturnValue(manifest);
  vi.spyOn(player, "getKeySystemAccess").mockReturnValue(access);
  return { player, access, mediaKeys, manifest, pssh };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmeController", () => {
  it("does nothing for clear content (no key system access)", async () => {
    const player = new Player();
    vi.spyOn(player, "getKeySystemAccess").mockReturnValue(null);
    vi.spyOn(player, "getManifest").mockReturnValue(createManifest());
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await Promise.resolve();
    expect(media.setMediaKeysCalls).toHaveLength(0);
  });

  it("creates a manifest PSSH session and attaches eagerly for Widevine", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    // Allow activate_ microtasks to settle.
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    expect(media.setMediaKeysCalls.at(-1)).toBe(mediaKeys as unknown);
    expect(
      Array.from(
        new Uint8Array(mediaKeys.sessions[0]!.generateRequestArgs[0]!.initData),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("defers attach to the encrypted event for FairPlay", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.FAIRPLAY);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await Promise.resolve();
    await Promise.resolve();
    // No eager attach, no manifest session for FairPlay.
    expect(media.setMediaKeysCalls).toHaveLength(0);
    expect(mediaKeys.sessions).toHaveLength(0);
    // The encrypted event drives attach + session creation.
    media.emitEncrypted("skd", new Uint8Array([9, 9]));
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    expect(media.setMediaKeysCalls.at(-1)).toBe(mediaKeys as unknown);
  });

  it("POSTs the license challenge and feeds the response to the session", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
    player.setConfig("drm.licenseUrls", {
      [KeySystem.WIDEVINE]: "https://lic.test",
    });
    const responseBytes = new Uint8Array([42]);
    const net = player.getNetworkService();
    vi.spyOn(net, "request").mockReturnValue({
      promise: Promise.resolve({ arrayBuffer: responseBytes.buffer }),
    } as never);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    mediaKeys.sessions[0]!.emitMessage(new Uint8Array([1]));
    await vi.waitFor(() =>
      expect(mediaKeys.sessions[0]!.updateArgs).toHaveLength(1),
    );
    expect(
      Array.from(new Uint8Array(mediaKeys.sessions[0]!.updateArgs[0]!)),
    ).toEqual([42]);
  });

  it("emits KEY_SESSION_CREATED with the key system and session id", async () => {
    const { player } = protectedPlayer(KeySystem.WIDEVINE);
    const created = vi.fn();
    player.on(Events.KEY_SESSION_CREATED, created);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(created.mock.calls[0]![0]).toMatchObject({
      keySystem: KeySystem.WIDEVINE,
    });
  });

  it("emits a fatal ERROR when no license URL is configured", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
    const onError = vi.fn();
    player.on(Events.ERROR, onError);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    mediaKeys.sessions[0]!.emitMessage(new Uint8Array([1]));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0]).toMatchObject({
      code: ErrorCode.LICENSE_REQUEST_FAILED,
      fatal: true,
    });
  });

  it("emits KEY_STATUSES_CHANGED on keystatuseschange", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
    const changed = vi.fn();
    player.on(Events.KEY_STATUSES_CHANGED, changed);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    mediaKeys.sessions[0]!.setKeyStatus("aa", "usable");
    mediaKeys.sessions[0]!.emitKeyStatusesChange();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]![0].statuses.get("aa")).toBe("usable");
    expect(changed.mock.calls[0]![0].sessionId).toBe(
      mediaKeys.sessions[0]!.sessionId,
    );
  });

  it("emits a fatal ALL_KEYS_EXPIRED after the batch settles when all keys expired", async () => {
    vi.useFakeTimers();
    try {
      const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
      const onError = vi.fn();
      player.on(Events.ERROR, onError);
      const media = new FakeMediaElement();
      player.emit(Events.STREAMS_CREATED);
      player.emit(Events.MEDIA_ATTACHED, {
        media: media as unknown as HTMLMediaElement,
        mediaSource: {} as MediaSource,
      });
      await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
      mediaKeys.sessions[0]!.setKeyStatus("aa", "expired");
      mediaKeys.sessions[0]!.emitKeyStatusesChange();
      await vi.advanceTimersByTimeAsync(500);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0]).toMatchObject({
        code: ErrorCode.ALL_KEYS_EXPIRED,
        fatal: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records restricted key ids and emits RESTRICTIONS_UPDATED without going fatal when a playable stream remains", async () => {
    vi.useFakeTimers();
    try {
      const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
      // A non-restricted clear stream remains playable.
      vi.spyOn(player, "getStreams").mockReturnValue([] as never);
      const onError = vi.fn();
      const onRestrictions = vi.fn();
      player.on(Events.ERROR, onError);
      player.on(Events.RESTRICTIONS_UPDATED, onRestrictions);
      const media = new FakeMediaElement();
      player.emit(Events.STREAMS_CREATED);
      player.emit(Events.MEDIA_ATTACHED, {
        media: media as unknown as HTMLMediaElement,
        mediaSource: {} as MediaSource,
      });
      await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
      mediaKeys.sessions[0]!.setKeyStatus("dd", "output-restricted");
      mediaKeys.sessions[0]!.emitKeyStatusesChange();
      await vi.advanceTimersByTimeAsync(500);
      expect(player.getRestrictedKeyIds().has("dd")).toBe(true);
      expect(onRestrictions).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the encrypted event when manifest has no PSSH for the key system", async () => {
    const mediaKeys = new FakeMediaKeys();
    const player = new Player();
    const access = createFakeKeySystemAccess(KeySystem.WIDEVINE, mediaKeys);
    vi.spyOn(player, "getKeySystemAccess").mockReturnValue(access);
    // Protected, but no pssh for Widevine (only default_KID in practice).
    vi.spyOn(player, "getManifest").mockReturnValue(
      createManifest({
        switchingSets: [
          createVideoSwitchingSet({
            protection: createProtection({
              keySystems: { [KeySystem.WIDEVINE]: {} },
            }),
          }),
        ],
      }),
    );
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    // Eager attach happened, but no manifest session.
    await vi.waitFor(() => expect(media.setMediaKeysCalls).toHaveLength(1));
    expect(mediaKeys.sessions).toHaveLength(0);
    // The encrypted event now creates the session.
    media.emitEncrypted("cenc", new Uint8Array([5, 5]));
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
  });

  it("creates sessions for new PSSH on manifest update (key rotation)", async () => {
    const { player, mediaKeys, manifest } = protectedPlayer(KeySystem.WIDEVINE);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    // Rotate: same switching set gains a new PSSH.
    const ss = manifest.switchingSets[0] as Extract<
      (typeof manifest.switchingSets)[number],
      { protection?: unknown }
    >;
    ss.protection!.keySystems[KeySystem.WIDEVINE] = {
      pssh: new Uint8Array([7, 7, 7]),
    };
    player.emit(Events.MANIFEST_UPDATED, { manifest, isUpdate: true });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(2));
  });

  it("emits NO_SUPPORTED_KEY_SYSTEM for protected content with no usable key system", async () => {
    const player = new Player();
    vi.spyOn(player, "getKeySystemAccess").mockReturnValue(null);
    vi.spyOn(player, "getManifest").mockReturnValue(
      createManifest({
        switchingSets: [
          createVideoSwitchingSet({ protection: createProtection() }),
        ],
      }),
    );
    const onError = vi.fn();
    player.on(Events.ERROR, onError);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatchObject({
      code: ErrorCode.NO_SUPPORTED_KEY_SYSTEM,
      fatal: true,
    });
  });

  it("does not go fatal when only audio is fully restricted but video remains playable", async () => {
    vi.useFakeTimers();
    try {
      const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
      // Restricted audio key id: "dd". Video stream uses a different key.
      const audioStream: Stream<MediaType.AUDIO> = {
        type: MediaType.AUDIO,
        codec: "mp4a.40.2",
        bandwidth: 128_000,
        language: "unk",
        [PROP_HIERARCHY]: {
          switchingSet: createAudioSwitchingSet({
            protection: createProtection({ defaultKid: "dd" }),
          }),
          track: {
            id: "a1",
            type: MediaType.AUDIO,
            bandwidth: 128_000,
            segments: [],
            maxSegmentDuration: 4,
          },
        },
        [Symbol("decodingInfo")]: {} as MediaCapabilitiesDecodingInfo,
      } as unknown as Stream<MediaType.AUDIO>;
      const videoStream: Stream<MediaType.VIDEO> = {
        type: MediaType.VIDEO,
        codec: "avc1.64001f",
        bandwidth: 2_000_000,
        width: 1920,
        height: 1080,
        [PROP_HIERARCHY]: {
          switchingSet: createVideoSwitchingSet({
            protection: createProtection({ defaultKid: "ee" }),
          }),
          track: {
            id: "v1",
            type: MediaType.VIDEO,
            bandwidth: 2_000_000,
            width: 1920,
            height: 1080,
            segments: [],
            maxSegmentDuration: 4,
          },
        },
        [Symbol("decodingInfo")]: {} as MediaCapabilitiesDecodingInfo,
      } as unknown as Stream<MediaType.VIDEO>;
      vi.spyOn(player, "getStreams").mockImplementation((type) => {
        if (type === MediaType.AUDIO) {
          return [audioStream] as never;
        }
        if (type === MediaType.VIDEO) {
          return [videoStream] as never;
        }
        return [] as never;
      });
      const onError = vi.fn();
      const onRestrictions = vi.fn();
      player.on(Events.ERROR, onError);
      player.on(Events.RESTRICTIONS_UPDATED, onRestrictions);
      const media = new FakeMediaElement();
      player.emit(Events.STREAMS_CREATED);
      player.emit(Events.MEDIA_ATTACHED, {
        media: media as unknown as HTMLMediaElement,
        mediaSource: {} as MediaSource,
      });
      await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
      // Restrict the audio key only.
      mediaKeys.sessions[0]!.setKeyStatus("dd", "output-restricted");
      mediaKeys.sessions[0]!.emitKeyStatusesChange();
      await vi.advanceTimersByTimeAsync(500);
      expect(onRestrictions).toHaveBeenCalled();
      expect(player.getRestrictedKeyIds().has("dd")).toBe(true);
      // Video is still playable — must NOT be fatal.
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes fatal when both audio and video are fully restricted", async () => {
    vi.useFakeTimers();
    try {
      const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
      const audioStream: Stream<MediaType.AUDIO> = {
        type: MediaType.AUDIO,
        codec: "mp4a.40.2",
        bandwidth: 128_000,
        language: "unk",
        [PROP_HIERARCHY]: {
          switchingSet: createAudioSwitchingSet({
            protection: createProtection({ defaultKid: "dd" }),
          }),
          track: {
            id: "a1",
            type: MediaType.AUDIO,
            bandwidth: 128_000,
            segments: [],
            maxSegmentDuration: 4,
          },
        },
        [Symbol("decodingInfo")]: {} as MediaCapabilitiesDecodingInfo,
      } as unknown as Stream<MediaType.AUDIO>;
      const videoStream: Stream<MediaType.VIDEO> = {
        type: MediaType.VIDEO,
        codec: "avc1.64001f",
        bandwidth: 2_000_000,
        width: 1920,
        height: 1080,
        [PROP_HIERARCHY]: {
          switchingSet: createVideoSwitchingSet({
            protection: createProtection({ defaultKid: "ee" }),
          }),
          track: {
            id: "v1",
            type: MediaType.VIDEO,
            bandwidth: 2_000_000,
            width: 1920,
            height: 1080,
            segments: [],
            maxSegmentDuration: 4,
          },
        },
        [Symbol("decodingInfo")]: {} as MediaCapabilitiesDecodingInfo,
      } as unknown as Stream<MediaType.VIDEO>;
      vi.spyOn(player, "getStreams").mockImplementation((type) => {
        if (type === MediaType.AUDIO) {
          return [audioStream] as never;
        }
        if (type === MediaType.VIDEO) {
          return [videoStream] as never;
        }
        return [] as never;
      });
      const onError = vi.fn();
      player.on(Events.ERROR, onError);
      const media = new FakeMediaElement();
      player.emit(Events.STREAMS_CREATED);
      player.emit(Events.MEDIA_ATTACHED, {
        media: media as unknown as HTMLMediaElement,
        mediaSource: {} as MediaSource,
      });
      await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
      // Restrict both keys: audio "dd" and video "ee".
      mediaKeys.sessions[0]!.setKeyStatus("dd", "output-restricted");
      mediaKeys.sessions[0]!.setKeyStatus("ee", "output-restricted");
      mediaKeys.sessions[0]!.emitKeyStatusesChange();
      await vi.advanceTimersByTimeAsync(500);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0]).toMatchObject({
        code: ErrorCode.KEY_STATUS_RESTRICTED,
        fatal: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("POSTs with PlayReady Content-Type header wired through onSessionMessage_", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.PLAYREADY);
    player.setConfig("drm.licenseUrls", {
      [KeySystem.PLAYREADY]: "https://lic.playready.test",
    });
    let capturedHeaders: Headers | undefined;
    const net = player.getNetworkService();
    vi.spyOn(net, "request").mockImplementation(
      (_type, _url, _abortSignal, init) => {
        capturedHeaders = (init as { headers?: Headers }).headers;
        return {
          promise: Promise.resolve({ arrayBuffer: new Uint8Array([1]).buffer }),
        } as never;
      },
    );
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(1));
    // Emit a plain (non-envelope) message — buildPlayReadyRequest returns
    // body unchanged and defaults headers to text/xml; charset=utf-8.
    mediaKeys.sessions[0]!.emitMessage(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(capturedHeaders).toBeDefined());
    expect(capturedHeaders!.get("Content-Type")).toBe(
      "text/xml; charset=utf-8",
    );
  });

  it("treats a license failure as non-fatal when other sessions are active", async () => {
    // Two PSSH entries → two sessions.
    const mediaKeys = new FakeMediaKeys();
    const player = new Player();
    const access = createFakeKeySystemAccess(KeySystem.WIDEVINE, mediaKeys);
    vi.spyOn(player, "getKeySystemAccess").mockReturnValue(access);
    vi.spyOn(player, "getManifest").mockReturnValue(
      createManifest({
        switchingSets: [
          createVideoSwitchingSet({
            protection: createProtection({
              keySystems: {
                [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) },
              },
            }),
          }),
          createAudioSwitchingSet({
            protection: createProtection({
              keySystems: {
                [KeySystem.WIDEVINE]: { pssh: new Uint8Array([2]) },
              },
            }),
          }),
        ],
      }),
    );
    player.setConfig("drm.licenseUrls", {
      [KeySystem.WIDEVINE]: "https://lic.test",
    });
    const rejection = Promise.reject(new Error("network down"));
    rejection.catch(() => {});
    vi.spyOn(player.getNetworkService(), "request").mockReturnValue({
      promise: rejection,
    } as never);
    const onError = vi.fn();
    player.on(Events.ERROR, onError);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(2));
    mediaKeys.sessions[0]!.emitMessage(new Uint8Array([9]));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0]).toMatchObject({
      code: ErrorCode.LICENSE_REQUEST_FAILED,
      fatal: false,
    });
  });
});
