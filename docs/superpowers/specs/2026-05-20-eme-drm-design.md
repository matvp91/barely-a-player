# EME / DRM support — design

## Problem

cmaf-lite plays clear CMAF content end-to-end but cannot play
DRM-protected presentations. The architecture has no notion of
ContentProtection in the manifest model, no MediaKeys lifecycle,
and no path for license exchange.

Real-world CMAF deployments are overwhelmingly protected. Without
DRM the library is unusable for the production use cases it is
otherwise architected to serve.

## Goal

Add Encrypted Media Extensions (EME) support for Widevine,
PlayReady, and FairPlay on MSE, with manifest-driven key system
selection and app-delegated license acquisition through the
existing `NetworkService`. Protected and clear presentations
flow through the same pipeline; DRM is a controller that runs
when ContentProtection is present and is otherwise dormant.

## Non-goals

- Persistent licenses, offline sessions, license storage.
- In-band PSSH parsing for key rotation (out of scope; signalled
  in manifest only).
- Per-Representation ContentProtection (rare, packagers can hoist
  to AdaptationSet).
- Robustness / HDCP configuration knobs (sensible defaults; can be
  added later if a real need surfaces).
- ClearKey (not a requirement).
- Firefox + PlayReady (would require the `encrypted`-event path
  for PlayReady — adds complexity for a niche audience; can be
  added later without redesign).
- License renewal beyond what the CDM emits automatically through
  the `message` event.
- Individualization server handling, delay-license-until-played,
  remote playback session hooks.

## Approach

### Key system scope and init data sources

| Key system | Manifest signal | Init data source |
| --- | --- | --- |
| Widevine (`com.widevine.alpha`) | `cenc:pssh` under Widevine UUID | Manifest PSSH |
| PlayReady (`com.microsoft.playready.recommendation`) | `cenc:pssh` under PlayReady UUID | Manifest PSSH |
| FairPlay (`com.apple.fps`) | `skd://` URI on FairPlay ContentProtection | `encrypted` event on `<video>` |

FairPlay on Safari MSE genuinely requires the `encrypted`-event
path: Safari fires `encrypted` only after `setMediaKeys`, with
per-segment init data, and DASH manifests historically don't
carry reliable FairPlay PSSH. For Widevine and PlayReady the
manifest path is sufficient — Shaka's behaviour confirms this
(`abstract_device.js:354-356` returns true for `needWaitForEncryptedEvent`
only on FairPlay, plus a Gecko + PlayReady override which we
explicitly defer as a non-goal).

### Architecture summary

```
DASH parser
  └─ parses <ContentProtection> into SwitchingSet.protection
Capability probe (stream_utils.probeDecodingInfo)
  └─ calls mediaCapabilities.decodingInfo with keySystemConfiguration
     when protection is present; iterates preferredKeySystems
     until one returns supported:true; attaches the resulting
     MediaKeySystemAccess on the Stream
EmeController (new, lib/media/)
  └─ activates when protection is present
  └─ creates MediaKeys, manages sessions, dispatches license
     requests via NetworkService (NetworkRequestType.LICENSE)
NetworkService
  └─ gains LICENSE request type; existing pre/post-fetch events
     fire for license requests exactly as they do for manifest
     and segment requests
```

No gating between controllers. EmeController runs in parallel
with BufferController. `setMediaKeys` has no ordering requirement
against MediaSource attach in the EME spec; on Widevine/PlayReady
either order works (the pipeline stalls until keys arrive if
encrypted segments are appended first), and on FairPlay
`setMediaKeys` is explicitly deferred until the `encrypted`
event fires.

## Manifest model

`SwitchingSet` gains an optional `protection` field. ContentProtection
in DASH is conventionally on `AdaptationSet`, which maps to
`SwitchingSet` in our model.

```ts
// lib/types/manifest.ts
export interface BaseSwitchingSet {
  id: string;
  codec: string;
  protection?: Protection;
}

export interface Protection {
  /** Encryption scheme from <ContentProtection value=...> on the
   *  mp4protection element. AES-CTR ("cenc") or AES-CBC subsample
   *  ("cbcs"). */
  scheme: "cenc" | "cbcs";
  /** Default Key ID, lowercased dashed UUID, from cenc:default_KID. */
  defaultKid: string;
  /** Per-key-system init material. */
  keySystems: Partial<Record<KeySystem, KeySystemInfo>>;
}

export interface KeySystemInfo {
  /** CENC PSSH blob (Widevine, PlayReady). */
  pssh?: Uint8Array;
  /** FairPlay content identifier from skd:// URI. */
  contentId?: string;
}
```

New enum, defined alongside the existing `MediaType` enum:

```ts
// lib/types/media.ts (or a new lib/types/drm.ts)
export enum KeySystem {
  WIDEVINE = "com.widevine.alpha",
  PLAYREADY = "com.microsoft.playready.recommendation",
  FAIRPLAY = "com.apple.fps",
}
```

DASH parser changes ([lib/dash/](packages/cmaf-lite/lib/dash/)):

- Parse `<ContentProtection>` elements on `AdaptationSet`.
- The `urn:mpeg:dash:mp4protection:2011` element carries `value`
  (`"cenc"` | `"cbcs"`) and `cenc:default_KID` — required when any
  key-system ContentProtection is present.
- Map `schemeIdUri` UUIDs to canonical `KeySystem` values:
  - `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed` → `WIDEVINE`
  - `9a04f079-9840-4286-ab92-e65be0885f95` → `PLAYREADY`
  - `94ce86fb-07ff-4f43-adb8-93d2fa968ca2` → `FAIRPLAY`
  - Unknown UUIDs are dropped silently.
- Extract `cenc:pssh` (base64-decoded) for Widevine/PlayReady.
- Extract `skd://` URI for FairPlay (typically from a child element
  or `value` attribute depending on packager; both forms supported).
- A `SwitchingSet` with no recognised key system but with `mp4protection`
  signalling still gets `protection` with an empty `keySystems` map —
  it will then be filtered by the capability probe.

## Capability probe extension

The existing `probeDecodingInfo` in
[stream_utils.ts](packages/cmaf-lite/lib/utils/stream_utils.ts) is
extended to include `keySystemConfiguration` when the switching set
has `protection`. One `decodingInfo` call gates both codec support
and key-system support.

```ts
async function probeDecodingInfo(
  codec: string,
  track: Track,
  switchingSet: SwitchingSet,
): Promise<DecodingProbe> {
  for (const keySystem of preferredKeySystemsFor(switchingSet)) {
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: "media-source",
      video: { contentType: ..., width, height, bitrate, framerate: 30 },
      // or audio: ...
      keySystemConfiguration: switchingSet.protection
        ? buildKeySystemConfig(keySystem, switchingSet.protection, track)
        : undefined,
    });
    if (info.supported) return { info, keySystem };
  }
  return { info: { supported: false } };
}
```

`preferredKeySystemsFor` intersects `config.drm.preferredKeySystems`
with `switchingSet.protection.keySystems`, preserving the configured
order. Default order:
`[FAIRPLAY, WIDEVINE, PLAYREADY]` (FairPlay first because it is the
most platform-restrictive — probing it first surfaces a Safari-only
answer cleanly; on non-Safari it returns unsupported and we move
to the next).

`buildKeySystemConfig` populates `audioCapabilities` / `videoCapabilities`
with the right content types and uses defaults for `robustness`
(`"SW_SECURE_CRYPTO"` for Widevine, `"150"` for PlayReady, none
for FairPlay).

The `Stream` model gains an optional new property:

```ts
// lib/constants.ts
export const PROP_KEY_SYSTEM_ACCESS = Symbol("keySystemAccess");

// lib/types/media.ts
export interface VideoStream extends BaseStream {
  // ...
  [PROP_KEY_SYSTEM_ACCESS]?: MediaKeySystemAccess;
}
// (and same on AudioStream)
```

This is the handle EmeController uses to call `createMediaKeys()`
without re-probing.

Filtering behaviour matches today: a stream that probes
`supported: false` across all candidate key systems is dropped from
the playable view. If every stream of a media type is dropped the
user sees the existing "no playable streams" outcome.

## EmeController

New controller in [lib/media/](packages/cmaf-lite/lib/media/),
following the same shape as BufferController/StreamController:
constructed with the Player, binds event listeners, exposes
`destroy()`.

### Activation

Always constructed. Activates only when both have fired and
`manifest.switchingSets` contains at least one with `protection`:

- `MANIFEST_CREATED`
- `MEDIA_ATTACHED`

Clear-content presentations: controller observes the manifest,
sees no protection, stays dormant. No code path runs.

### State machine

```
on (MANIFEST_CREATED & MEDIA_ATTACHED) with protection present:
  ks = chosenKeySystemFromFirstProtectedStream()
  mediaKeySystemAccess = stream[PROP_KEY_SYSTEM_ACCESS]
  mediaKeys = await mediaKeySystemAccess.createMediaKeys()
  if config.drm.serverCertificates[ks]:
    await mediaKeys.setServerCertificate(config.drm.serverCertificates[ks])

  if ks is WIDEVINE or PLAYREADY:
    await video.setMediaKeys(mediaKeys)
    for each unique pssh across protected switching sets:
      session = mediaKeys.createSession("temporary")
      hookSession(session)
      await session.generateRequest("cenc", pssh)
      emit KEY_SESSION_CREATED { keySystem: ks, sessionId: session.sessionId }

  if ks is FAIRPLAY:
    video.addEventListener("encrypted", onEncrypted, { once: false })
    onEncrypted(event):
      if !mediaKeysAttached: await video.setMediaKeys(mediaKeys); mediaKeysAttached = true
      session = mediaKeys.createSession()
      hookSession(session)
      await session.generateRequest(event.initDataType, event.initData)
      emit KEY_SESSION_CREATED { keySystem: ks, sessionId: session.sessionId }

hookSession(session):
  session.addEventListener("message", onMessage)
  session.addEventListener("keystatuseschange", onKeyStatusesChange)

onMessage(event):
  body = event.message
  if ks is PLAYREADY: body = unwrapPlayReadyChallenge(body)
  response = await networkService.request({
    type: NetworkRequestType.LICENSE,
    url: config.drm.licenseUrls[ks],
    method: "POST",
    body,
  })
  await session.update(response.data)

onKeyStatusesChange(event):
  statuses = aggregateStatuses(session.keyStatuses)
  emit KEY_STATUSES_CHANGED { sessionId: session.sessionId, statuses }
  for status of statuses.values():
    if status === "internal-error" || status === "output-restricted":
      emit ERROR { ... }

on MEDIA_DETACHING or destroy:
  for session of activeSessions: await session.close()
  await video.setMediaKeys(null)
  mediaKeys = null
```

### Session management

One `Map<MediaKeySession, SessionMeta>` keyed by session. Init-data
dedupe by byte equality before `createSession` — multi-key CENC
presentations with one pssh covering many KIDs get one session.

No expiration timer, no renewal logic; the CDM drives both through
`message` events which the existing handler covers.

### PlayReady challenge unwrap

PlayReady CDMs emit XML-wrapped license challenges
(`<PlayReadyKeyMessage>` containing a `<Challenge>` with the
base64-encoded inner body). EmeController unwraps inline before
dispatching to NetworkService — same approach as Shaka
(`drm_engine.js:1573 unpackPlayReadyRequest_`). Apps see the
unwrapped body in network events and can layer their own
transforms via the existing pre-fetch event.

FairPlay request body shaping (SPC framing, vendor-specific
license server formats) stays app-side — apps mutate the body via
the `NETWORK_REQUESTING` listener filtered on
`type === NetworkRequestType.LICENSE`.

## Network layer

Add to [lib/types/net.ts](packages/cmaf-lite/lib/types/net.ts):

```ts
export enum NetworkRequestType {
  MANIFEST = "manifest",
  SEGMENT = "segment",
  LICENSE = "license",
}
```

`NetworkService` requires no other changes. Existing pre-fetch
and post-fetch events fire for license requests; listeners filter
on `type === LICENSE` to inject auth, change headers, swap URLs,
or rewrite bodies. This is the only app-facing hook for licensing.

## Player configuration

Added to `Config`:

```ts
drm?: {
  preferredKeySystems?: KeySystem[];
  licenseUrls?: Partial<Record<KeySystem, string>>;
  serverCertificates?: Partial<Record<KeySystem, Uint8Array>>;
};
```

Defaults:

- `preferredKeySystems`: `[FAIRPLAY, WIDEVINE, PLAYREADY]`
- `licenseUrls`: empty — license requests fail (with a clear error)
  unless the app supplies URLs or rewrites them via the
  `NETWORK_REQUESTING` event.
- `serverCertificates`: empty.

## Events

New entries in [lib/events.ts](packages/cmaf-lite/lib/events.ts):

```ts
KEY_SESSION_CREATED      // { keySystem: KeySystem; sessionId: string }
KEY_STATUSES_CHANGED     // { sessionId: string; statuses: Map<string, MediaKeyStatus> }
```

License HTTP visibility comes through the existing `NETWORK_*`
events. There is no `LICENSE_REQUEST`/`LICENSE_LOADED` — the
NetworkService pattern already covers it.

## Errors

EmeController emits the existing player `ERROR` event, surfaced on:

- No key system supported for a protected presentation
  (capability probe returns no supported result for any stream).
- `createMediaKeys` rejection.
- `setMediaKeys` rejection.
- `generateRequest` / `session.update` rejection.
- License request failure (NetworkService error on a `LICENSE`
  request).
- Key status becomes `internal-error` or `output-restricted`.

`output-downscaled`, `usable-in-future`, `expired`, `released`
ride on `KEY_STATUSES_CHANGED` only — not errors.

## Testing

Controller tests are skipped — controllers are not unit-tested in
this codebase today. Other layers are tested:

- **DASH parser**: fixture MPDs with `<ContentProtection>` blocks
  for each key system, `cenc:default_KID`, and `value="cenc"` /
  `value="cbcs"`. Verify the parsed `Protection` matches expected
  shape. Unknown UUIDs dropped silently. Missing `default_KID`
  with mp4protection present is an error.
- **Capability probe**: mock `navigator.mediaCapabilities.decodingInfo`
  to return per-key-system support. Verify probe order respects
  `preferredKeySystems`, falls through on `supported: false`,
  attaches `PROP_KEY_SYSTEM_ACCESS` on the surviving stream, drops
  the stream when no key system is supported.
- **PlayReady unwrap helper**: pure-function test on representative
  XML challenge bodies.
- **Manual / demo verification**: the demo app gains a DRM section
  pointing at public Dash-IF / Bitmovin test streams for Widevine,
  PlayReady, and FairPlay. Real CDM playback is verified there;
  CI does not run real CDMs.

## Files touched

- `lib/types/manifest.ts` — `Protection`, `KeySystemInfo`, optional
  `protection` on `BaseSwitchingSet`.
- `lib/types/media.ts` — `KeySystem` enum, optional
  `PROP_KEY_SYSTEM_ACCESS` on `VideoStream`/`AudioStream`.
- `lib/types/net.ts` — `NetworkRequestType.LICENSE`.
- `lib/constants.ts` — `PROP_KEY_SYSTEM_ACCESS` symbol.
- `lib/config.ts` — `drm` config block with defaults.
- `lib/dash/` — ContentProtection parsing in the AdaptationSet
  reader.
- `lib/utils/stream_utils.ts` — `probeDecodingInfo` extended with
  per-key-system iteration; `buildKeySystemConfig` helper.
- `lib/media/eme_controller.ts` — new controller.
- `lib/player.ts` — instantiate `EmeController` alongside the
  existing controllers.
- `lib/events.ts` — `KEY_SESSION_CREATED`, `KEY_STATUSES_CHANGED`.
- `packages/demo/` — DRM playback section.

## Open questions

None at design time.
