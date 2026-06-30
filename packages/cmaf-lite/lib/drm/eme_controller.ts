import type { MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import { KeySystem } from "../types/drm";
import type { PlayerError } from "../types/error";
import { ErrorCode } from "../types/error";
import { MediaType } from "../types/media";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as BufferUtils from "../utils/buffer_utils";
import { Log } from "../utils/log";
import { buildPlayReadyRequest } from "../utils/playready_utils";
import { Timer } from "../utils/timer";
import { classifyKeyStatuses, hasProtectedContent } from "./drm_utils";
import { SessionManager } from "./session_manager";

const log = Log.create("EmeController");

const KEY_STATUS_BATCH_SECONDS = 0.5;

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
  private noKeySystemReported_ = false;
  private keyStatuses_ = new Map<string, MediaKeyStatus>();
  private statusTimer_ = new Timer(() => this.flushKeyStatuses_());

  constructor(private player_: Player) {
    this.player_.on(Events.STREAMS_UPDATED, this.onStreamsUpdated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
  }

  destroy() {
    this.teardown_();
    this.player_.off(Events.STREAMS_UPDATED, this.onStreamsUpdated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHING, this.onMediaDetaching_);
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
  }

  private onStreamsUpdated_ = async () => {
    await this.maybeActivate_();
  };

  private onMediaAttached_ = async (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    await this.maybeActivate_();
  };

  private onMediaDetaching_ = () => {
    this.teardown_();
  };

  private onManifestUpdated_ = async () => {
    const manager = this.sessionManager_;
    if (manager && manager.keySystem !== KeySystem.FAIRPLAY) {
      await this.createManifestSessions_(manager);
    }
  };

  private async maybeActivate_() {
    if (!this.media_ || this.sessionManager_) {
      return;
    }
    const access = this.player_.getKeySystemAccess();
    if (!access) {
      if (
        !this.noKeySystemReported_ &&
        hasProtectedContent(this.player_.getManifest())
      ) {
        this.noKeySystemReported_ = true;
        this.emitError_(
          ErrorCode.NO_SUPPORTED_KEY_SYSTEM,
          new Error("No supported key system for protected content"),
        );
      }
      return;
    }
    await this.activate_(access);
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
        // Suppress the `encrypted` listener when the manifest already declares
        // PSSH for this key system (validated against Shaka). Consequence:
        // content that ships manifest PSSH and later rotates keys ONLY via
        // in-band PSSH is not re-keyed — in-band PSSH parsing is out of scope;
        // rotation is supported via refreshed manifest PSSH (see
        // DashParser.update) or via the encrypted path for
        // default_KID-only content.
        if (!this.manifestHasPssh_(manager.keySystem)) {
          this.attachEncryptedListener_(manager);
        }
      }
    } catch (err) {
      this.emitError_(ErrorCode.MEDIA_KEYS_SETUP_FAILED, err);
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
      this.emitError_(ErrorCode.MEDIA_KEYS_SETUP_FAILED, err);
    }
  }

  private manifestHasPssh_(keySystem: KeySystem): boolean {
    const manifest = this.player_.getManifest();
    return manifest.switchingSets.some((ss) => {
      if (ss.type !== MediaType.VIDEO && ss.type !== MediaType.AUDIO) {
        return false;
      }
      return ss.protection?.keySystems[keySystem]?.pssh != null;
    });
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
    let response: Awaited<NetworkRequest["promise"]>;
    try {
      let body: BodyInit = event.message;
      let headers: Headers | undefined;
      if (manager.keySystem === KeySystem.PLAYREADY) {
        const request = buildPlayReadyRequest(event.message);
        body = request.body;
        headers = request.headers;
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
          headers,
        });
      this.licenseRequests_.add(request);
      try {
        response = await request.promise;
      } finally {
        this.licenseRequests_.delete(request);
      }
      if (response === ABORTED) {
        return;
      }
    } catch (err) {
      // Multi-key content survives one key's license failing; only fatal
      // when it kills the sole session.
      this.emitError_(
        ErrorCode.LICENSE_REQUEST_FAILED,
        err,
        manager.sessionCount <= 1,
      );
      return;
    }

    try {
      await manager.update(session, new Uint8Array(response.arrayBuffer));
    } catch (err) {
      this.emitError_(ErrorCode.LICENSE_RESPONSE_REJECTED, err, true);
    }
  }

  private onKeyStatuses_(session: MediaKeySession) {
    const statuses = new Map<string, MediaKeyStatus>();
    session.keyStatuses.forEach((status, keyId) => {
      const bytes =
        keyId instanceof ArrayBuffer
          ? new Uint8Array(keyId)
          : new Uint8Array(keyId.buffer, keyId.byteOffset, keyId.byteLength);
      const hex = BufferUtils.toHex(bytes);
      statuses.set(hex, status);
      this.keyStatuses_.set(hex, status);
    });
    this.player_.emit(Events.KEY_STATUSES_CHANGED, {
      sessionId: session.sessionId,
      statuses,
    });
    // Batch across sessions: the browser dispatches per-session events for
    // a logically single change; judging immediately yields spurious
    // verdicts. Settle, then judge once.
    this.statusTimer_.tickAfter(KEY_STATUS_BATCH_SECONDS);
  }

  private flushKeyStatuses_() {
    const verdict = classifyKeyStatuses(this.keyStatuses_);
    if (verdict.allExpired) {
      this.emitError_(
        ErrorCode.ALL_KEYS_EXPIRED,
        new Error("All keys expired"),
      );
      return;
    }
    // Hand the restrictions to the stream pipeline; it recomputes the
    // playable set (filtering getStreams, switching the active stream) and
    // emits STREAMS_UPDATED. emit is synchronous, so getStreams below
    // already reflects the new set.
    this.player_.emit(Events.STREAMS_UPDATING, {
      restrictedKeyIds: verdict.restrictedKeyIds,
    });
    if (
      this.player_.getStreams(MediaType.VIDEO).length === 0 &&
      this.player_.getStreams(MediaType.AUDIO).length === 0
    ) {
      this.emitError_(
        ErrorCode.KEY_STATUS_RESTRICTED,
        new Error("No playable stream after key-status restrictions"),
      );
    }
  }

  private emitError_(code: ErrorCode, cause: unknown, fatal = true) {
    log.info("error", code, cause);
    const error: PlayerError = { code, fatal, cause };
    this.player_.emit(Events.ERROR, error);
  }

  private teardown_() {
    const manager = this.sessionManager_;
    const media = this.media_;
    const onEncrypted = this.onEncrypted_;
    const networkService = this.player_.getNetworkService();

    this.sessionManager_ = null;
    this.media_ = null;
    this.onEncrypted_ = null;
    this.noKeySystemReported_ = false;
    this.statusTimer_.stop();
    this.keyStatuses_.clear();

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
