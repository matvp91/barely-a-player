import { PROP_KEY_SYSTEM_ACCESS } from "../constants";
import type { MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import { KeySystem } from "../types/drm";
import type { Manifest } from "../types/manifest";
import { MediaType } from "../types/media";
import { ABORTED, NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import { unwrapPlayReadyChallenge } from "../utils/playready_utils";

const log = Log.create("EmeController");

/**
 * Owns the MediaKeys lifecycle for protected presentations.
 * Dormant for clear content — when no stream carries
 * `PROP_KEY_SYSTEM_ACCESS`, no MediaKeys are created and no DOM
 * listeners are attached.
 */
export class EmeController {
  private manifest_: Manifest | null = null;
  private media_: HTMLMediaElement | null = null;
  private mediaKeys_: MediaKeys | null = null;
  private mediaKeysAttached_ = false;
  private keySystem_: KeySystem | null = null;
  private activeSessions_ = new Set<MediaKeySession>();
  private psshSeen_ = new Set<string>();
  private onEncrypted_: ((ev: Event) => void) | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_LOADING, this.onManifestLoading_);
    this.player_.on(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);
  }

  destroy() {
    void this.teardown_();
    this.player_.off(Events.MANIFEST_LOADING, this.onManifestLoading_);
    this.player_.off(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
  }

  private onManifestLoading_ = () => {
    this.manifest_ = null;
  };

  private onStreamsCreated_ = () => {
    this.manifest_ = this.player_.getManifest();
    this.maybeActivate_();
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.maybeActivate_();
  };

  private onMediaDetaching_ = () => {
    void this.teardown_();
  };

  private maybeActivate_() {
    if (!this.manifest_ || !this.media_) {
      return;
    }
    const access = this.findKeySystemAccess_();
    if (!access) {
      return;
    }
    if (this.mediaKeys_) {
      return;
    }
    void this.activate_(access);
  }

  private findKeySystemAccess_(): MediaKeySystemAccess | null {
    for (const type of [MediaType.VIDEO, MediaType.AUDIO] as const) {
      const streams = this.player_.getStreams(type);
      for (const stream of streams) {
        const access = stream[PROP_KEY_SYSTEM_ACCESS];
        if (access) {
          return access;
        }
      }
    }
    return null;
  }

  private async activate_(access: MediaKeySystemAccess) {
    try {
      this.keySystem_ = access.keySystem as KeySystem;
      this.mediaKeys_ = await access.createMediaKeys();

      const cert =
        this.player_.getConfig().drm.serverCertificates[this.keySystem_];
      if (cert) {
        await this.mediaKeys_.setServerCertificate(toArrayBuffer(cert));
      }

      if (this.keySystem_ === KeySystem.FAIRPLAY) {
        this.attachEncryptedListener_();
      } else {
        await this.attachMediaKeys_();
        this.createSessionsFromManifest_();
      }
    } catch (err) {
      this.emitError_(err);
    }
  }

  private async attachMediaKeys_() {
    if (this.mediaKeysAttached_ || !this.media_ || !this.mediaKeys_) {
      return;
    }
    await this.media_.setMediaKeys(this.mediaKeys_);
    this.mediaKeysAttached_ = true;
  }

  private attachEncryptedListener_() {
    if (!this.media_) {
      return;
    }
    this.onEncrypted_ = (event: Event) => {
      void this.handleEncryptedEvent_(event as MediaEncryptedEvent);
    };
    this.media_.addEventListener("encrypted", this.onEncrypted_);
  }

  private async handleEncryptedEvent_(event: MediaEncryptedEvent) {
    try {
      await this.attachMediaKeys_();
      if (!event.initData) {
        return;
      }
      await this.createSession_(
        event.initDataType,
        new Uint8Array(event.initData),
      );
    } catch (err) {
      this.emitError_(err);
    }
  }

  private createSessionsFromManifest_() {
    if (!this.manifest_ || !this.keySystem_) {
      return;
    }
    for (const ss of this.manifest_.switchingSets) {
      if (ss.type !== MediaType.VIDEO && ss.type !== MediaType.AUDIO) {
        continue;
      }
      const info = ss.protection?.keySystems[this.keySystem_];
      if (!info?.pssh) {
        continue;
      }
      const fingerprint = bytesFingerprint(info.pssh);
      if (this.psshSeen_.has(fingerprint)) {
        continue;
      }
      this.psshSeen_.add(fingerprint);
      void this.createSession_("cenc", info.pssh);
    }
  }

  private async createSession_(initDataType: string, initData: Uint8Array) {
    if (!this.mediaKeys_ || !this.keySystem_) {
      return;
    }
    const session = this.mediaKeys_.createSession("temporary");
    this.activeSessions_.add(session);

    session.addEventListener("message", (ev) => {
      void this.handleSessionMessage_(session, ev as MediaKeyMessageEvent);
    });
    session.addEventListener("keystatuseschange", () => {
      this.handleKeyStatusesChange_(session);
    });

    await session.generateRequest(initDataType, toArrayBuffer(initData));

    this.player_.emit(Events.KEY_SESSION_CREATED, {
      keySystem: this.keySystem_,
      sessionId: session.sessionId,
    });
  }

  private async handleSessionMessage_(
    session: MediaKeySession,
    event: MediaKeyMessageEvent,
  ) {
    if (!this.keySystem_) {
      return;
    }
    try {
      let body: BodyInit = event.message;
      if (this.keySystem_ === KeySystem.PLAYREADY) {
        body = unwrapPlayReadyChallenge(event.message);
      }
      const url = this.player_.getConfig().drm.licenseUrls[this.keySystem_];
      if (!url) {
        throw new Error(`No license URL configured for ${this.keySystem_}`);
      }

      const request = this.player_
        .getNetworkService()
        .request(NetworkRequestType.LICENSE, url, undefined, {
          method: "POST",
          body,
        });
      const response = await request.promise;
      if (response === ABORTED) {
        return;
      }
      await session.update(response.arrayBuffer);
    } catch (err) {
      this.emitError_(err);
    }
  }

  private handleKeyStatusesChange_(session: MediaKeySession) {
    const statuses = new Map<string, MediaKeyStatus>();
    session.keyStatuses.forEach((status, keyId) => {
      const bytes =
        keyId instanceof ArrayBuffer
          ? new Uint8Array(keyId)
          : new Uint8Array(keyId.buffer, keyId.byteOffset, keyId.byteLength);
      statuses.set(bytesFingerprint(bytes), status);
    });
    this.player_.emit(Events.KEY_STATUSES_CHANGED, {
      sessionId: session.sessionId,
      statuses,
    });
    for (const status of statuses.values()) {
      if (status === "internal-error" || status === "output-restricted") {
        this.emitError_(new Error(`Fatal key status: ${status}`));
        return;
      }
    }
  }

  private emitError_(err: unknown) {
    // No typed ERROR event exists yet — log to mirror the existing
    // error sink pattern. Replace once a typed surface lands.
    log.info("error", err);
    console.error("[EmeController]", err);
  }

  private async teardown_() {
    // Snapshot all fields we need before any await so that a concurrent
    // re-attach (MEDIA_DETACHING → MEDIA_ATTACHED) cannot observe or corrupt
    // the state we're tearing down.
    const media = this.media_;
    const mediaKeys = this.mediaKeys_;
    const sessions = Array.from(this.activeSessions_);
    const onEncrypted = this.onEncrypted_;
    const mediaKeysAttached = this.mediaKeysAttached_;

    // Reset instance state synchronously — any concurrent re-activation sees a
    // clean slate and our awaits below cannot touch the new state.
    this.media_ = null;
    this.mediaKeys_ = null;
    this.mediaKeysAttached_ = false;
    this.keySystem_ = null;
    this.manifest_ = null;
    this.activeSessions_.clear();
    this.psshSeen_.clear();
    this.onEncrypted_ = null;

    if (onEncrypted && media) {
      media.removeEventListener("encrypted", onEncrypted);
    }
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Closing an already-closed session can throw; ignore.
      }
    }
    if (media && mediaKeysAttached) {
      try {
        await media.setMediaKeys(null);
      } catch {
        // Detaching MediaKeys can race with element teardown; ignore.
      }
    }
    // `mediaKeys` is a CDM handle — GC handles cleanup, no explicit await needed.
    void mediaKeys;
  }
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function bytesFingerprint(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0");
  }
  return hex;
}
