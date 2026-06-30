import type { KeySystem } from "../types/drm";
import * as BufferUtils from "../utils/buffer_utils";
import { Log } from "../utils/log";

const log = Log.create("SessionManager");

/**
 * Callbacks the {@link SessionManager} uses to report session activity
 * back to its owner without depending on the player or event bus.
 */
export interface SessionManagerCallbacks {
  onMessage(session: MediaKeySession, event: MediaKeyMessageEvent): void;
  onKeyStatuses(session: MediaKeySession): void;
}

interface SessionEntry {
  session: MediaKeySession;
  initData: Uint8Array;
  initDataType: string;
}

/**
 * Owns the {@link MediaKeys} instance and every {@link MediaKeySession}
 * for one protected presentation. Single-use: once {@link destroy} runs
 * the instance is spent and the owner creates a fresh one on re-activation.
 * This keeps teardown isolated from any concurrent re-activation — the
 * old instance only ever touches its own captured state.
 */
export class SessionManager {
  private mediaKeys_: MediaKeys | null = null;
  private media_: HTMLMediaElement | null = null;
  private sessions_: SessionEntry[] = [];
  private attachPromise_: Promise<void> | null = null;
  private destroyed_ = false;

  constructor(
    private access_: MediaKeySystemAccess,
    private callbacks_: SessionManagerCallbacks,
  ) {}

  get keySystem(): KeySystem {
    return this.access_.keySystem as KeySystem;
  }

  get sessionCount(): number {
    return this.sessions_.length;
  }

  /** Creates MediaKeys and installs the server certificate if given. */
  async init(serverCertificate?: Uint8Array): Promise<void> {
    if (this.mediaKeys_ || this.destroyed_) {
      return;
    }
    this.mediaKeys_ = await this.access_.createMediaKeys();
    if (serverCertificate) {
      await this.mediaKeys_.setServerCertificate(
        BufferUtils.toArrayBuffer(serverCertificate),
      );
    }
  }

  /** Attaches MediaKeys to the media element. Idempotent. */
  async attach(media: HTMLMediaElement): Promise<void> {
    if (!this.mediaKeys_ || this.destroyed_) {
      return;
    }
    if (!this.attachPromise_) {
      this.media_ = media;
      this.attachPromise_ = media.setMediaKeys(this.mediaKeys_);
    }
    await this.attachPromise_;
  }

  /**
   * Creates a session for the given init data and issues the license
   * request. Returns the session id, or `null` when the init data
   * duplicates an existing session or the manager is not usable.
   */
  async createSession(
    initDataType: string,
    initData: Uint8Array,
  ): Promise<string | null> {
    if (!this.mediaKeys_ || this.destroyed_) {
      return null;
    }
    if (
      this.sessions_.some((e) => BufferUtils.bytesEqual(e.initData, initData))
    ) {
      return null;
    }

    const session = this.mediaKeys_.createSession("temporary");
    const entry: SessionEntry = { session, initData, initDataType };
    this.sessions_.push(entry);

    session.addEventListener("message", (ev) => {
      this.callbacks_.onMessage(session, ev as MediaKeyMessageEvent);
    });
    session.addEventListener("keystatuseschange", () => {
      this.callbacks_.onKeyStatuses(session);
    });

    this.watchSessionClosed_(entry);

    await session.generateRequest(
      initDataType,
      BufferUtils.toArrayBuffer(initData),
    );
    return session.sessionId;
  }

  private async watchSessionClosed_(entry: SessionEntry): Promise<void> {
    const reason = await entry.session.closed;
    this.onSessionClosed_(entry, reason);
  }

  private onSessionClosed_(entry: SessionEntry, reason: string): void {
    const index = this.sessions_.indexOf(entry);
    if (index === -1) {
      return;
    }
    this.sessions_.splice(index, 1);
    if (this.destroyed_) {
      return;
    }
    if (reason === "hardware-context-reset") {
      log.info("Recreating session after hardware-context-reset");
      this.createSession(entry.initDataType, entry.initData);
    }
  }

  /** Delivers a license response to the session. */
  async update(session: MediaKeySession, response: Uint8Array): Promise<void> {
    await session.update(BufferUtils.toArrayBuffer(response));
  }

  /**
   * Closes every session, then detaches MediaKeys. Snapshots state up
   * front so the instance is inert immediately.
   */
  async destroy(): Promise<void> {
    if (this.destroyed_) {
      return;
    }
    this.destroyed_ = true;
    const sessions = this.sessions_.map((e) => e.session);
    const media = this.media_;
    this.sessions_ = [];
    this.media_ = null;

    await Promise.all(
      sessions.map((session) =>
        promiseWithTimeout(
          Promise.resolve(session.close()).catch(() => {}),
          CLOSE_TIMEOUT_SECONDS,
        ),
      ),
    );
    if (media) {
      try {
        await media.setMediaKeys(null);
      } catch (err) {
        log.debug("setMediaKeys(null) failed during destroy", err);
      }
    }
    this.mediaKeys_ = null;
  }
}

const CLOSE_TIMEOUT_SECONDS = 1;

/**
 * Resolves when `promise` settles or after `seconds`, whichever comes
 * first. Guards against CDMs whose `session.close()` never resolves
 * (crbug.com/1108158).
 */
function promiseWithTimeout(
  promise: Promise<unknown>,
  seconds: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, seconds * 1000);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      () => {
        clearTimeout(timeout);
        resolve();
      },
    );
  });
}
