import { toHex } from "../../lib/utils/buffer_utils";

function toBuf(src: BufferSource): ArrayBuffer {
  if (src instanceof ArrayBuffer) {
    return src.slice(0) as ArrayBuffer;
  }
  const view = src as ArrayBufferView;
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Key-status map whose `forEach` yields (status, keyId-bytes). */
export class FakeKeyStatusMap {
  private map_ = new Map<string, MediaKeyStatus>();

  set(keyIdHex: string, status: MediaKeyStatus): void {
    this.map_.set(keyIdHex, status);
  }

  get size(): number {
    return this.map_.size;
  }

  forEach(cb: (status: MediaKeyStatus, keyId: BufferSource) => void): void {
    for (const [hex, status] of this.map_) {
      cb(status, hexToBytes(hex) as BufferSource);
    }
  }
}

/**
 * Controllable MediaKeySession fake. Tests drive `emitMessage`,
 * `emitKeyStatusesChange`, and `emitClosed`; `closeBlocks` simulates the
 * Chrome bug where `close()` never resolves.
 */
export class FakeMediaKeySession extends EventTarget {
  sessionId = "";
  keyStatuses = new FakeKeyStatusMap();
  readonly closed: Promise<MediaKeySessionClosedReason>;
  generateRequestArgs: { initDataType: string; initData: ArrayBuffer }[] = [];
  updateArgs: ArrayBuffer[] = [];
  closeCount = 0;
  closeBlocks = false;

  private resolveClosed_!: (reason: MediaKeySessionClosedReason) => void;

  constructor(sessionId = "session-1") {
    super();
    this.sessionId = sessionId;
    this.closed = new Promise((resolve) => {
      this.resolveClosed_ = resolve;
    });
  }

  async generateRequest(
    initDataType: string,
    initData: BufferSource,
  ): Promise<void> {
    this.generateRequestArgs.push({ initDataType, initData: toBuf(initData) });
  }

  async update(response: BufferSource): Promise<void> {
    this.updateArgs.push(toBuf(response));
  }

  async close(): Promise<void> {
    this.closeCount++;
    if (this.closeBlocks) {
      return new Promise<void>(() => {});
    }
    this.resolveClosed_("closed-by-application" as MediaKeySessionClosedReason);
  }

  // --- test drivers ---

  emitMessage(message: BufferSource, messageType = "license-request"): void {
    const event = new Event("message") as MediaKeyMessageEvent;
    Object.assign(event, { message: toBuf(message), messageType });
    this.dispatchEvent(event);
  }

  emitKeyStatusesChange(): void {
    this.dispatchEvent(new Event("keystatuseschange"));
  }

  emitClosed(reason: MediaKeySessionClosedReason): void {
    this.resolveClosed_(reason);
  }

  setKeyStatus(keyIdHex: string, status: MediaKeyStatus): void {
    this.keyStatuses.set(keyIdHex, status);
  }
}

/** MediaKeys fake. Records the server certificate, hands out fakes. */
export class FakeMediaKeys {
  sessions: FakeMediaKeySession[] = [];
  serverCertificate: ArrayBuffer | null = null;
  private nextId_ = 1;

  createSession(_type?: MediaKeySessionType): MediaKeySession {
    const session = new FakeMediaKeySession(`session-${this.nextId_++}`);
    this.sessions.push(session);
    return session as unknown as MediaKeySession;
  }

  async setServerCertificate(cert: BufferSource): Promise<boolean> {
    this.serverCertificate = toBuf(cert);
    return true;
  }
}

/** MediaKeySystemAccess fake bound to a (possibly shared) FakeMediaKeys. */
export function createFakeKeySystemAccess(
  keySystem: string,
  mediaKeys: FakeMediaKeys = new FakeMediaKeys(),
): MediaKeySystemAccess {
  return {
    keySystem,
    getConfiguration: () => ({}) as MediaKeySystemConfiguration,
    createMediaKeys: async () => mediaKeys as unknown as MediaKeys,
  } as MediaKeySystemAccess;
}

/** Minimal media element fake recording setMediaKeys and dispatching events. */
export class FakeMediaElement extends EventTarget {
  mediaKeys: MediaKeys | null = null;
  setMediaKeysCalls: (MediaKeys | null)[] = [];
  currentTime = 0;
  paused = true;
  ended = false;
  readonly buffered: TimeRanges = {
    length: 0,
    start: () => 0,
    end: () => 0,
  } as unknown as TimeRanges;

  async setMediaKeys(mediaKeys: MediaKeys | null): Promise<void> {
    this.setMediaKeysCalls.push(mediaKeys);
    this.mediaKeys = mediaKeys;
  }

  emitEncrypted(initDataType: string, initData: BufferSource | null): void {
    const event = new Event("encrypted") as MediaEncryptedEvent;
    Object.assign(event, {
      initDataType,
      initData: initData ? toBuf(initData) : null,
    });
    this.dispatchEvent(event);
  }
}

export { toHex };
