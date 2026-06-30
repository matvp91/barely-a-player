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

  it("keeps the originally attached element when attach is called again with a different element", async () => {
    const { manager } = setup();
    const first = new FakeMediaElement();
    const second = new FakeMediaElement();
    await manager.init();
    await manager.attach(first as unknown as HTMLMediaElement);
    await manager.attach(second as unknown as HTMLMediaElement);
    // Only the first element was ever given MediaKeys.
    expect(first.setMediaKeysCalls).toHaveLength(1);
    expect(second.setMediaKeysCalls).toHaveLength(0);
    await manager.destroy();
    // Detach (setMediaKeys(null)) happened on the first element, not the second.
    expect(first.setMediaKeysCalls.at(-1)).toBeNull();
    expect(second.setMediaKeysCalls).toHaveLength(0);
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
