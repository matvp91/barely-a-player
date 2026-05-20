# Stream Probing Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure media capability probing in `stream_utils.ts` so config drives DRM ordering, mime-type construction is centralized via `getContentType`, probe helpers collapse to one function, and probe inputs use real manifest metadata with documented fallbacks.

**Architecture:** Add three optional Track fields (`frameRate`, `channels`, `sampleRate`) populated by the DASH parser. Replace `probeDecodingInfo` + `probeOnce` with a single `probeTrack` that loops `config.drm.preferredKeySystems` directly (no manifest intersection filter) and delegates `MediaDecodingConfiguration` construction to one builder. `Stream` shape unchanged.

**Tech Stack:** TypeScript, Vitest + happy-dom, DASH/MPD via custom parser, EME `mediaCapabilities.decodingInfo`.

**Spec:** [packages/cmaf-lite/docs/superpowers/specs/2026-05-20-stream-probing-redesign-design.md](../specs/2026-05-20-stream-probing-redesign-design.md)

---

## Task 1: Add `frameRate` to `VideoTrack` type

**Files:**
- Modify: `packages/cmaf-lite/lib/types/manifest.ts:137-143`

- [ ] **Step 1: Add the optional field**

Edit `packages/cmaf-lite/lib/types/manifest.ts`, replace the `VideoTrack` interface:

```ts
export interface VideoTrack extends BaseTrack {
  type: MediaType.VIDEO;
  /** Video width. */
  width: number;
  /** Video height. */
  height: number;
  /** Frames per second. Decimal form (e.g. 30 or 29.97). */
  frameRate?: number;
}
```

- [ ] **Step 2: Type check**

Run: `pnpm tsc`
Expected: passes (field is optional; existing constructions unaffected).

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/types/manifest.ts
git commit -m "feat(types): Add optional frameRate to VideoTrack"
```

---

## Task 2: Parse `@frameRate` in the DASH parser

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts:290-308` (`buildTrack` video branch)
- Test: `packages/cmaf-lite/test/dash/dash_parser.test.ts` (locate existing video track parsing test; add adjacent)

DASH `@frameRate` is either an integer (`"30"`) or a fraction (`"30000/1001"`). Parse both and store as a decimal number. Use the existing `Functional.findMap([representation, adaptationSet], …)` pattern so representation overrides adaptation set.

- [ ] **Step 1: Locate existing video parsing test**

Run: `grep -n "frameRate\|VideoTrack\|width.*1920" packages/cmaf-lite/test/dash/dash_parser.test.ts | head`
Read the file around the matches to find where video-track parsing is tested.

- [ ] **Step 2: Write failing tests for `frameRate` parsing**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts`, add to the video-track describe block (or create a new one if none exists):

```ts
it("parses frameRate as a decimal integer", async () => {
  const mpd = /* xml fixture with <Representation frameRate="30" .../> */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as VideoTrack;
  expect(track.frameRate).toBe(30);
});

it("parses frameRate in fractional form", async () => {
  const mpd = /* xml fixture with <Representation frameRate="30000/1001" .../> */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as VideoTrack;
  expect(track.frameRate).toBeCloseTo(29.97, 2);
});

it("falls back to AdaptationSet frameRate when Representation lacks it", async () => {
  const mpd = /* AdaptationSet frameRate="24", Representation has none */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as VideoTrack;
  expect(track.frameRate).toBe(24);
});

it("leaves frameRate undefined when neither node declares it", async () => {
  const mpd = /* no frameRate anywhere */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as VideoTrack;
  expect(track.frameRate).toBeUndefined();
});
```

Mirror the XML construction style used by sibling tests in the file. Import `VideoTrack` from `../../lib/types/manifest`.

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm --filter cmaf-lite test -- dash_parser`
Expected: 4 new tests fail (`frameRate` is currently never populated).

- [ ] **Step 4: Implement parsing**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`, update `buildTrack` video branch (around line 290):

```ts
if (type === MediaType.VIDEO) {
  const width = Functional.findMap([representation, adaptationSet], (node) =>
    XmlUtils.attr(node, "width", XmlUtils.parseNumber),
  );
  asserts.assertExists(width, "width is mandatory");
  const height = Functional.findMap([representation, adaptationSet], (node) =>
    XmlUtils.attr(node, "height", XmlUtils.parseNumber),
  );
  asserts.assertExists(height, "height is mandatory");
  const frameRate = Functional.findMap([representation, adaptationSet], (node) =>
    XmlUtils.attr(node, "frameRate", parseFrameRate),
  );
  return {
    id,
    type,
    width,
    height,
    bandwidth,
    segments: [],
    maxSegmentDuration: 0,
    ...(frameRate !== undefined ? { frameRate } : {}),
  };
}
```

Add the helper at module scope (near other parsers; if none exists locally, place it just above `buildTrack`):

```ts
function parseFrameRate(value: string): number | undefined {
  const trimmed = value.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const num = Number(trimmed.substring(0, slashIdx));
  const den = Number(trimmed.substring(slashIdx + 1));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  return num / den;
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm --filter cmaf-lite test -- dash_parser`
Expected: all 4 new tests pass; existing dash parser tests still pass.

- [ ] **Step 6: Type check and lint**

Run: `pnpm tsc && pnpm format`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_parser.ts packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "feat(dash): Parse @frameRate on Representation/AdaptationSet"
```

---

## Task 3: Add `channels` and `sampleRate` to `AudioTrack` type

**Files:**
- Modify: `packages/cmaf-lite/lib/types/manifest.ts:150-152`

- [ ] **Step 1: Add the optional fields**

Edit `packages/cmaf-lite/lib/types/manifest.ts`, replace the `AudioTrack` interface:

```ts
export interface AudioTrack extends BaseTrack {
  type: MediaType.AUDIO;
  /** Channel count (e.g. 2 for stereo, 6 for 5.1). */
  channels?: number;
  /** Sample rate in Hz. */
  sampleRate?: number;
}
```

- [ ] **Step 2: Type check**

Run: `pnpm tsc`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/cmaf-lite/lib/types/manifest.ts
git commit -m "feat(types): Add optional channels and sampleRate to AudioTrack"
```

---

## Task 4: Parse `@audioSamplingRate` and `AudioChannelConfiguration@value`

**Files:**
- Modify: `packages/cmaf-lite/lib/dash/dash_parser.ts:309-311` (`buildTrack` audio branch)
- Test: `packages/cmaf-lite/test/dash/dash_parser.test.ts`

Both fields use the same `[representation, adaptationSet]` fallback. `@audioSamplingRate` may be space-separated; take the first. `AudioChannelConfiguration` is a child element with `@value` and `@schemeIdUri`. Only handle the two common schemes where `@value` is the channel count directly:

- `urn:mpeg:dash:23003:3:audio_channel_configuration:2011`
- `urn:mpeg:mpegB:cicp:ChannelConfiguration`

Other schemes leave `channels` undefined.

- [ ] **Step 1: Write failing tests**

In `packages/cmaf-lite/test/dash/dash_parser.test.ts`, add an audio-track describe block (or extend existing):

```ts
it("parses @audioSamplingRate", async () => {
  const mpd = /* Representation audioSamplingRate="48000" */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.sampleRate).toBe(48000);
});

it("uses first value when @audioSamplingRate is space-separated", async () => {
  const mpd = /* audioSamplingRate="48000 44100" */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.sampleRate).toBe(48000);
});

it("parses channels from MPEG DASH AudioChannelConfiguration", async () => {
  const mpd = /* AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2" */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.channels).toBe(2);
});

it("parses channels from MPEG CICP AudioChannelConfiguration", async () => {
  const mpd = /* schemeIdUri="urn:mpeg:mpegB:cicp:ChannelConfiguration" value="6" */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.channels).toBe(6);
});

it("leaves channels undefined for unknown schemeIdUri", async () => {
  const mpd = /* schemeIdUri="urn:dolby:dash:audio_channel_configuration:2011" value="F801" */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.channels).toBeUndefined();
});

it("leaves both undefined when neither node declares them", async () => {
  const mpd = /* nothing */;
  const manifest = await parse(mpd);
  const track = manifest.switchingSets[0]!.tracks[0]! as AudioTrack;
  expect(track.channels).toBeUndefined();
  expect(track.sampleRate).toBeUndefined();
});
```

Import `AudioTrack` from `../../lib/types/manifest`.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter cmaf-lite test -- dash_parser`
Expected: 6 new tests fail.

- [ ] **Step 3: Implement parsing**

In `packages/cmaf-lite/lib/dash/dash_parser.ts`, replace the audio branch of `buildTrack`:

```ts
if (type === MediaType.AUDIO) {
  const sampleRate = Functional.findMap(
    [representation, adaptationSet],
    (node) => XmlUtils.attr(node, "audioSamplingRate", parseFirstNumber),
  );
  const channels = Functional.findMap(
    [representation, adaptationSet],
    (node) => readChannelCount(node),
  );
  return {
    id,
    type,
    bandwidth,
    segments: [],
    maxSegmentDuration: 0,
    ...(channels !== undefined ? { channels } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
  };
}
```

Add module-level helpers:

```ts
const CHANNEL_CONFIG_SCHEMES = new Set<string>([
  "urn:mpeg:dash:23003:3:audio_channel_configuration:2011",
  "urn:mpeg:mpegB:cicp:ChannelConfiguration",
]);

function parseFirstNumber(value: string): number | undefined {
  const first = value.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const n = Number(first);
  return Number.isFinite(n) ? n : undefined;
}

function readChannelCount(node: txml.TNode): number | undefined {
  const cfg = XmlUtils.child(node, "AudioChannelConfiguration");
  if (!cfg) return undefined;
  const scheme = XmlUtils.attr(cfg, "schemeIdUri", XmlUtils.parseString);
  if (!scheme || !CHANNEL_CONFIG_SCHEMES.has(scheme)) return undefined;
  return XmlUtils.attr(cfg, "value", XmlUtils.parseNumber);
}
```

If `XmlUtils.child` is not the exact API name, check existing usages (`grep -n "XmlUtils.child\b" packages/cmaf-lite/lib/dash/`) and use the project's lookup helper.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm --filter cmaf-lite test -- dash_parser`
Expected: all 6 new tests pass; existing pass.

- [ ] **Step 5: Type check and lint**

Run: `pnpm tsc && pnpm format`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/dash/dash_parser.ts packages/cmaf-lite/test/dash/dash_parser.test.ts
git commit -m "feat(dash): Parse audioSamplingRate and AudioChannelConfiguration"
```

---

## Task 5: Change `buildStreams` to take `PlayerConfig`

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts:19-51` (`buildStreams`)
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts:92-157` (`buildStream`)
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts:164-190` (`probeDecodingInfo`)
- Modify: `packages/cmaf-lite/lib/media/stream_controller.ts:91-94`
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts` (all `buildStreams` call sites)
- Modify: `packages/cmaf-lite/test/__framework__/factories.ts` (add `DEFAULT_CONFIG` if not already exported)

- [ ] **Step 1: Add `DEFAULT_CONFIG` test factory (if missing)**

Run: `grep -n "DEFAULT_CONFIG" packages/cmaf-lite/test/__framework__/factories.ts`
If no result, append to `packages/cmaf-lite/test/__framework__/factories.ts`:

```ts
import { DEFAULT_CONFIG as LIB_DEFAULT_CONFIG } from "../../lib/config";
import type { PlayerConfig } from "../../lib/config";

/**
 * Full PlayerConfig fixture for tests. Override individual slices by
 * spreading: `{ ...DEFAULT_CONFIG, drm: { ...DEFAULT_DRM_CONFIG, ... } }`.
 */
export const DEFAULT_CONFIG: PlayerConfig = {
  ...LIB_DEFAULT_CONFIG,
  drm: DEFAULT_DRM_CONFIG,
};
```

If `lib/config` already exports `DEFAULT_CONFIG`, simply re-export with the drm slice overridden as above.

- [ ] **Step 2: Update `stream_utils.ts` signatures**

Edit `packages/cmaf-lite/lib/utils/stream_utils.ts`:

Replace the top import:
```ts
import type { PlayerConfig } from "../config";
```
(remove `import type { DrmConfig } from "../config";` if it becomes unused.)

Replace `buildStreams`:
```ts
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
  // ...rest unchanged...
}
```

Replace `buildStream` signature:
```ts
async function buildStream(
  switchingSet: SwitchingSet,
  track: Track,
  config: PlayerConfig,
): Promise<Stream | null> {
  // ...body unchanged for now; pass `config` to probeDecodingInfo instead of `drm`...
}
```

Replace `probeDecodingInfo` signature (still using the old body for this task — restructure comes later):
```ts
async function probeDecodingInfo(
  codec: string,
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<DecodingProbe> {
  const candidates = candidateKeySystems(switchingSet, config.drm);
  // ...rest unchanged...
}
```

- [ ] **Step 3: Update `stream_controller.ts` call site**

Edit `packages/cmaf-lite/lib/media/stream_controller.ts:91-94`:

```ts
this.streams_ = await StreamUtils.buildStreams(
  event.manifest,
  this.player_.getConfig(),
);
```

- [ ] **Step 4: Update test call sites**

In `packages/cmaf-lite/test/utils/stream_utils.test.ts`, replace the factory import line to add `DEFAULT_CONFIG`:

```ts
import {
  // ...existing...
  DEFAULT_CONFIG,
  DEFAULT_DRM_CONFIG,
  // ...existing...
} from "../__framework__/factories";
```

Run: `grep -n "buildStreams(manifest, DEFAULT_DRM_CONFIG)" packages/cmaf-lite/test/utils/stream_utils.test.ts`
Replace every occurrence with `buildStreams(manifest, DEFAULT_CONFIG)`. For tests that customize the DRM config, use `buildStreams(manifest, { ...DEFAULT_CONFIG, drm: customDrm })`.

- [ ] **Step 5: Run tests and type check**

Run: `pnpm tsc && pnpm --filter cmaf-lite test`
Expected: all existing tests pass.

- [ ] **Step 6: Lint**

Run: `pnpm format`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/lib/media/stream_controller.ts packages/cmaf-lite/test/utils/stream_utils.test.ts packages/cmaf-lite/test/__framework__/factories.ts
git commit -m "refactor(streams): Pass PlayerConfig to buildStreams"
```

---

## Task 6: Drop the manifest `protection.keySystems` filter

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts:192-201` (`candidateKeySystems`)
- Modify: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

`candidateKeySystems` will be removed in Task 8; this task's job is just to remove the intersection so the configured order is authoritative.

- [ ] **Step 1: Write a failing test**

Add to `packages/cmaf-lite/test/utils/stream_utils.test.ts` inside the `describe("buildStreams (protected)", ...)` block:

```ts
it("probes configured key systems even when manifest protection lists different ones", async () => {
  // Manifest declares only PlayReady protection, but config prefers Widevine.
  // Browser actually supports Widevine — we should still probe it and succeed.
  const protection = createProtection({
    keySystems: { [KeySystem.PLAYREADY]: { /* psshs */ } },
  });
  const switchingSet = createVideoSwitchingSet({ protection });
  const manifest = createManifest({ switchingSets: [switchingSet] });

  mockMediaCapabilities({
    supportedKeySystems: [KeySystem.WIDEVINE],
  });

  const config: PlayerConfig = {
    ...DEFAULT_CONFIG,
    drm: { ...DEFAULT_DRM_CONFIG, preferredKeySystems: [KeySystem.WIDEVINE] },
  };

  const streams = (await buildStreams(manifest, config)).get(MediaType.VIDEO) ?? [];
  expect(streams.length).toBeGreaterThan(0);
  expect(streams[0]![PROP_KEY_SYSTEM_ACCESS]?.keySystem).toBe(KeySystem.WIDEVINE);
});
```

If `mockMediaCapabilities` does not currently accept a `supportedKeySystems` option, inspect the helper (`grep -n "mockMediaCapabilities" packages/cmaf-lite/test/__framework__/factories.ts`) and shape the test to whatever lever the helper exposes (e.g., pass per-key-system overrides). The behavior under test is the same: configured key system absent from manifest, but supported by the device, should be probed and chosen.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: the new test fails (current code filters Widevine out because manifest only lists PlayReady).

- [ ] **Step 3: Remove the intersection**

Edit `packages/cmaf-lite/lib/utils/stream_utils.ts`, replace `candidateKeySystems`:

```ts
function candidateKeySystems(
  switchingSet: SwitchingSet,
  drm: DrmConfig,
): KeySystem[] {
  if (!switchingSet.protection) {
    return [];
  }
  return [...drm.preferredKeySystems];
}
```

(The `drm` import is still needed; re-add `import type { DrmConfig } from "../config";` if Task 5 removed it.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: the new test passes; existing protected-content tests still pass.

- [ ] **Step 5: Type check and lint**

Run: `pnpm tsc && pnpm format`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/test/utils/stream_utils.test.ts
git commit -m "refactor(streams): Treat config as authoritative for key system order"
```

---

## Task 7: Introduce `buildDecodingConfig` builder

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts:203-279` (replaces `buildKeySystemConfig` + `probeOnce` config construction)
- Test: `packages/cmaf-lite/test/utils/stream_utils.test.ts`

This task introduces the central builder but leaves `probeDecodingInfo` / `probeOnce` callers wired through it — Task 8 collapses the two probe functions.

- [ ] **Step 1: Write failing tests for the builder**

Add a new `describe("buildDecodingConfig", …)` block in `packages/cmaf-lite/test/utils/stream_utils.test.ts`. Export the helper from `stream_utils.ts` so it's testable (keep it internal but exported, or move to a `__test__` sibling — match existing style for testing internal helpers in this codebase; check with `grep -rn "export function" packages/cmaf-lite/lib/utils/stream_utils.ts`).

```ts
describe("buildDecodingConfig", () => {
  it("builds a clear-content video config using getContentType and track metadata", () => {
    const track = createVideoTrack({
      width: 1920, height: 1080, bandwidth: 5_000_000, frameRate: 29.97,
    });
    const switchingSet = createVideoSwitchingSet({ codec: "avc1.640028", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet);
    expect(config).toEqual({
      type: "media-source",
      video: {
        contentType: 'video/mp4; codecs="avc1.640028"',
        width: 1920,
        height: 1080,
        bitrate: 5_000_000,
        framerate: 29.97,
      },
    });
  });

  it("falls back to default framerate when track does not declare one", () => {
    const track = createVideoTrack({ width: 1280, height: 720, bandwidth: 2_000_000 });
    const switchingSet = createVideoSwitchingSet({ codec: "avc1.4d401f", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet);
    expect(config.video?.framerate).toBe(30);
  });

  it("builds an audio config using track channels and sampleRate", () => {
    const track = createAudioTrack({ bandwidth: 128_000, channels: 6, sampleRate: 44_100 });
    const switchingSet = createAudioSwitchingSet({ codec: "mp4a.40.2", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet);
    expect(config).toEqual({
      type: "media-source",
      audio: {
        contentType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
        channels: "6",
        samplerate: 44_100,
      },
    });
  });

  it("falls back to default channels and samplerate when track lacks them", () => {
    const track = createAudioTrack({ bandwidth: 96_000 });
    const switchingSet = createAudioSwitchingSet({ codec: "mp4a.40.2", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet);
    expect(config.audio?.channels).toBe("2");
    expect(config.audio?.samplerate).toBe(48_000);
  });

  it("attaches a keySystemConfiguration when a key system is provided", () => {
    const track = createVideoTrack({ width: 1920, height: 1080, bandwidth: 5_000_000 });
    const switchingSet = createVideoSwitchingSet({ codec: "avc1.640028", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet, KeySystem.WIDEVINE) as
      MediaDecodingConfiguration & { keySystemConfiguration: MediaKeySystemConfiguration & { keySystem: string } };
    expect(config.keySystemConfiguration.keySystem).toBe(KeySystem.WIDEVINE);
    expect(config.keySystemConfiguration.videoCapabilities).toEqual([
      { contentType: 'video/mp4; codecs="avc1.640028"', robustness: "SW_SECURE_CRYPTO" },
    ]);
    expect(config.keySystemConfiguration.initDataTypes).toEqual(["cenc"]);
  });

  it("uses audioCapabilities for an audio key system probe", () => {
    const track = createAudioTrack({ bandwidth: 128_000 });
    const switchingSet = createAudioSwitchingSet({ codec: "mp4a.40.2", tracks: [track] });
    const config = buildDecodingConfig(track, switchingSet, KeySystem.WIDEVINE) as
      MediaDecodingConfiguration & { keySystemConfiguration: MediaKeySystemConfiguration & { keySystem: string } };
    expect(config.keySystemConfiguration.audioCapabilities).toEqual([
      { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: "SW_SECURE_CRYPTO" },
    ]);
    expect(config.keySystemConfiguration.videoCapabilities).toBeUndefined();
  });
});
```

Update factories if needed: `createVideoTrack` and `createAudioTrack` must accept the new optional fields. Find them with `grep -n "createVideoTrack\|createAudioTrack" packages/cmaf-lite/test/__framework__/factories.ts` and extend the option types and defaults.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: new `buildDecodingConfig` tests fail (function not exported / not defined).

- [ ] **Step 3: Implement `buildDecodingConfig`**

Edit `packages/cmaf-lite/lib/utils/stream_utils.ts`. Remove `buildKeySystemConfig` and replace with:

```ts
const DEFAULT_VIDEO_FRAMERATE = 30;
const DEFAULT_AUDIO_CHANNELS = "2";
const DEFAULT_AUDIO_SAMPLERATE = 48_000;

type KeySystemProbeConfig = MediaKeySystemConfiguration & {
  keySystem: string;
};

export function buildDecodingConfig(
  track: Track,
  switchingSet: SwitchingSet,
  keySystem?: KeySystem,
): MediaDecodingConfiguration {
  const contentType = CodecUtils.getContentType(track.type, switchingSet.codec);
  let base: MediaDecodingConfiguration;
  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    base = {
      type: "media-source",
      video: {
        contentType,
        width: track.width,
        height: track.height,
        bitrate: track.bandwidth,
        framerate: track.frameRate ?? DEFAULT_VIDEO_FRAMERATE,
      },
    };
  } else if (
    track.type === MediaType.AUDIO &&
    switchingSet.type === MediaType.AUDIO
  ) {
    base = {
      type: "media-source",
      audio: {
        contentType,
        bitrate: track.bandwidth,
        channels: String(track.channels ?? DEFAULT_AUDIO_CHANNELS),
        samplerate: track.sampleRate ?? DEFAULT_AUDIO_SAMPLERATE,
      },
    };
  } else {
    throw new Error(`buildDecodingConfig: unsupported track type ${track.type}`);
  }

  if (keySystem !== undefined) {
    const cap: MediaKeySystemMediaCapability = {
      contentType,
      robustness: defaultRobustness(keySystem),
    };
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

  return base;
}
```

Then update `probeOnce` to delegate to `buildDecodingConfig` (kept temporarily — Task 8 removes it):

```ts
async function probeOnce(
  track: Track,
  switchingSet: SwitchingSet,
  keySystem: KeySystem | undefined,
): Promise<MediaCapabilitiesDecodingInfo> {
  const config = buildDecodingConfig(track, switchingSet, keySystem);
  return navigator.mediaCapabilities.decodingInfo(config);
}
```

And update `probeDecodingInfo` to call the new `probeOnce`:

```ts
async function probeDecodingInfo(
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<DecodingProbe> {
  const candidates = candidateKeySystems(switchingSet, config.drm);
  if (candidates.length === 0) {
    const info = await probeOnce(track, switchingSet, undefined);
    return { info };
  }
  for (const keySystem of candidates) {
    const info = await probeOnce(track, switchingSet, keySystem);
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
```

Update `buildStream` call sites that previously passed `codec` to `probeDecodingInfo` — drop that arg (it's now derived from `switchingSet.codec` inside `buildDecodingConfig`).

- [ ] **Step 4: Run tests and confirm pass**

Run: `pnpm --filter cmaf-lite test -- stream_utils`
Expected: new `buildDecodingConfig` tests pass; existing tests still pass.

- [ ] **Step 5: Type check and lint**

Run: `pnpm tsc && pnpm format`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts packages/cmaf-lite/test/utils/stream_utils.test.ts packages/cmaf-lite/test/__framework__/factories.ts
git commit -m "refactor(streams): Centralize MediaDecodingConfiguration in buildDecodingConfig"
```

---

## Task 8: Collapse to a single `probeTrack` and drop `DecodingProbe`

**Files:**
- Modify: `packages/cmaf-lite/lib/utils/stream_utils.ts` (remove `probeDecodingInfo`, `probeOnce`, `DecodingProbe`; introduce `probeTrack`)

- [ ] **Step 1: Replace the probe helpers**

In `packages/cmaf-lite/lib/utils/stream_utils.ts`, delete the `DecodingProbe` type, `probeDecodingInfo`, and `probeOnce`. Add:

```ts
async function probeTrack(
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<MediaCapabilitiesDecodingInfo> {
  const candidates = candidateKeySystems(switchingSet, config.drm);
  if (candidates.length === 0) {
    return navigator.mediaCapabilities.decodingInfo(
      buildDecodingConfig(track, switchingSet),
    );
  }
  let last: MediaCapabilitiesDecodingInfo | null = null;
  for (const keySystem of candidates) {
    const info = await navigator.mediaCapabilities.decodingInfo(
      buildDecodingConfig(track, switchingSet, keySystem),
    );
    if (info.supported) {
      return info;
    }
    last = info;
  }
  return (
    last ?? {
      supported: false,
      smooth: false,
      powerEfficient: false,
      keySystemAccess: null,
    }
  );
}
```

- [ ] **Step 2: Rewrite `buildStream` to use `probeTrack`**

Replace `buildStream` in `packages/cmaf-lite/lib/utils/stream_utils.ts`:

```ts
async function buildStream(
  switchingSet: SwitchingSet,
  track: Track,
  config: PlayerConfig,
): Promise<Stream | null> {
  const codec = CodecUtils.getNormalizedCodec(switchingSet.codec);

  if (track.type === MediaType.SUBTITLE && switchingSet.type === MediaType.SUBTITLE) {
    return {
      type: MediaType.SUBTITLE,
      codec,
      bandwidth: track.bandwidth,
      [PROP_HIERARCHY]: { switchingSet, track },
    };
  }

  const info = await probeTrack(track, switchingSet, config);
  if (!info.supported) {
    return null;
  }

  if (track.type === MediaType.VIDEO && switchingSet.type === MediaType.VIDEO) {
    const stream: VideoStream = {
      type: MediaType.VIDEO,
      codec,
      bandwidth: track.bandwidth,
      width: track.width,
      height: track.height,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
    if (info.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = info.keySystemAccess;
    }
    return stream;
  }
  if (track.type === MediaType.AUDIO && switchingSet.type === MediaType.AUDIO) {
    const stream: AudioStream = {
      type: MediaType.AUDIO,
      codec,
      bandwidth: track.bandwidth,
      language: switchingSet.language,
      [PROP_HIERARCHY]: { switchingSet, track },
      [PROP_DECODING_INFO]: info,
    };
    if (info.keySystemAccess) {
      stream[PROP_KEY_SYSTEM_ACCESS] = info.keySystemAccess;
    }
    return stream;
  }
  throw new Error(`Failed to map track for type ${track.type}`);
}
```

- [ ] **Step 3: Run tests and confirm pass**

Run: `pnpm --filter cmaf-lite test`
Expected: full suite passes (no test changes needed — public behavior unchanged from Task 7).

- [ ] **Step 4: Type check and lint**

Run: `pnpm tsc && pnpm format`
Expected: passes.

- [ ] **Step 5: Final dead-code sweep**

Run: `grep -n "DecodingProbe\|probeDecodingInfo\|probeOnce\|buildKeySystemConfig" packages/cmaf-lite/lib/ packages/cmaf-lite/test/`
Expected: no matches (or only matches you intentionally kept). Remove any orphans.

- [ ] **Step 6: Commit**

```bash
git add packages/cmaf-lite/lib/utils/stream_utils.ts
git commit -m "refactor(streams): Collapse probe helpers into probeTrack"
```

---

## Wrap-up

- [ ] **Final verification**

Run: `pnpm tsc && pnpm format && pnpm --filter cmaf-lite test`
Expected: all green.

- [ ] **Diff review against spec**

Re-read [the spec](../specs/2026-05-20-stream-probing-redesign-design.md) and skim the branch diff to confirm:
- `buildStreams` takes `PlayerConfig` ✓
- No more `switchingSet.protection.keySystems` intersection ✓
- `getContentType` is the only source of mime strings in `stream_utils.ts` ✓
- `probeDecodingInfo`, `probeOnce`, `DecodingProbe` removed ✓
- `Stream` shape unchanged; `PROP_KEY_SYSTEM_ACCESS` assigned from `info.keySystemAccess` ✓
- Track types carry optional `frameRate`, `channels`, `sampleRate` and DASH parser populates them ✓
- DRM defaults documented as constants/inline ✓
