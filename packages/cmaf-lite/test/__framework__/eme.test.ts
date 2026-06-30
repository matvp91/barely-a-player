import { describe, expect, it } from "vitest";
import {
  createFakeKeySystemAccess,
  FakeMediaElement,
  FakeMediaKeys,
  FakeMediaKeySession,
  FakeKeyStatusMap,
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

    let closedSettled = false;
    session.closed.then(() => {
      closedSettled = true;
    });
    await Promise.resolve();
    expect(closedSettled).toBe(false);
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
  it("records setMediaKeys calls and dispatches encrypted events", async () => {
    const media = new FakeMediaElement();
    let initDataType = "";
    media.addEventListener("encrypted", (e) => {
      initDataType = (e as MediaEncryptedEvent).initDataType;
    });
    media.emitEncrypted("cenc", new Uint8Array([1]));
    expect(initDataType).toBe("cenc");

    await media.setMediaKeys(null);
    expect(media.setMediaKeysCalls).toHaveLength(1);
  });
});

describe("FakeKeyStatusMap", () => {
  it("forEach yields (status, keyId-bytes) with the key id as bytes", () => {
    const map = new FakeKeyStatusMap();
    map.set("00ff", "usable");
    const seen: { status: MediaKeyStatus; keyId: number[] }[] = [];
    map.forEach((status, keyId) => {
      const bytes = keyId instanceof Uint8Array ? keyId : new Uint8Array(keyId as ArrayBuffer);
      seen.push({
        status,
        keyId: Array.from(bytes),
      });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe("usable");
    expect(seen[0]!.keyId).toEqual([0, 255]);
  });
});
