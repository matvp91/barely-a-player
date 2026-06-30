import { PROP_DECODING_INFO } from "../constants";
import type { MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import { KeySystem } from "../types/drm";
import { MediaType } from "../types/media";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as BufferUtils from "../utils/buffer_utils";
import { Log } from "../utils/log";
import { unwrapPlayReadyChallenge } from "../utils/playready_utils";
import { SessionManager } from "./session_manager";

const log = Log.create("EmeController");

/**
 * Orchestrates EME for protected presentations: gates activation on
 * manifest + media + a selected key system, owns a {@link SessionManager},
 * runs the license request flow, and surfaces key statuses. Dormant for
 * clear content — with no key system access nothing is created and no DOM
 * listeners are attached.
 */
export class EmeController {
  private media_: HTMLMediaElement | null = null;
  private sessionManager_: SessionManager | null = null;
  private licenseRequests_ = new Set<NetworkRequest>();
  private onEncrypted_: ((event: Event) => void) | null = null;

  constructor(private player_: Player) {
    this.player_.on(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);
  }

  destroy() {
    this.teardown_();
    this.player_.off(Events.STREAMS_CREATED, this.onStreamsCreated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
  }

  private onStreamsCreated_ = async () => {
    await this.maybeActivate_();
  };

  private onMediaAttached_ = async (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    await this.maybeActivate_();
  };

  private onMediaDetaching_ = () => {
    this.teardown_();
  };

  private async maybeActivate_() {
    if (!this.media_ || this.sessionManager_) {
      return;
    }
    const access = this.findKeySystemAccess_();
    if (!access) {
      return;
    }
    await this.activate_(access);
  }

  private findKeySystemAccess_(): MediaKeySystemAccess | null {
    for (const type of [MediaType.VIDEO, MediaType.AUDIO] as const) {
      for (const stream of this.player_.getStreams(type)) {
        const access = stream[PROP_DECODING_INFO].keySystemAccess;
        if (access) {
          return access;
        }
      }
    }
    return null;
  }

  private async activate_(access: MediaKeySystemAccess) {
    const manager = new SessionManager(access, {
      onMessage: (session, event) => {
        this.onSessionMessage_(manager, session, event);
      },
      onKeyStatuses: (session) => {
        this.onKeyStatuses_(session);
      },
    });
    this.sessionManager_ = manager;

    try {
      const cert =
        this.player_.getConfig().drm.serverCertificates[manager.keySystem];
      await manager.init(cert);

      if (manager.keySystem === KeySystem.FAIRPLAY) {
        this.attachEncryptedListener_(manager);
      } else {
        if (this.media_) {
          await manager.attach(this.media_);
        }
        await this.createManifestSessions_(manager);
      }
    } catch (err) {
      this.emitError_(err);
    }
  }

  private attachEncryptedListener_(manager: SessionManager) {
    if (!this.media_) {
      return;
    }
    this.onEncrypted_ = (event: Event) => {
      this.onEncryptedEvent_(manager, event as MediaEncryptedEvent);
    };
    this.media_.addEventListener("encrypted", this.onEncrypted_);
  }

  private async onEncryptedEvent_(
    manager: SessionManager,
    event: MediaEncryptedEvent,
  ) {
    try {
      if (this.media_) {
        await manager.attach(this.media_);
      }
      if (!event.initData) {
        return;
      }
      await this.createSession_(
        manager,
        event.initDataType,
        new Uint8Array(event.initData),
      );
    } catch (err) {
      this.emitError_(err);
    }
  }

  private async createManifestSessions_(manager: SessionManager) {
    const manifest = this.player_.getManifest();
    for (const ss of manifest.switchingSets) {
      if (ss.type !== MediaType.VIDEO && ss.type !== MediaType.AUDIO) {
        continue;
      }
      const info = ss.protection?.keySystems[manager.keySystem];
      if (info?.pssh) {
        await this.createSession_(manager, "cenc", info.pssh);
      }
    }
  }

  private async createSession_(
    manager: SessionManager,
    initDataType: string,
    initData: Uint8Array,
  ) {
    const sessionId = await manager.createSession(initDataType, initData);
    if (sessionId === null) {
      return;
    }
    this.player_.emit(Events.KEY_SESSION_CREATED, {
      keySystem: manager.keySystem,
      sessionId,
    });
  }

  private async onSessionMessage_(
    manager: SessionManager,
    session: MediaKeySession,
    event: MediaKeyMessageEvent,
  ) {
    try {
      let body: BodyInit = event.message;
      if (manager.keySystem === KeySystem.PLAYREADY) {
        body = unwrapPlayReadyChallenge(event.message);
      }
      const url = this.player_.getConfig().drm.licenseUrls[manager.keySystem];
      if (!url) {
        throw new Error(`No license URL configured for ${manager.keySystem}`);
      }

      const request = this.player_
        .getNetworkService()
        .request(NetworkRequestType.LICENSE, url, undefined, {
          method: "POST",
          body,
        });
      this.licenseRequests_.add(request);

      let response: Awaited<typeof request.promise>;
      try {
        response = await request.promise;
      } finally {
        this.licenseRequests_.delete(request);
      }
      if (response === ABORTED) {
        return;
      }
      await manager.update(session, new Uint8Array(response.arrayBuffer));
    } catch (err) {
      this.emitError_(err);
    }
  }

  private onKeyStatuses_(session: MediaKeySession) {
    const statuses = new Map<string, MediaKeyStatus>();
    session.keyStatuses.forEach((status, keyId) => {
      const bytes =
        keyId instanceof ArrayBuffer
          ? new Uint8Array(keyId)
          : new Uint8Array(keyId.buffer, keyId.byteOffset, keyId.byteLength);
      statuses.set(BufferUtils.toHex(bytes), status);
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
    // Preserved Stage-1 behavior; replaced by Events.ERROR in Stage 2.
    log.info("error", err);
    console.error("[EmeController]", err);
  }

  private teardown_() {
    const manager = this.sessionManager_;
    const media = this.media_;
    const onEncrypted = this.onEncrypted_;
    const networkService = this.player_.getNetworkService();

    this.sessionManager_ = null;
    this.media_ = null;
    this.onEncrypted_ = null;

    for (const request of this.licenseRequests_) {
      networkService.cancel(request);
    }
    this.licenseRequests_.clear();

    if (onEncrypted && media) {
      media.removeEventListener("encrypted", onEncrypted);
    }
    // SessionManager is single-use; its async close runs against its own
    // captured state, so a concurrent re-activation cannot be corrupted.
    // Bare call (not `void`) per the codebase convention for fire-and-forget.
    manager?.destroy();
  }
}
