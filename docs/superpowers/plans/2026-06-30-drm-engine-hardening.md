# DRM Engine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `lib/drm/` to match project conventions, then fix the behavioral DRM gaps found comparing against Shaka Player v5.1.8 — `encrypted`-event fallback, `mspr:pro` PSSH, correct key-status policy, close-timeout teardown, live key rotation, presentation-level key-system selection, a typed error surface, and `session.closed` watching.

**Architecture:** A thin `EmeController` (orchestrator: readiness gate, license fetch, status batching) delegates MediaKeys/session lifecycle to a stateful `SessionManager` class. Stateless logic (PSSH synthesis, key-status classification, PlayReady unwrap) lives in pure-function utils. The controller owns its tracked license requests and a batching `Timer`, matching `ManifestController`/`GapController` patterns. Key-system selection becomes presentation-wide in `stream_utils.ts`.

**Tech Stack:** TypeScript, Vitest + happy-dom, Biome. EME has no happy-dom implementation, so the work introduces controllable EME test fakes in `test/__framework__/`.

---

## Reference: source spec

Full design and rationale: [docs/superpowers/specs/2026-06-12-drm-engine-hardening-design.md](../specs/2026-06-12-drm-engine-hardening-design.md). Read it before starting — it explains *why* each gap matters and which Shaka behaviors are deliberately out of scope.

## Baseline state (read before Task 1)

The working tree already has an uncommitted change by the maintainer: `PROP_KEY_SYSTEM_ACCESS` was removed; the per-stream `MediaKeySystemAccess` now lives on `stream[PROP_DECODING_INFO].keySystemAccess`. `EmeController.findKeySystemAccess_` reads it there. **Consequence:** `packages/cmaf-lite/test/utils/stream_utils.test.ts` still imports and asserts `PROP_KEY_SYSTEM_ACCESS` (around lines 5, 559, 599) and will not compile. Task 1.0 reconciles this so the suite is green before any refactor begins.

All commands run from the repo root `/Users/matvp/Development/cmaf-lite`. Run a single package's tests with `pnpm --filter cmaf-lite test <path>`; type-check with `pnpm --filter cmaf-lite tsc`; lint/format with `pnpm format`.

## Conventions to follow (from existing controllers)

- Private fields and methods end with `_`. Event handlers are arrow-function fields (`private onX_ = (e) => {}`) so `this` binds and `off()` removes the same reference.
- Controllers take `private player_: Player` and subscribe in the constructor, unsubscribe in a **synchronous** `destroy()`.
- **Async from a sync context follows the existing codebase, never `void`.** Event handlers that need to await are `async` arrow fields (like `StreamController.onManifestUpdated_`). Fire-and-forget async helpers are called **bare** (like `StreamController.update_` calling `this.loadSegment_(...)`), not prefixed with `void`. The repo's Biome config does not enable `noFloatingPromises`, so bare calls are the established convention — `void` is noise we are removing, not adding.
- Pure helpers live in `lib/utils/*` and are imported namespaced (`import * as BufferUtils from ...`) or by name.
- Logging goes through `Log.create(ns)`; never `console.*` directly.
- Tests: top-level `describe` uses the PascalCase module/function name; test names state the behavior that breaks. Helpers inside `describe` are arrow functions. Prefer `!` over `asserts.assertExists` in tests. Import enums/types from `lib/` — never redefine.

---

# Stage 1 — Restructure (behavior-preserving)

No behavior changes. Extract `SessionManager`, move inline byte helpers to `buffer_utils`, introduce EME fakes, and reshape `EmeController` to the conventional controller form. The fatal-on-`internal-error`/`output-restricted` key-status logic and the `console.error` error sink are **preserved as-is** here — Stage 5 and Stage 2 replace them respectively.

## Task 1.0: Reconcile the baseline test breakage

**Files:**
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Run the suite to see the current failure**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: FAIL — `PROP_KEY_SYSTEM_ACCESS` is not exported from `../../lib/constants`.

- [ ] **Step 2: Update the import**

In the import block at the top of the file, remove `PROP_KEY_SYSTEM_ACCESS` so only `PROP_DECODING_INFO` and `PROP_HIERARCHY` remain:

```ts
import { PROP_DECODING_INFO, PROP_HIERARCHY } from "../../lib/constants";
```

- [ ] **Step 3: Update the two assertions that read the removed symbol**

Find the two assertions (around lines 559 and 599):

```ts
expect(video[PROP_KEY_SYSTEM_ACCESS]?.keySystem).toBe(KeySystem.WIDEVINE);
```

Replace each with the equivalent read from the decoding info (which is where the access now lives):

```ts
expect(video[PROP_DECODING_INFO].keySystemAccess?.keySystem).toBe(
  KeySystem.WIDEVINE,
);
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/test/utils/stream_utils.test.ts packages/cmaf-lite/lib
git commit -m "refactor(drm): read key system access from decoding info

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 1.1: Byte helpers in buffer_utils

Move the inline `toArrayBuffer`/`bytesFingerprint` out of `eme_controller.ts` into shared utils, and add `bytesEqual` (needed for byte-level init-data dedup in `SessionManager`).

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/buffer_utils.ts`
- Test: `packages/cmaf-lite/test/utils/buffer_utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cmaf-lite/test/utils/buffer_utils.test.ts` (add the imports `toArrayBuffer`, `toHex`, `bytesEqual` to the existing `from "../../lib/utils/buffer_utils"` import):

```ts
describe("toArrayBuffer", () => {
  it("copies the exact bytes into a standalone ArrayBuffer", () => {
    const view = new Uint8Array([1, 2, 3, 4]);
    const buf = toArrayBuffer(view);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3, 4]);
  });

  it("copies only the view's window of a larger backing buffer", () => {
    const backing = new Uint8Array([9, 1, 2, 9]);
    const view = backing.subarray(1, 3);
    expect(Array.from(new Uint8Array(toArrayBuffer(view)))).toEqual([1, 2]);
  });
});

describe("toHex", () => {
  it("renders each byte as two lowercase hex digits", () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });

  it("returns an empty string for empty input", () => {
    expect(toHex(new Uint8Array([]))).toBe("");
  });
});

describe("bytesEqual", () => {
  it("is true for identical contents", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(
      true,
    );
  });

  it("is false for differing lengths", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    );
  });

  it("is false for same length, different bytes", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/utils/buffer_utils.test.ts`
Expected: FAIL — `toArrayBuffer`/`toHex`/`bytesEqual` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `packages/cmaf-lite/lib/utils/buffer_utils.ts`:

```ts
/**
 * Copies a Uint8Array view into a standalone ArrayBuffer sized to the
 * view's window. EME APIs (`generateRequest`, `update`,
 * `setServerCertificate`) take an ArrayBuffer; passing a subarray's
 * backing buffer directly would leak neighbouring bytes.
 */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * Lowercase hex encoding of a byte array. Used to key key-status maps
 * and to compare key IDs.
 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Byte-wise equality of two arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/utils/buffer_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/utils/buffer_utils.ts packages/cmaf-lite/test/utils/buffer_utils.test.ts
git commit -m "feat(utils): add toArrayBuffer, toHex, bytesEqual byte helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 1.2: EME test fakes

happy-dom has no EME. Build controllable fakes so `SessionManager` and `EmeController` can be tested: sessions whose `message`/`keystatuseschange`/`closed` are driven by the test, a `close()` that can hang (crbug simulation), and a fake media element recording `setMediaKeys`.

**Files:**
- Create: `packages/cmaf-lite/test/__framework__/eme.ts`
- Test: `packages/cmaf-lite/test/__framework__/eme.test.ts` (a small self-test so the fakes themselves are trustworthy)

- [ ] **Step 1: Write the fakes**

Create `packages/cmaf-lite/test/__framework__/eme.ts`:

```ts
import { toHex } from "../../lib/utils/buffer_utils";

function toBuf(src: BufferSource): ArrayBuffer {
  if (src instanceof ArrayBuffer) {
    return src.slice(0);
  }
  const view = src as ArrayBufferView;
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
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
      cb(status, hexToBytes(hex));
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
```

- [ ] **Step 2: Write a self-test for the fakes**

Create `packages/cmaf-lite/test/__framework__/eme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createFakeKeySystemAccess,
  FakeMediaElement,
  FakeMediaKeys,
  FakeMediaKeySession,
} from "./eme";

describe("FakeMediaKeySession", () => {
  it("records generateRequest and update payloads", async () => {
    const session = new FakeMediaKeySession();
    await session.generateRequest("cenc", new Uint8Array([1, 2]));
    await session.update(new Uint8Array([3, 4]));
    expect(Array.from(new Uint8Array(session.generateRequestArgs[0]!.initData))).toEqual(
      [1, 2],
    );
    expect(Array.from(new Uint8Array(session.updateArgs[0]!))).toEqual([3, 4]);
  });

  it("delivers message events with the message bytes attached", () => {
    const session = new FakeMediaKeySession();
    let received: ArrayBuffer | null = null;
    session.addEventListener("message", (e) => {
      received = (e as MediaKeyMessageEvent).message;
    });
    session.emitMessage(new Uint8Array([7, 8]));
    expect(Array.from(new Uint8Array(received!))).toEqual([7, 8]);
  });

  it("resolves the closed promise when close() is called", async () => {
    const session = new FakeMediaKeySession();
    const closed = session.closed;
    await session.close();
    await expect(closed).resolves.toBeDefined();
    expect(session.closeCount).toBe(1);
  });

  it("never resolves close() when closeBlocks is set", async () => {
    const session = new FakeMediaKeySession();
    session.closeBlocks = true;
    let settled = false;
    session.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});

describe("FakeMediaKeys", () => {
  it("hands out distinct sessions and records the server certificate", async () => {
    const keys = new FakeMediaKeys();
    const a = keys.createSession();
    const b = keys.createSession();
    expect(a).not.toBe(b);
    await keys.setServerCertificate(new Uint8Array([1]));
    expect(keys.serverCertificate).not.toBeNull();
  });
});

describe("createFakeKeySystemAccess", () => {
  it("exposes the key system and resolves to its MediaKeys", async () => {
    const keys = new FakeMediaKeys();
    const access = createFakeKeySystemAccess("com.widevine.alpha", keys);
    expect(access.keySystem).toBe("com.widevine.alpha");
    expect(await access.createMediaKeys()).toBe(keys as unknown);
  });
});

describe("FakeMediaElement", () => {
  it("records setMediaKeys calls and dispatches encrypted events", () => {
    const media = new FakeMediaElement();
    let initDataType = "";
    media.addEventListener("encrypted", (e) => {
      initDataType = (e as MediaEncryptedEvent).initDataType;
    });
    media.emitEncrypted("cenc", new Uint8Array([1]));
    expect(initDataType).toBe("cenc");
  });
});
```

- [ ] **Step 3: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/__framework__/eme.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cmaf-lite/test/__framework__/eme.ts packages/cmaf-lite/test/__framework__/eme.test.ts
git commit -m "test(drm): add controllable EME fakes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 1.3: SessionManager

Extract MediaKeys + session lifecycle into a single-use class. It owns the `MediaKeys`, the active sessions, byte-level init-data dedup, a single tracked attach promise, and teardown. It reports session `message`/`keystatuseschange` out through callbacks; it does **not** know about `Player`, events, license servers, or key-status policy. In Stage 1 teardown awaits `close()` sequentially exactly like the old `teardown_` (the 1 s race is added in Stage 4).

**Files:**
- Create: `packages/cmaf-lite/lib/drm/session_manager.ts`
- Test: `packages/cmaf-lite/test/drm/session_manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cmaf-lite/test/drm/session_manager.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../lib/drm/session_manager";
import {
  createFakeKeySystemAccess,
  FakeMediaElement,
  FakeMediaKeys,
  type FakeMediaKeySession,
} from "../__framework__/eme";

const noopCallbacks = () => ({
  onMessage: vi.fn(),
  onKeyStatuses: vi.fn(),
});

const setup = () => {
  const keys = new FakeMediaKeys();
  const access = createFakeKeySystemAccess("com.widevine.alpha", keys);
  const callbacks = noopCallbacks();
  const manager = new SessionManager(access, callbacks);
  return { keys, access, callbacks, manager };
};

describe("SessionManager", () => {
  it("exposes the access key system", () => {
    const { manager } = setup();
    expect(manager.keySystem).toBe("com.widevine.alpha");
  });

  it("creates MediaKeys and sets the server certificate when provided", async () => {
    const { keys, manager } = setup();
    await manager.init(new Uint8Array([1, 2, 3]));
    expect(keys.serverCertificate).not.toBeNull();
    expect(Array.from(new Uint8Array(keys.serverCertificate!))).toEqual([1, 2, 3]);
  });

  it("does not set a server certificate when none is provided", async () => {
    const { keys, manager } = setup();
    await manager.init();
    expect(keys.serverCertificate).toBeNull();
  });

  it("attaches MediaKeys to the media element exactly once", async () => {
    const { manager } = setup();
    const media = new FakeMediaElement();
    await manager.init();
    await manager.attach(media as unknown as HTMLMediaElement);
    await manager.attach(media as unknown as HTMLMediaElement);
    expect(media.setMediaKeysCalls).toHaveLength(1);
    expect(media.mediaKeys).not.toBeNull();
  });

  it("creates a session and calls generateRequest with the init data", async () => {
    const { keys, manager } = setup();
    await manager.init();
    const id = await manager.createSession("cenc", new Uint8Array([10, 20]));
    expect(keys.sessions).toHaveLength(1);
    expect(id).toBe(keys.sessions[0]!.sessionId);
    expect(
      Array.from(new Uint8Array(keys.sessions[0]!.generateRequestArgs[0]!.initData)),
    ).toEqual([10, 20]);
  });

  it("dedupes identical init data and returns null for the duplicate", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1, 2, 3]));
    const second = await manager.createSession("cenc", new Uint8Array([1, 2, 3]));
    expect(second).toBeNull();
    expect(keys.sessions).toHaveLength(1);
  });

  it("creates separate sessions for differing init data", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1]));
    await manager.createSession("cenc", new Uint8Array([2]));
    expect(keys.sessions).toHaveLength(2);
  });

  it("routes session message events to the onMessage callback", async () => {
    const { keys, callbacks, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1]));
    keys.sessions[0]!.emitMessage(new Uint8Array([9]));
    expect(callbacks.onMessage).toHaveBeenCalledOnce();
    expect(callbacks.onMessage.mock.calls[0]![0]).toBe(keys.sessions[0]);
  });

  it("routes keystatuseschange events to the onKeyStatuses callback", async () => {
    const { keys, callbacks, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1]));
    keys.sessions[0]!.emitKeyStatusesChange();
    expect(callbacks.onKeyStatuses).toHaveBeenCalledOnce();
  });

  it("forwards a license response to session.update", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1]));
    const session = keys.sessions[0]!;
    await manager.update(session as unknown as MediaKeySession, new Uint8Array([5, 6]));
    expect(Array.from(new Uint8Array(session.updateArgs[0]!))).toEqual([5, 6]);
  });

  it("closes all sessions and detaches MediaKeys on destroy", async () => {
    const { keys, manager } = setup();
    const media = new FakeMediaElement();
    await manager.init();
    await manager.attach(media as unknown as HTMLMediaElement);
    await manager.createSession("cenc", new Uint8Array([1]));
    await manager.createSession("cenc", new Uint8Array([2]));
    const sessions = [...keys.sessions];
    await manager.destroy();
    expect(sessions.every((s: FakeMediaKeySession) => s.closeCount === 1)).toBe(true);
    expect(media.setMediaKeysCalls.at(-1)).toBeNull();
  });

  it("ignores createSession after destroy", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.destroy();
    const id = await manager.createSession("cenc", new Uint8Array([1]));
    expect(id).toBeNull();
    expect(keys.sessions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: FAIL — module `../../lib/drm/session_manager` not found.

- [ ] **Step 3: Implement SessionManager**

Create `packages/cmaf-lite/lib/drm/session_manager.ts`:

```ts
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

  /** Creates MediaKeys and installs the server certificate if given. */
  async init(serverCertificate?: Uint8Array): Promise<void> {
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
    this.media_ = media;
    if (!this.attachPromise_) {
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
    if (this.sessions_.some((e) => BufferUtils.bytesEqual(e.initData, initData))) {
      return null;
    }

    const session = this.mediaKeys_.createSession("temporary");
    this.sessions_.push({ session, initData, initDataType });

    session.addEventListener("message", (ev) => {
      this.callbacks_.onMessage(session, ev as MediaKeyMessageEvent);
    });
    session.addEventListener("keystatuseschange", () => {
      this.callbacks_.onKeyStatuses(session);
    });

    await session.generateRequest(
      initDataType,
      BufferUtils.toArrayBuffer(initData),
    );
    return session.sessionId;
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
    this.destroyed_ = true;
    const sessions = this.sessions_.map((e) => e.session);
    const media = this.media_;
    this.sessions_ = [];
    this.media_ = null;

    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // Closing a session that issued no request can throw; ignore.
      }
    }
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
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Type-check**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/drm/session_manager.ts packages/cmaf-lite/test/drm/session_manager.test.ts
git commit -m "feat(drm): extract SessionManager for MediaKeys and session lifecycle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 1.4: Reshape EmeController onto SessionManager

Rewrite `EmeController` to the conventional controller form: it gates activation, owns the `SessionManager`, runs the license request flow (tracked, cancellable), and handles key statuses. **Behavior is preserved**: FairPlay still defers attach to the `encrypted` event; non-FairPlay attaches eagerly and creates sessions from manifest PSSH; key-status `internal-error`/`output-restricted` is still treated as fatal via the existing `emitError_` (replaced in Stages 2/5); `console.error` sink is retained for now.

**Files:**
- Rewrite: `packages/cmaf-lite/lib/drm/eme_controller.ts`
- Test: `packages/cmaf-lite/test/drm/eme_controller.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cmaf-lite/test/drm/eme_controller.test.ts`. These drive the controller through a real `Player`, stubbing manifest/streams/media via the fakes:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../lib/events";
import { Player } from "../../lib/player";
import { KeySystem } from "../../lib/types/drm";
import { MediaType } from "../../lib/types/media";
import {
  createFakeKeySystemAccess,
  FakeMediaElement,
  FakeMediaKeys,
} from "../__framework__/eme";
import {
  createManifest,
  createProtection,
  createVideoSwitchingSet,
} from "../__framework__/factories";

// Build a player whose manifest/streams/media report protected content with
// the given key system access. Uses the real EmeController via the Player ctor.
const protectedPlayer = (keySystem: string, mediaKeys = new FakeMediaKeys()) => {
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
  // Streams carry the chosen access via decoding info (Stage 1 baseline).
  vi.spyOn(player, "getStreams").mockImplementation((type) => {
    if (type === MediaType.VIDEO) {
      return [
        { [Symbol.for("decodingInfo")]: { keySystemAccess: access } },
      ] as never;
    }
    return [] as never;
  });
  return { player, access, mediaKeys, manifest, pssh };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmeController", () => {
  it("does nothing for clear content (no key system access)", async () => {
    const player = new Player();
    vi.spyOn(player, "getStreams").mockReturnValue([] as never);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await Promise.resolve();
    expect(media.setMediaKeysCalls).toHaveLength(0);
  });
});
```

> **Note for the implementer:** the `getStreams` stub above reads `Symbol.for("decodingInfo")`, but the real symbol is module-private (`Symbol("decodingInfo")` in `constants.ts`). Import the real symbol instead: `import { PROP_DECODING_INFO } from "../../lib/constants";` and build the stub stream object as `{ [PROP_DECODING_INFO]: { keySystemAccess: access } }`. Replace the placeholder `Symbol.for(...)` accordingly. (This indirection is removed in Stage 3 when selection moves to a single player method that is far easier to stub — keep Stage 1 controller tests minimal and lean on `session_manager.test.ts` for the lifecycle coverage.)

Add the manifest-session test:

```ts
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
      Array.from(new Uint8Array(mediaKeys.sessions[0]!.generateRequestArgs[0]!.initData)),
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
    player.setConfig("drm.licenseUrls", { [KeySystem.WIDEVINE]: "https://lic.test" });
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
    expect(Array.from(new Uint8Array(mediaKeys.sessions[0]!.updateArgs[0]!))).toEqual([42]);
  });

  it("emits KEY_SESSION_CREATED with the key system and session id", async () => {
    const { player, mediaKeys } = protectedPlayer(KeySystem.WIDEVINE);
    const created = vi.fn();
    player.on(Events.KEY_SESSION_CREATED, created);
    const media = new FakeMediaElement();
    player.emit(Events.STREAMS_CREATED);
    player.emit(Events.MEDIA_ATTACHED, {
      media: media as unknown as HTMLMediaElement,
      mediaSource: {} as MediaSource,
    });
    await vi.waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(created.mock.calls[0]![0]).toMatchObject({ keySystem: KeySystem.WIDEVINE });
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
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: FAIL — controller still has the old shape (scans for access differently, etc.); several assertions fail.

- [ ] **Step 3: Rewrite EmeController**

Replace the entire contents of `packages/cmaf-lite/lib/drm/eme_controller.ts`:

```ts
import { PROP_DECODING_INFO } from "../constants";
import type { MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import { KeySystem } from "../types/drm";
import type { Manifest } from "../types/manifest";
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
```

- [ ] **Step 4: Run controller tests to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full drm + utils suites and type-check**

Run: `pnpm --filter cmaf-lite test test/drm test/utils/buffer_utils.test.ts`
Expected: PASS.
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors. (`drm_utils.ts` still exports `keySystemFromSchemeIdUri`/`keySystemInfoFromRaw`; nothing references the old inline helpers.)

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test/drm/eme_controller.test.ts
git commit -m "refactor(drm): reshape EmeController onto SessionManager

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 1.5: Stage 1 gate

- [ ] **Step 1: Full suite + type-check + lint**

Run: `pnpm --filter cmaf-lite test`
Expected: PASS (whole package).
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.
Run: `pnpm format`
Expected: no changes left to make.

- [ ] **Step 2: Confirm behavior parity**

Manually re-read `eme_controller.ts` against the pre-refactor version: clear content stays dormant; FairPlay defers attach; non-FairPlay attaches then creates manifest sessions; PlayReady challenge is unwrapped; key-status `internal-error`/`output-restricted` still routes to `emitError_`. No new behavior introduced. If any diverged, fix before proceeding.

---

# Stage 2 — Typed error surface

Introduce `Events.ERROR` carrying a `PlayerError`, and route every DRM failure through it instead of `console.error`. Defines the full `ErrorCode` enum now (later stages emit the remaining codes).

## Task 2.1: PlayerError type and ERROR event

**Files:**
- Create: `packages/cmaf-lite/lib/types/error.ts`
- Modify: `packages/cmaf-lite/lib/events.ts`
- Modify: `packages/cmaf-lite/lib/index.ts`
- Test: `packages/cmaf-lite/test/drm/eme_controller.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `packages/cmaf-lite/test/drm/eme_controller.test.ts`:

```ts
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
```

Add the import at the top of the test file:

```ts
import { ErrorCode } from "../../lib/types/error";
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: FAIL — `ErrorCode` / `Events.ERROR` do not exist.

- [ ] **Step 3: Create the error type**

Create `packages/cmaf-lite/lib/types/error.ts`:

```ts
/**
 * Stable error codes surfaced via {@link Events.ERROR}. Only the DRM
 * codes needed today are defined; the surface is general so other
 * subsystems can adopt it without a new event.
 *
 * @public
 */
export enum ErrorCode {
  /** Protected content but no configured key system is usable. */
  NO_SUPPORTED_KEY_SYSTEM = "noSupportedKeySystem",
  /** createMediaKeys, server certificate, or attach failed. */
  MEDIA_KEYS_SETUP_FAILED = "mediaKeysSetupFailed",
  /** The license request never produced a usable response. */
  LICENSE_REQUEST_FAILED = "licenseRequestFailed",
  /** session.update rejected the license response. */
  LICENSE_RESPONSE_REJECTED = "licenseResponseRejected",
  /** Every key in the presentation has expired. */
  ALL_KEYS_EXPIRED = "allKeysExpired",
  /** Key statuses left no playable stream. */
  KEY_STATUS_RESTRICTED = "keyStatusRestricted",
}

/**
 * An error surfaced to the embedding application. `fatal` errors mean
 * playback cannot continue; non-fatal errors are advisory.
 *
 * @public
 */
export interface PlayerError {
  code: ErrorCode;
  fatal: boolean;
  cause?: unknown;
}
```

- [ ] **Step 4: Wire the ERROR event**

In `packages/cmaf-lite/lib/events.ts`:

Add the import near the top:

```ts
import type { PlayerError } from "./types/error";
```

Add to the `Events` object (after `KEY_STATUSES_CHANGED`):

```ts
  ERROR: "error",
```

Add the `EventMap` entry (after the `KEY_STATUSES_CHANGED` entry):

```ts
  [Events.ERROR]: (event: PlayerError) => void;
```

- [ ] **Step 5: Export the type**

In `packages/cmaf-lite/lib/index.ts`, add:

```ts
export * from "./types/error";
```

- [ ] **Step 6: Route controller errors through ERROR**

In `packages/cmaf-lite/lib/drm/eme_controller.ts`:

Add the import:

```ts
import { ErrorCode } from "../types/error";
import type { PlayerError } from "../types/error";
```

Replace `emitError_` with a code-carrying version:

```ts
  private emitError_(code: ErrorCode, cause: unknown, fatal = true) {
    log.info("error", code, cause);
    const error: PlayerError = { code, fatal, cause };
    this.player_.emit(Events.ERROR, error);
  }
```

Update the call sites:
- In `activate_`'s `catch`: `this.emitError_(ErrorCode.MEDIA_KEYS_SETUP_FAILED, err);`
- In `onEncryptedEvent_`'s `catch`: `this.emitError_(ErrorCode.MEDIA_KEYS_SETUP_FAILED, err);`
- In `onSessionMessage_`'s `catch`: `this.emitError_(ErrorCode.LICENSE_REQUEST_FAILED, err);`
- In `onKeyStatuses_` fatal branch: `this.emitError_(ErrorCode.LICENSE_RESPONSE_REJECTED, new Error(\`Fatal key status: ${status}\`));`
  (This key-status branch is rewritten in Stage 5; this keeps it compiling and surfacing an error in the meantime.)

> Note: `onSessionMessage_` covers both the license-request network failure and the `session.update` rejection in one `catch`. Splitting them into `LICENSE_REQUEST_FAILED` vs `LICENSE_RESPONSE_REJECTED` happens in Stage 4 when the multi-session tolerance logic is added. For Stage 2 a single `LICENSE_REQUEST_FAILED` is acceptable.

- [ ] **Step 7: Run tests + type-check**

Run: `pnpm --filter cmaf-lite test test/drm`
Expected: PASS.
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

- [ ] **Step 8: Format and commit**

```bash
pnpm format
git add packages/cmaf-lite/lib/types/error.ts packages/cmaf-lite/lib/events.ts packages/cmaf-lite/lib/index.ts packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test/drm/eme_controller.test.ts
git commit -m "feat(drm): typed error surface via Events.ERROR

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Stage 3 — Presentation-level key-system selection

Replace per-stream key-system probing with one presentation-wide selection: a single `decodingInfo` probe combining a representative video + audio track under one `keySystemConfiguration`, carrying `encryptionScheme` and corrected robustness defaults. The chosen access is exposed via `Player.getKeySystemAccess()`; `EmeController` reads it there and emits `NO_SUPPORTED_KEY_SYSTEM` when protected content has no usable key system.

## Task 3.1: Robustness split + encryptionScheme in buildDecodingConfig

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts`
- Test: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Update + add the failing tests**

In `packages/cmaf-lite/test/utils/stream_utils.test.ts`, change the video-robustness assertion (around line 497-500) from `SW_SECURE_CRYPTO` to `SW_SECURE_DECODE`:

```ts
    expect(config.keySystemConfiguration.videoCapabilities![0]).toEqual({
      contentType: 'video/mp4; codecs="avc1.640028"',
      robustness: "SW_SECURE_DECODE",
    });
```

Add a new test in the `buildDecodingConfig` describe block:

```ts
  it("includes the encryption scheme in capabilities when provided", () => {
    const track = createVideoTrack({ bandwidth: 5_000_000 });
    const switchingSet = createVideoSwitchingSet({ codec: "avc1.640028" });
    const config = buildDecodingConfig(
      track,
      switchingSet,
      KeySystem.WIDEVINE,
      EncryptionScheme.CBCS,
    ) as MediaDecodingConfiguration & {
      keySystemConfiguration: MediaKeySystemConfiguration & {
        videoCapabilities: { encryptionScheme?: string }[];
      };
    };
    expect(config.keySystemConfiguration.videoCapabilities[0]!.encryptionScheme).toBe(
      "cbcs",
    );
  });
```

Add `EncryptionScheme` to the existing drm import in the test file:

```ts
import { EncryptionScheme, KeySystem } from "../../lib/types/drm";
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: FAIL — video robustness is still `SW_SECURE_CRYPTO`; `encryptionScheme` is not set; `buildDecodingConfig` has no 4th param.

- [ ] **Step 3: Implement robustness split + scheme**

In `packages/cmaf-lite/lib/utils/stream_utils.ts`:

Add the `EncryptionScheme` import:

```ts
import { EncryptionScheme, KeySystem } from "../types/drm";
```

Replace `defaultRobustness` with two functions:

```ts
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
```

Add a capability type that includes `encryptionScheme` (the lib.dom type predates it), near `KeySystemProbeConfig`:

```ts
type MediaCapabilityWithScheme = MediaKeySystemMediaCapability & {
  encryptionScheme?: string;
};
```

Update `buildDecodingConfig`'s signature and the capability block:

```ts
export function buildDecodingConfig(
  track: Track,
  switchingSet: SwitchingSet,
  keySystem?: KeySystem,
  encryptionScheme?: EncryptionScheme,
): MediaDecodingConfiguration {
```

Replace the `if (keySystem !== undefined) { ... }` body's `cap` construction with:

```ts
  if (keySystem !== undefined) {
    const robustness =
      track.type === MediaType.VIDEO
        ? defaultVideoRobustness(keySystem)
        : defaultAudioRobustness(keySystem);
    const cap: MediaCapabilityWithScheme = { contentType, robustness };
    if (encryptionScheme) {
      cap.encryptionScheme = encryptionScheme;
    }
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
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: the `buildDecodingConfig` tests pass. (The `buildStreams (protected)` block still fails — it is rewritten in Task 3.2. That is expected; continue.)

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "feat(drm): split robustness defaults and thread encryption scheme

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 3.2: selectKeySystem + selection-aware buildStreams

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts`
- Test: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Replace the `buildStreams (protected)` tests with selectKeySystem + selection tests**

In `packages/cmaf-lite/test/utils/stream_utils.test.ts`, delete the entire `describe("buildStreams (protected)", ...)` block (the three tests reading `keySystemAccess`) and replace with:

```ts
describe("selectKeySystem", () => {
  const protectedManifest = (keySystems: Record<string, unknown>) =>
    createManifest({
      switchingSets: [
        createVideoSwitchingSet({
          protection: createProtection({ keySystems: keySystems as never }),
        }),
        createAudioSwitchingSet({
          protection: createProtection({ keySystems: keySystems as never }),
        }),
      ],
    });

  it("returns null for clear content", async () => {
    mockMediaCapabilities();
    const selection = await selectKeySystem(
      createManifest(),
      DEFAULT_CONFIG.drm,
    );
    expect(selection).toBeNull();
  });

  it("picks the first preferred key system present in the manifest that probes supported", async () => {
    const spy = mockMediaCapabilities();
    spy.mockImplementation(async (cfg: MediaDecodingConfiguration) => {
      const ks = (
        cfg as MediaDecodingConfiguration & {
          keySystemConfiguration?: { keySystem?: string };
        }
      ).keySystemConfiguration;
      if (ks?.keySystem === KeySystem.WIDEVINE) {
        return createDecodingInfo({
          keySystemAccess: createKeySystemAccess(KeySystem.WIDEVINE),
        });
      }
      return createDecodingInfo({ supported: false, keySystemAccess: null });
    });

    const selection = await selectKeySystem(
      protectedManifest({
        [KeySystem.FAIRPLAY]: { contentId: "skd://x" },
        [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) },
      }),
      { ...DEFAULT_CONFIG.drm, preferredKeySystems: [KeySystem.WIDEVINE] },
    );
    expect(selection?.keySystem).toBe(KeySystem.WIDEVINE);
    expect(selection?.access.keySystem).toBe(KeySystem.WIDEVINE);
  });

  it("probes a single config carrying both video and audio capabilities", async () => {
    const spy = mockMediaCapabilities(
      createDecodingInfo({
        keySystemAccess: createKeySystemAccess(KeySystem.WIDEVINE),
      }),
    );
    await selectKeySystem(
      protectedManifest({ [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) } }),
      { ...DEFAULT_CONFIG.drm, preferredKeySystems: [KeySystem.WIDEVINE] },
    );
    const cfg = spy.mock.calls[0]![0] as MediaDecodingConfiguration & {
      keySystemConfiguration: MediaKeySystemConfiguration;
    };
    expect(cfg.keySystemConfiguration.videoCapabilities).toHaveLength(1);
    expect(cfg.keySystemConfiguration.audioCapabilities).toHaveLength(1);
  });

  it("skips key systems not present in the manifest", async () => {
    const spy = mockMediaCapabilities(
      createDecodingInfo({
        keySystemAccess: createKeySystemAccess(KeySystem.WIDEVINE),
      }),
    );
    await selectKeySystem(
      protectedManifest({ [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) } }),
      {
        ...DEFAULT_CONFIG.drm,
        preferredKeySystems: [KeySystem.PLAYREADY, KeySystem.WIDEVINE],
      },
    );
    // PlayReady absent from manifest → only Widevine probed.
    expect(spy).toHaveBeenCalledTimes(1);
    const cfg = spy.mock.calls[0]![0] as MediaDecodingConfiguration & {
      keySystemConfiguration: { keySystem: string };
    };
    expect(cfg.keySystemConfiguration.keySystem).toBe(KeySystem.WIDEVINE);
  });

  it("returns null when no preferred key system probes supported", async () => {
    mockMediaCapabilities(
      createDecodingInfo({ supported: false, keySystemAccess: null }),
    );
    const selection = await selectKeySystem(
      protectedManifest({ [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) } }),
      DEFAULT_CONFIG.drm,
    );
    expect(selection).toBeNull();
  });
});

describe("buildStreams (protected)", () => {
  it("keeps protected streams when a key system is selected", async () => {
    mockMediaCapabilities(
      createDecodingInfo({
        keySystemAccess: createKeySystemAccess(KeySystem.WIDEVINE),
      }),
    );
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({ protection: createProtection() }),
      ],
    });
    const selection = {
      keySystem: KeySystem.WIDEVINE,
      access: createKeySystemAccess(KeySystem.WIDEVINE),
    };
    const list =
      (await buildStreams(manifest, DEFAULT_CONFIG, selection)).get(
        MediaType.VIDEO,
      ) ?? [];
    expect(list).toHaveLength(1);
  });

  it("drops protected streams when no key system is selected", async () => {
    mockMediaCapabilities();
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({ protection: createProtection() }),
      ],
    });
    const list =
      (await buildStreams(manifest, DEFAULT_CONFIG, null)).get(
        MediaType.VIDEO,
      ) ?? [];
    expect(list).toHaveLength(0);
  });
});
```

Add `selectKeySystem` to the import from `../../lib/utils/stream_utils`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: FAIL — `selectKeySystem` is not exported; `buildStreams` takes no `selection` argument.

- [ ] **Step 3: Implement selectKeySystem + selection-aware probing**

In `packages/cmaf-lite/lib/utils/stream_utils.ts`:

Add the type import for the switching-set unions and `Manifest` (extend the existing manifest import):

```ts
import type {
  AudioSwitchingSet,
  Manifest,
  SwitchingSet,
  Track,
  VideoSwitchingSet,
} from "../types/manifest";
```

Add the selection type and function (place near the top, after imports):

```ts
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
 * `decodingInfo` probe per candidate, combining a representative video and
 * audio track under one `keySystemConfiguration`. Candidates are the
 * configured `preferredKeySystems` that also appear in the manifest, in
 * preference order; the first supported one wins. Returns `null` for clear
 * content or when nothing is supported.
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
  const ksConfig: KeySystemProbeConfig = {
    keySystem,
    initDataTypes: ["cenc"],
    distinctiveIdentifier: "optional",
    persistentState: "optional",
    sessionTypes: ["temporary"],
  };
  const config: MediaDecodingConfiguration & {
    keySystemConfiguration: KeySystemProbeConfig;
  } = { type: "media-source", keySystemConfiguration: ksConfig };

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
    const cap: MediaCapabilityWithScheme = {
      contentType,
      robustness: defaultVideoRobustness(keySystem),
    };
    cap.encryptionScheme = video.switchingSet.protection!.scheme;
    ksConfig.videoCapabilities = [cap];
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
    const cap: MediaCapabilityWithScheme = {
      contentType,
      robustness: defaultAudioRobustness(keySystem),
    };
    cap.encryptionScheme = audio.switchingSet.protection!.scheme;
    ksConfig.audioCapabilities = [cap];
  }

  return config;
}
```

Now make `buildStreams` selection-aware. Replace the `buildStreams`, `buildStream`, `probeTrack` functions and delete `candidateKeySystems`:

```ts
export async function buildStreams(
  manifest: Manifest,
  config: PlayerConfig,
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
```

```ts
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
    buildDecodingConfig(
      track,
      switchingSet,
      selection.keySystem,
      protection.scheme,
    ),
  );
}
```

Remove the now-unused `DrmConfig`-only `candidateKeySystems` function. Keep the `DrmConfig` import (used by `selectKeySystem`).

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter cmaf-lite tsc`
Expected: FAIL — `StreamController` still calls `buildStreams(manifest, config)` without a selection (allowed, optional) but does not yet compute/expose the selection, and `EmeController` still reads `PROP_DECODING_INFO`. That is reconciled in Task 3.3. If the only errors are in `eme_controller.ts`/`player.ts` integration, continue; otherwise fix stream_utils first.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "feat(drm): presentation-level key system selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 3.3: Wire selection through StreamController, Player, EmeController

**Files:**
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts`
- Modify: `packages/cmaf-lite/lib/player.ts`
- Modify: `packages/cmaf-lite/lib/drm/drm_utils.ts`
- Modify: `packages/cmaf-lite/lib/drm/eme_controller.ts`
- Test: `packages/cmaf-lite/test/drm/drm_utils.test.ts`, `packages/cmaf-lite/test/drm/eme_controller.test.ts`

- [ ] **Step 1: Add hasProtectedContent helper + test**

Add to `packages/cmaf-lite/test/drm/drm_utils.test.ts`:

```ts
describe("hasProtectedContent", () => {
  it("is true when an A/V switching set carries protection", () => {
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({ protection: createProtection() }),
      ],
    });
    expect(hasProtectedContent(manifest)).toBe(true);
  });

  it("is false for clear content", () => {
    expect(hasProtectedContent(createManifest())).toBe(false);
  });
});
```

Add the imports to that test file:

```ts
import { hasProtectedContent } from "../../lib/drm/drm_utils";
import {
  createManifest,
  createProtection,
  createVideoSwitchingSet,
} from "../__framework__/factories";
```

Implement in `packages/cmaf-lite/lib/drm/drm_utils.ts`:

```ts
import type { Manifest } from "../types/manifest";
import { MediaType } from "../types/media";

/** True when any audio/video switching set carries protection. */
export function hasProtectedContent(manifest: Manifest): boolean {
  return manifest.switchingSets.some(
    (ss) =>
      (ss.type === MediaType.VIDEO || ss.type === MediaType.AUDIO) &&
      ss.protection != null,
  );
}
```

- [ ] **Step 2: Run to verify the helper test fails then passes**

Run: `pnpm --filter cmaf-lite test test/drm/drm_utils.test.ts`
Expected: FAIL then, after the implementation above, PASS.

- [ ] **Step 3: Store + expose the selection in StreamController**

In `packages/cmaf-lite/lib/media/stream_controller.ts`:

Add a field near `streams_`:

```ts
  private keySystemAccess_: MediaKeySystemAccess | null = null;
```

Add a getter near `getStreams`:

```ts
  getKeySystemAccess() {
    return this.keySystemAccess_;
  }
```

In `onManifestUpdated_`, replace the `if (!event.isUpdate)` body:

```ts
    if (!event.isUpdate) {
      const config = this.player_.getConfig();
      const selection = await StreamUtils.selectKeySystem(
        event.manifest,
        config.drm,
      );
      this.keySystemAccess_ = selection?.access ?? null;
      this.streams_ = await StreamUtils.buildStreams(
        event.manifest,
        config,
        selection,
      );
      log.info("Streams", this.streams_);
      this.player_.emit(Events.STREAMS_CREATED);
      this.tryStart_();
    }
```

- [ ] **Step 4: Expose on Player**

In `packages/cmaf-lite/lib/player.ts`, add a method near `getStreams`:

```ts
  /**
   * Returns the MediaKeySystemAccess chosen for the protected
   * presentation, or null for clear content / no supported key system.
   */
  getKeySystemAccess() {
    return this.streamController_.getKeySystemAccess();
  }
```

- [ ] **Step 5: Switch EmeController to the player accessor + NO_SUPPORTED_KEY_SYSTEM**

In `packages/cmaf-lite/lib/drm/eme_controller.ts`:

Remove the `PROP_DECODING_INFO` import; add:

```ts
import { hasProtectedContent } from "./drm_utils";
```

Add a field:

```ts
  private noKeySystemReported_ = false;
```

Replace `maybeActivate_` and delete `findKeySystemAccess_`:

```ts
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
```

In `teardown_`, reset the flag (so a re-attach can report again): add `this.noKeySystemReported_ = false;` alongside the other resets.

- [ ] **Step 6: Update the controller test harness to stub getKeySystemAccess**

In `packages/cmaf-lite/test/drm/eme_controller.test.ts`, change the `protectedPlayer` helper: replace the `getStreams`/`PROP_DECODING_INFO` stub with a direct `getKeySystemAccess` stub:

```ts
  vi.spyOn(player, "getManifest").mockReturnValue(manifest);
  vi.spyOn(player, "getKeySystemAccess").mockReturnValue(access);
```

Remove the now-unused `getStreams`/`PROP_DECODING_INFO`/`MediaType` plumbing from the helper and its imports (keep `MediaType` only if another test uses it). In the "clear content" test, stub `getKeySystemAccess` to return `null` instead of stubbing `getStreams`.

Add the NO_SUPPORTED_KEY_SYSTEM test:

```ts
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
```

- [ ] **Step 7: Run drm tests + full suite + type-check**

Run: `pnpm --filter cmaf-lite test test/drm`
Expected: PASS.
Run: `pnpm --filter cmaf-lite test`
Expected: PASS (whole package).
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

- [ ] **Step 8: Format and commit**

```bash
pnpm format
git add packages/cmaf-lite/lib/media/stream_controller.ts packages/cmaf-lite/lib/player.ts packages/cmaf-lite/lib/drm/drm_utils.ts packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test/drm
git commit -m "feat(drm): wire presentation key system selection to controller

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Stage 4 — Session lifecycle robustness

Add the 1 s close-timeout, `session.closed` watching with `hardware-context-reset` recreation, the `encrypted`-event fallback for non-FairPlay content that lacks manifest PSSH, live key rotation on `MANIFEST_UPDATED`, and license-flow refinements (PlayReady envelope headers, split request/response error codes, multi-session failure tolerance).

## Task 4.1: Close timeout in SessionManager.destroy

**Files:**
- Modify: `packages/cmaf-lite/lib/drm/session_manager.ts`
- Test: `packages/cmaf-lite/test/drm/session_manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cmaf-lite/test/drm/session_manager.test.ts`:

```ts
  it("does not hang destroy when a session.close() never resolves", async () => {
    vi.useFakeTimers();
    try {
      const { keys, manager } = setup();
      const media = new FakeMediaElement();
      await manager.init();
      await manager.attach(media as unknown as HTMLMediaElement);
      await manager.createSession("cenc", new Uint8Array([1]));
      keys.sessions[0]!.closeBlocks = true;

      const destroyed = manager.destroy();
      await vi.advanceTimersByTimeAsync(1000);
      await destroyed;

      // Despite the stuck close(), MediaKeys were still detached.
      expect(media.setMediaKeysCalls.at(-1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: FAIL/timeout — `destroy` awaits the stuck `close()` forever.

- [ ] **Step 3: Implement the timeout race**

In `packages/cmaf-lite/lib/drm/session_manager.ts`, add a module-private helper at the bottom:

```ts
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
```

In `destroy`, replace the sequential `await session.close()` loop with a timed race per session (closes run concurrently):

```ts
    await Promise.all(
      sessions.map((session) =>
        promiseWithTimeout(
          Promise.resolve(session.close()).catch(() => {}),
          CLOSE_TIMEOUT_SECONDS,
        ),
      ),
    );
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/drm/session_manager.ts packages/cmaf-lite/test/drm/session_manager.test.ts
git commit -m "fix(drm): bound session close with a 1s timeout on destroy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 4.2: Watch session.closed and recreate on hardware-context-reset

**Files:**
- Modify: `packages/cmaf-lite/lib/drm/session_manager.ts`
- Test: `packages/cmaf-lite/test/drm/session_manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cmaf-lite/test/drm/session_manager.test.ts`:

```ts
  it("recreates a session from stored init data on hardware-context-reset", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1, 2]));
    keys.sessions[0]!.emitClosed(
      "hardware-context-reset" as MediaKeySessionClosedReason,
    );
    await vi.waitFor(() => expect(keys.sessions).toHaveLength(2));
    expect(
      Array.from(new Uint8Array(keys.sessions[1]!.generateRequestArgs[0]!.initData)),
    ).toEqual([1, 2]);
  });

  it("drops a session without recreating it on a non-recoverable close", async () => {
    const { keys, manager } = setup();
    await manager.init();
    await manager.createSession("cenc", new Uint8Array([1, 2]));
    keys.sessions[0]!.emitClosed("internal-error" as MediaKeySessionClosedReason);
    await Promise.resolve();
    await Promise.resolve();
    expect(keys.sessions).toHaveLength(1);
    // The dropped init data can be created again (no longer deduped).
    const id = await manager.createSession("cenc", new Uint8Array([1, 2]));
    expect(id).not.toBeNull();
    expect(keys.sessions).toHaveLength(2);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: FAIL — closed sessions are not watched.

- [ ] **Step 3: Implement closed-watching**

In `packages/cmaf-lite/lib/drm/session_manager.ts`, in `createSession`, after pushing the entry and adding listeners, watch the `closed` promise:

```ts
    const entry: SessionEntry = { session, initData, initDataType };
    this.sessions_.push(entry);

    session.addEventListener("message", (ev) => {
      this.callbacks_.onMessage(session, ev as MediaKeyMessageEvent);
    });
    session.addEventListener("keystatuseschange", () => {
      this.callbacks_.onKeyStatuses(session);
    });

    this.watchSessionClosed_(entry);
```

(Adjust the existing code to name the entry `entry` and reference it; the `session.generateRequest(...)` call and `return session.sessionId;` stay as-is.)

Add a bare async watcher and the handler (use a string compare on the reason to avoid lib.dom version issues):

```ts
  private async watchSessionClosed_(entry: SessionEntry): Promise<void> {
    const reason = await entry.session.closed;
    this.onSessionClosed_(entry, reason);
  }

  private onSessionClosed_(
    entry: SessionEntry,
    reason: MediaKeySessionClosedReason,
  ): void {
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
```

> Note: `SessionEntry` is now referenced by `onSessionClosed_`; it is already declared. If `MediaKeySessionClosedReason` is not in the installed lib.dom typings, type the parameter as `string` instead — the runtime values are unaffected.

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/session_manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

```bash
git add packages/cmaf-lite/lib/drm/session_manager.ts packages/cmaf-lite/test/drm/session_manager.test.ts
git commit -m "feat(drm): recreate sessions on hardware-context-reset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 4.3: Encrypted-event fallback + live key rotation

**Files:**
- Modify: `packages/cmaf-lite/lib/drm/eme_controller.ts`
- Test: `packages/cmaf-lite/test/drm/eme_controller.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cmaf-lite/test/drm/eme_controller.test.ts`:

```ts
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
            protection: createProtection({ keySystems: { [KeySystem.WIDEVINE]: {} } }),
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
    manifest.switchingSets[0]!.protection!.keySystems[KeySystem.WIDEVINE] = {
      pssh: new Uint8Array([7, 7, 7]),
    };
    player.emit(Events.MANIFEST_UPDATED, { manifest, isUpdate: true });
    await vi.waitFor(() => expect(mediaKeys.sessions).toHaveLength(2));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: FAIL — no encrypted fallback; no MANIFEST_UPDATED handling.

- [ ] **Step 3: Implement fallback + rotation**

In `packages/cmaf-lite/lib/drm/eme_controller.ts`:

Subscribe to `MANIFEST_UPDATED` in the constructor and unsubscribe in `destroy`:

```ts
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
```
```ts
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
```

Add the handler (async arrow, awaiting — no `void`):

```ts
  private onManifestUpdated_ = async () => {
    const manager = this.sessionManager_;
    if (manager && manager.keySystem !== KeySystem.FAIRPLAY) {
      await this.createManifestSessions_(manager);
    }
  };
```

`createManifestSessions_` stays as written in Stage 1 (returns `Promise<void>`, creates sessions only). Add a separate, single-purpose query that decides whether the encrypted fallback is needed — keeping "decide" out of "do":

```ts
  private manifestHasPssh_(keySystem: KeySystem): boolean {
    const manifest = this.player_.getManifest();
    return manifest.switchingSets.some((ss) => {
      if (ss.type !== MediaType.VIDEO && ss.type !== MediaType.AUDIO) {
        return false;
      }
      return ss.protection?.keySystems[keySystem]?.pssh != null;
    });
  }
```

In `activate_`, replace the non-FairPlay branch to use that query for the fallback decision:

```ts
      if (manager.keySystem === KeySystem.FAIRPLAY) {
        this.attachEncryptedListener_(manager);
      } else {
        if (this.media_) {
          await manager.attach(this.media_);
        }
        await this.createManifestSessions_(manager);
        if (!this.manifestHasPssh_(manager.keySystem)) {
          // No manifest PSSH for this key system (e.g. only default_KID
          // with in-band PSSH) — let the encrypted event drive sessions.
          this.attachEncryptedListener_(manager);
        }
      }
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

```bash
git add packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test/drm/eme_controller.test.ts
git commit -m "feat(drm): encrypted-event fallback and live key rotation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 4.4: PlayReady envelope headers + license error split + multi-session tolerance

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/playready_utils.ts`
- Modify: `packages/cmaf-lite/lib/drm/session_manager.ts` (expose `sessionCount`)
- Modify: `packages/cmaf-lite/lib/drm/eme_controller.ts`
- Test: `packages/cmaf-lite/test/utils/playready_utils.test.ts`, `packages/cmaf-lite/test/drm/eme_controller.test.ts`

- [ ] **Step 1: Write the failing PlayReady header test**

Add to `packages/cmaf-lite/test/utils/playready_utils.test.ts` (import `playReadyRequestHeaders`):

```ts
describe("playReadyRequestHeaders", () => {
  it("defaults to text/xml when the message is already unwrapped", () => {
    const message = new TextEncoder().encode("raw-challenge").buffer;
    const headers = playReadyRequestHeaders(message);
    expect(headers.get("Content-Type")).toBe("text/xml; charset=utf-8");
  });

  it("copies SOAPAction and Content-Type from a PlayReadyKeyMessage envelope", () => {
    const xml =
      '<PlayReadyKeyMessage><LicenseAcquisition>' +
      '<HttpHeaders><HttpHeader>' +
      '<name>Content-Type</name><value>application/soap+xml</value>' +
      '</HttpHeader><HttpHeader>' +
      '<name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value>' +
      '</HttpHeader></HttpHeaders>' +
      '<Challenge>Y2hhbGxlbmdl</Challenge>' +
      '</LicenseAcquisition></PlayReadyKeyMessage>';
    const bytes = new Uint8Array(xml.length * 2);
    for (let i = 0; i < xml.length; i++) {
      bytes[i * 2] = xml.charCodeAt(i) & 0xff;
      bytes[i * 2 + 1] = xml.charCodeAt(i) >> 8;
    }
    const headers = playReadyRequestHeaders(bytes.buffer);
    expect(headers.get("Content-Type")).toBe("application/soap+xml");
    expect(headers.get("SOAPAction")).toContain("AcquireLicense");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/utils/playready_utils.test.ts`
Expected: FAIL — `playReadyRequestHeaders` is not exported.

- [ ] **Step 3: Implement the header extractor**

Append to `packages/cmaf-lite/lib/utils/playready_utils.ts`:

```ts
/**
 * Builds the request headers for a PlayReady license POST. When the CDM
 * message is the legacy `PlayReadyKeyMessage` SOAP envelope, copies its
 * `<HttpHeader>` name/value pairs (notably `Content-Type` and
 * `SOAPAction`). Otherwise defaults to `text/xml; charset=utf-8`, which is
 * what modern `com.microsoft.playready.recommendation` challenges expect.
 *
 * @public
 */
export function playReadyRequestHeaders(buffer: ArrayBuffer): Headers {
  const headers = new Headers();
  if (buffer.byteLength >= 2) {
    const xml = new TextDecoder("utf-16le").decode(buffer);
    if (xml.includes("PlayReadyKeyMessage")) {
      const headerRe =
        /<HttpHeader>\s*<name>([^<]+)<\/name>\s*<value>([^<]*)<\/value>\s*<\/HttpHeader>/g;
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
      while ((match = headerRe.exec(xml)) !== null) {
        headers.set(match[1]!, match[2]!);
      }
    }
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/xml; charset=utf-8");
  }
  return headers;
}
```

- [ ] **Step 4: Run to verify the PlayReady test passes**

Run: `pnpm --filter cmaf-lite test test/utils/playready_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Expose sessionCount on SessionManager**

In `packages/cmaf-lite/lib/drm/session_manager.ts`, add:

```ts
  get sessionCount(): number {
    return this.sessions_.length;
  }
```

- [ ] **Step 6: Write the multi-session tolerance test**

Add to `packages/cmaf-lite/test/drm/eme_controller.test.ts`:

```ts
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
              keySystems: { [KeySystem.WIDEVINE]: { pssh: new Uint8Array([1]) } },
            }),
          }),
          createAudioSwitchingSet({
            protection: createProtection({
              keySystems: { [KeySystem.WIDEVINE]: { pssh: new Uint8Array([2]) } },
            }),
          }),
        ],
      }),
    );
    player.setConfig("drm.licenseUrls", { [KeySystem.WIDEVINE]: "https://lic.test" });
    vi.spyOn(player.getNetworkService(), "request").mockReturnValue({
      promise: Promise.reject(new Error("network down")),
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
```

- [ ] **Step 7: Implement the license-flow refinements**

In `packages/cmaf-lite/lib/drm/eme_controller.ts`, add the PlayReady header import:

```ts
import {
  playReadyRequestHeaders,
  unwrapPlayReadyChallenge,
} from "../utils/playready_utils";
```

Rewrite `onSessionMessage_`:

```ts
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
        body = unwrapPlayReadyChallenge(event.message);
        headers = playReadyRequestHeaders(event.message);
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
```

- [ ] **Step 8: Run drm + utils tests + type-check**

Run: `pnpm --filter cmaf-lite test test/drm test/utils/playready_utils.test.ts`
Expected: PASS.
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

- [ ] **Step 9: Format and commit**

```bash
pnpm format
git add packages/cmaf-lite/lib/utils/playready_utils.ts packages/cmaf-lite/lib/drm/session_manager.ts packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test
git commit -m "feat(drm): PlayReady headers, split license errors, multi-session tolerance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Stage 5 — Key status policy

Replace the placeholder fatal-on-`internal-error`/`output-restricted` logic with the correct policy: batch key statuses across all sessions over 0.5 s, then judge once — all-keys-`expired` is fatal (`ALL_KEYS_EXPIRED`); `internal-error`/`output-restricted` keys restrict the streams whose `default_KID` they cover (filter + switch), going fatal (`KEY_STATUS_RESTRICTED`) only when an A/V type has no playable stream left.

## Task 5.1: classifyKeyStatuses + normalizeKeyId

**Files:**
- Modify: `packages/cmaf-lite/lib/drm/drm_utils.ts`
- Test: `packages/cmaf-lite/test/drm/drm_utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cmaf-lite/test/drm/drm_utils.test.ts` (extend the import from `../../lib/drm/drm_utils` with `classifyKeyStatuses`, `normalizeKeyId`):

```ts
describe("classifyKeyStatuses", () => {
  it("reports allExpired when every key is expired", () => {
    const v = classifyKeyStatuses(
      new Map([
        ["aa", "expired"],
        ["bb", "expired"],
      ]),
    );
    expect(v.allExpired).toBe(true);
    expect(v.restrictedKeyIds.size).toBe(0);
  });

  it("does not report allExpired when any key is not expired", () => {
    const v = classifyKeyStatuses(
      new Map([
        ["aa", "expired"],
        ["bb", "usable"],
      ]),
    );
    expect(v.allExpired).toBe(false);
  });

  it("collects internal-error and output-restricted keys as restricted", () => {
    const v = classifyKeyStatuses(
      new Map<string, MediaKeyStatus>([
        ["aa", "usable"],
        ["bb", "output-restricted"],
        ["cc", "internal-error"],
      ]),
    );
    expect([...v.restrictedKeyIds].sort()).toEqual(["bb", "cc"]);
  });

  it("treats an empty map as not expired with no restrictions", () => {
    const v = classifyKeyStatuses(new Map());
    expect(v.allExpired).toBe(false);
    expect(v.restrictedKeyIds.size).toBe(0);
  });
});

describe("normalizeKeyId", () => {
  it("strips dashes and lowercases", () => {
    expect(normalizeKeyId("ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/drm_utils.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `packages/cmaf-lite/lib/drm/drm_utils.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/drm_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/drm/drm_utils.ts packages/cmaf-lite/test/drm/drm_utils.test.ts
git commit -m "feat(drm): key status classification helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 5.2: isStreamRestricted

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts`
- Test: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cmaf-lite/test/utils/stream_utils.test.ts` (import `isStreamRestricted`, and `buildStreams`/`createProtection` are already imported):

```ts
describe("isStreamRestricted", () => {
  const videoStream = async (defaultKid: string) => {
    mockMediaCapabilities(
      createDecodingInfo({
        keySystemAccess: createKeySystemAccess(KeySystem.WIDEVINE),
      }),
    );
    const manifest = createManifest({
      switchingSets: [
        createVideoSwitchingSet({
          protection: createProtection({ defaultKid }),
        }),
      ],
    });
    const selection = {
      keySystem: KeySystem.WIDEVINE,
      access: createKeySystemAccess(KeySystem.WIDEVINE),
    };
    const list =
      (await buildStreams(manifest, DEFAULT_CONFIG, selection)).get(
        MediaType.VIDEO,
      ) ?? [];
    return list[0]!;
  };

  it("is true when the stream's default_KID is restricted (dash-insensitive)", async () => {
    const stream = await videoStream("abcdef01-2345-6789-abcd-ef0123456789");
    const restricted = new Set(["abcdef0123456789abcdef0123456789"]);
    expect(isStreamRestricted(stream, restricted)).toBe(true);
  });

  it("is false when the key ID is not restricted", async () => {
    const stream = await videoStream("abcdef01-2345-6789-abcd-ef0123456789");
    expect(isStreamRestricted(stream, new Set(["00"]))).toBe(false);
  });

  it("is false for an empty restricted set", async () => {
    const stream = await videoStream("abcdef01-2345-6789-abcd-ef0123456789");
    expect(isStreamRestricted(stream, new Set())).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: FAIL — `isStreamRestricted` not exported.

- [ ] **Step 3: Implement**

In `packages/cmaf-lite/lib/utils/stream_utils.ts`, import the normalizer and add the predicate. Add to the drm_utils-style import (create one if absent):

```ts
import { normalizeKeyId } from "../drm/drm_utils";
```

```ts
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
```

> Note: importing from `../drm/drm_utils` into `utils/stream_utils.ts` is a new cross-directory dependency. It is one pure function and keeps the normalization logic in one place. If the team prefers no `utils → drm` import, move `normalizeKeyId` into `buffer_utils.ts` (it is a generic string transform) and import it from there in both places. Either is acceptable; pick one and be consistent.

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/utils/stream_utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "feat(drm): isStreamRestricted predicate for key-status restrictions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 5.3: Restricted-key state + RESTRICTIONS_UPDATED on Player

**Files:**
- Modify: `packages/cmaf-lite/lib/events.ts`
- Modify: `packages/cmaf-lite/lib/player.ts`

- [ ] **Step 1: Add the event**

In `packages/cmaf-lite/lib/events.ts`, add to `Events` (after `ERROR`):

```ts
  RESTRICTIONS_UPDATED: "restrictionsUpdated",
```

Add to `EventMap`:

```ts
  [Events.RESTRICTIONS_UPDATED]: undefined;
```

- [ ] **Step 2: Add restricted-key state to Player**

In `packages/cmaf-lite/lib/player.ts`, add a field:

```ts
  private restrictedKeyIds_ = new Set<string>();
```

Add methods near `getStreams`:

```ts
  /** Normalized key IDs currently restricted by key status. */
  getRestrictedKeyIds() {
    return this.restrictedKeyIds_;
  }

  /** Replaces the restricted key ID set (EmeController owns this). */
  setRestrictedKeyIds(keyIds: Set<string>) {
    this.restrictedKeyIds_ = keyIds;
  }
```

- [ ] **Step 3: Type-check + commit**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

```bash
git add packages/cmaf-lite/lib/events.ts packages/cmaf-lite/lib/player.ts
git commit -m "feat(drm): restricted key id state and RESTRICTIONS_UPDATED event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 5.4: Batch + judge key statuses in EmeController

**Files:**
- Modify: `packages/cmaf-lite/lib/drm/eme_controller.ts`
- Test: `packages/cmaf-lite/test/drm/eme_controller.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cmaf-lite/test/drm/eme_controller.test.ts`. These use fake timers to drive the 0.5 s batch:

```ts
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
```

> Note: `getStreams` is stubbed to `[]` so the "any A/V type fully restricted" check sees no streams (length 0 ⇒ not fatal). The fatal `KEY_STATUS_RESTRICTED` path (all streams of a type restricted) is exercised by Task 5.5's StreamController integration where real restricted streams exist.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: FAIL — no batching; old per-session fatal logic still present.

- [ ] **Step 3: Implement batching + judgement**

In `packages/cmaf-lite/lib/drm/eme_controller.ts`:

Add imports:

```ts
import { MediaType } from "../types/media";
import { Timer } from "../utils/timer";
import {
  classifyKeyStatuses,
  hasProtectedContent,
} from "./drm_utils";
import { isStreamRestricted } from "../utils/stream_utils";
```

(`MediaType` is already imported — keep one import.) Add fields and a constant:

```ts
  private keyStatuses_ = new Map<string, MediaKeyStatus>();
  private statusTimer_ = new Timer(() => this.flushKeyStatuses_());
```

```ts
const KEY_STATUS_BATCH_SECONDS = 0.5;
```

Replace `onKeyStatuses_` (drop the old fatal loop) with batching:

```ts
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
    this.player_.setRestrictedKeyIds(verdict.restrictedKeyIds);
    this.player_.emit(Events.RESTRICTIONS_UPDATED);
    if (this.noPlayableStream_(verdict.restrictedKeyIds)) {
      this.emitError_(
        ErrorCode.KEY_STATUS_RESTRICTED,
        new Error("No playable stream after key-status restrictions"),
      );
    }
  }

  private noPlayableStream_(restrictedKeyIds: Set<string>): boolean {
    for (const type of [MediaType.VIDEO, MediaType.AUDIO] as const) {
      const streams = this.player_.getStreams(type);
      if (
        streams.length > 0 &&
        streams.every((s) => isStreamRestricted(s, restrictedKeyIds))
      ) {
        return true;
      }
    }
    return false;
  }
```

In `destroy`, stop the timer and clear the batch (in `teardown_` add):

```ts
    this.statusTimer_.stop();
    this.keyStatuses_.clear();
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm --filter cmaf-lite test test/drm/eme_controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

```bash
pnpm format
git add packages/cmaf-lite/lib/drm/eme_controller.ts packages/cmaf-lite/test/drm/eme_controller.test.ts
git commit -m "feat(drm): batch key statuses and apply expiry/restriction policy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 5.5: Honor restrictions in stream selection

`AbrController` must not pick restricted video; `StreamController` must switch the active stream off a newly-restricted one on `RESTRICTIONS_UPDATED`.

**Files:**
- Modify: `packages/cmaf-lite/lib/abr/abr_controller.ts`
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts`
- Test: `packages/cmaf-lite/test/media/stream_controller.test.ts` (create if absent — see note)

- [ ] **Step 1: Filter restricted streams in ABR**

In `packages/cmaf-lite/lib/abr/abr_controller.ts`, import the predicate:

```ts
import * as StreamUtils from "../utils/stream_utils";
```

In `onEvaluate_`, after fetching `streams`, drop restricted ones:

```ts
    const restricted = this.player_.getRestrictedKeyIds();
    const streams = this.player_
      .getStreams(MediaType.VIDEO)
      .filter((s) => !StreamUtils.isStreamRestricted(s, restricted));
    if (streams.length === 0) {
      return;
    }
```

(Replace the existing `const streams = this.player_.getStreams(MediaType.VIDEO);` and its length guard.)

- [ ] **Step 2: Switch off restricted active streams in StreamController**

In `packages/cmaf-lite/lib/media/stream_controller.ts`, subscribe to the event in the constructor and unsubscribe in `destroy`:

```ts
    this.player_.on(Events.RESTRICTIONS_UPDATED, this.onRestrictionsUpdated_);
```
```ts
    this.player_.off(Events.RESTRICTIONS_UPDATED, this.onRestrictionsUpdated_);
```

Add the handler:

```ts
  private onRestrictionsUpdated_ = () => {
    const restricted = this.player_.getRestrictedKeyIds();
    if (restricted.size === 0) {
      return;
    }
    for (const [type, streams] of this.streams_) {
      if (type === MediaType.SUBTITLE) {
        continue;
      }
      const active = this.getActiveStream(type);
      if (!active || !StreamUtils.isStreamRestricted(active, restricted)) {
        continue;
      }
      const replacement = streams.find(
        (s) => !StreamUtils.isStreamRestricted(s, restricted),
      );
      if (replacement) {
        this.switchStream_(replacement);
      }
    }
  };
```

Add `Events.RESTRICTIONS_UPDATED` to the `events` import if it is enumerated, otherwise `Events` is already imported as the object. (`StreamUtils` is already imported.)

- [ ] **Step 3: Write the integration test**

> Note: there is no existing `test/media/stream_controller.test.ts`. The controller is currently covered indirectly. Add a focused test for the new behavior only; do not attempt full controller coverage here.

Create `packages/cmaf-lite/test/media/stream_controller.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROP_HIERARCHY } from "../../lib/constants";
import { Events } from "../../lib/events";
import { Player } from "../../lib/player";
import { KeySystem } from "../../lib/types/drm";
import { MediaType } from "../../lib/types/media";
import {
  createProtection,
  createVideoSwitchingSet,
  createVideoTrack,
} from "../__framework__/factories";

afterEach(() => {
  vi.restoreAllMocks();
});

// Builds two minimal video streams in different switching sets with
// distinct default_KIDs.
const videoStreams = () => {
  const mk = (kid: string, bandwidth: number) => {
    const switchingSet = createVideoSwitchingSet({
      protection: createProtection({ defaultKid: kid }),
      tracks: [createVideoTrack({ bandwidth })],
    });
    return {
      type: MediaType.VIDEO,
      codec: "avc1.64001f",
      bandwidth,
      width: 1920,
      height: 1080,
      [PROP_HIERARCHY]: { switchingSet, track: switchingSet.tracks[0] },
    } as never;
  };
  return [
    mk("aaaaaaaa-0000-0000-0000-000000000000", 1_000_000),
    mk("bbbbbbbb-0000-0000-0000-000000000000", 2_000_000),
  ];
};

describe("StreamController restrictions", () => {
  it("switches the active stream off a newly restricted key", () => {
    const player = new Player();
    const streams = videoStreams();
    // Active = restricted stream "aaaa...".
    player.setActiveStream(streams[0]!);
    vi.spyOn(player, "getStreams").mockReturnValue(streams);
    player.setRestrictedKeyIds(
      new Set(["aaaaaaaa000000000000000000000000"]),
    );
    const onChanged = vi.fn();
    player.on(Events.STREAM_CHANGED, onChanged);

    player.emit(Events.RESTRICTIONS_UPDATED);

    // It must switch to the non-restricted "bbbb..." stream.
    const last = onChanged.mock.calls.at(-1)?.[0];
    expect(last.stream).toBe(streams[1]);
  });
});
```

> Implementer caveat: `StreamController.onRestrictionsUpdated_` iterates `this.streams_`, which is populated from `MANIFEST_UPDATED`, not from `player.getStreams()`. For this unit test to exercise the switch, drive the controller's own state: emit `Events.MANIFEST_UPDATED` with a manifest whose built streams match, or expose the streams via the normal load path. If wiring the full manifest path is too heavy for a unit test, instead assert the behavior through `AbrController` (restricted filtering) plus the `EmeController` `RESTRICTIONS_UPDATED` emission already covered in Task 5.4, and cover the switch with the verification run in Task 5.6. Choose the lighter path; do not fake `this.streams_` via private access.

- [ ] **Step 4: Run the relevant suites**

Run: `pnpm --filter cmaf-lite test test/media test/abr test/drm`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.

```bash
pnpm format
git add packages/cmaf-lite/lib/abr/abr_controller.ts packages/cmaf-lite/lib/media/stream_controller.ts packages/cmaf-lite/test/media/stream_controller.test.ts
git commit -m "feat(drm): exclude restricted streams from ABR and active selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 5.6: Final gate

- [ ] **Step 1: Whole-package verification**

Run: `pnpm --filter cmaf-lite test`
Expected: PASS.
Run: `pnpm --filter cmaf-lite tsc`
Expected: no errors.
Run: `pnpm format`
Expected: clean.
Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 2: Manual behavior review against the spec**

Re-read the spec's "Gaps being fixed" list and confirm each P1/P2 item maps to landed code:
P1: encrypted fallback (4.3), mspr:pro PSSH — **see open item below**, key-status policy (5.x), close timeout (4.1), key rotation (4.3). P2: encryptionScheme (3.1), presentation-level selection (3.2/3.3), typed errors (2), session.closed watching (4.2), robustness defaults (3.1), PlayReady headers (4.4).

- [ ] **Step 3: Resolve the open item (mspr:pro PSSH synthesis)**

See "Open item" below — decide and either implement Task X or record it as a follow-up.

---

## Open item: `mspr:pro` PSSH synthesis (spec gap 2)

The spec lists synthesizing a v0 PSSH box from `<mspr:pro>` when `<cenc:pssh>` is absent. This depends on the DASH parser surfacing the `<mspr:pro>` bytes, which the current `resolveProtection` in `lib/dash/dash_helpers.ts` does **not** extract (it reads only `<cenc:pssh>`). Implementing it touches the parser, not just `lib/drm/`, so it is isolated here for an explicit decision:

- **Option A (recommended): implement as Task 4.5.** In `dash_helpers.ts`, in the PlayReady branch of `resolveProtection`, also read `XmlUtils.text(XmlUtils.child(node, "mspr:pro"))`; pass it to `keySystemInfoFromRaw`. Add `psshFromPlayReadyPro(pro: Uint8Array): Uint8Array` to `drm_utils.ts` (PlayReady system id `9a04f079-9840-4286-ab92-e65be0885f95`, v0 PSSH box: `size(4) 'pssh' version+flags(4)=0 systemId(16) dataSize(4) data`), and have `keySystemInfoFromRaw` synthesize `pssh` from `mspr:pro` when `cenc:pssh` is absent. Pure function → unit-test in `drm_utils.test.ts` against a known-good box. This is small and self-contained; fold it in before Task 5.6's gate.
- **Option B: defer.** Ship Stages 1–5 without it and track `mspr:pro` as a follow-up. Acceptable if no current test stream relies on `mspr:pro`-only manifests.

The executor (or maintainer) should pick A or B at Task 5.6 Step 3. If A, write it as a TDD task mirroring the others (failing test for `psshFromPlayReadyPro` with a fixed byte expectation → implement → wire into `resolveProtection` → parser test → commit).

---

## Plan self-review

**Spec coverage** — every "Gaps being fixed" item maps to a task: gap 1 → 4.3; gap 2 → Open item (4.5/follow-up); gap 3 → 5.1/5.4/5.5; gap 4 → 4.1; gap 5 → 4.3; gap 6 → 3.1; gap 7 → 3.2/3.3; gap 8 → 2 + 4.4; gap 9 → 4.2; gap 10 → 3.1 (robustness) + 4.4 (PlayReady headers); `dashif:Laurl` → deliberately out of scope (recorded in spec). Structural problems → Stage 1.

**Type consistency** — `SessionManager`: `init/attach/createSession/update/destroy`, getters `keySystem`/`sessionCount`. `SessionManagerCallbacks`: `onMessage`/`onKeyStatuses`. `KeySystemSelection { keySystem, access }`. `KeyStatusVerdict { allExpired, restrictedKeyIds }`. `PlayerError { code, fatal, cause? }`. `ErrorCode` members used: `NO_SUPPORTED_KEY_SYSTEM`, `MEDIA_KEYS_SETUP_FAILED`, `LICENSE_REQUEST_FAILED`, `LICENSE_RESPONSE_REJECTED`, `ALL_KEYS_EXPIRED`, `KEY_STATUS_RESTRICTED`. Player additions: `getKeySystemAccess`, `getRestrictedKeyIds`, `setRestrictedKeyIds`. Events added: `ERROR`, `RESTRICTIONS_UPDATED`. These are consistent across the tasks that reference them.

**Async convention** — no `void`-prefixed calls anywhere in the proposed code. Event handlers that await are `async` arrow fields; fire-and-forget helpers are called bare (`SessionManager.watchSessionClosed_`, `EmeController` callbacks, `manager?.destroy()`), matching `StreamController.loadSegment_`. The only `void` tokens remaining are `: void` return-type annotations.

**Known soft spots flagged inline** (not placeholders — decisions for the implementer): the controller-test stubbing indirection in Task 1.4 (resolved in Task 3.3); the `utils → drm` import direction in Task 5.2; the StreamController unit-test wiring caveat in Task 5.5; and the `mspr:pro` Open item.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-drm-engine-hardening.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
