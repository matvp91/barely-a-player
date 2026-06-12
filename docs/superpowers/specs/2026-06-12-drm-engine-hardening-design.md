# DRM Engine Hardening — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** `packages/cmaf-lite` — `lib/drm/`, `lib/utils/stream_utils.ts`, DASH ContentProtection parsing, stream selection.

## Background

cmaf-lite's basic DRM support (PR #44) was compared against Shaka Player
v5.1.8's DRM engine, restricted to flows cmaf-lite supports: streaming
playback DRM, temporary sessions, Widevine / PlayReady (recommendation) /
FairPlay, modern browsers.

The comparison validated several core choices — `mediaCapabilities.decodingInfo()`
as the selection mechanism (Shaka's modern path too), deferring `setMediaKeys`
until the `encrypted` event for FairPlay, setting the server certificate
before `generateRequest`, suppressing `encrypted` listening when manifest
PSSH exists, and content-sniffing the PlayReady challenge unwrap.

It also surfaced real gaps (below), and the maintainer flagged a structural
problem: `eme_controller.ts` mixes responsibilities and deviates from the
codebase's controller conventions. Both are addressed here. The approach is
**structure first, then fixes**: design the final architecture knowing all
incoming behavior changes, land a behavior-preserving restructure, then land
each behavioral fix on the clean foundation.

## Gaps being fixed

### P1 — bugs in supported flows

1. **No `encrypted`-event fallback for Widevine/PlayReady.** Sessions are
   only created from manifest PSSH. DASH streams carrying only `default_KID`
   (PSSH in-band in the init segment) never get a session; playback stalls.
2. **No PlayReady `mspr:pro` fallback.** Manifests often carry `<mspr:pro>`
   instead of `<cenc:pssh>`; Shaka synthesizes a v0 PSSH box from it.
3. **Key status policy is wrong.** `internal-error`/`output-restricted` are
   hard failures today; they should restrict the affected streams (filter,
   switch variant, fail only when nothing playable remains). `expired` is
   unhandled; all-keys-expired should be the fatal case. Statuses arrive in
   per-session events for logically-single changes and must be batched
   (0.5 s) before judging, or multi-session content produces spurious fatals.
4. **Teardown can hang.** `session.close()` sometimes never resolves
   (crbug.com/1108158); we await it sequentially, so `setMediaKeys(null)`
   may never run. Each close must race a 1 s timeout.
5. **No key rotation.** Manifest sessions are created once at activation;
   live manifest updates carrying new PSSH never create sessions.

### P2 — robustness gaps

6. **Probe omits `encryptionScheme`.** cbcs content can falsely probe as
   supported on cenc-only devices.
7. **Per-stream probing with video-first access selection.** The chosen
   `MediaKeySystemAccess` never declared audio capabilities, and audio/video
   can probe onto different key systems. Selection must be presentation-wide.
8. **No typed error surface.** All DRM failures end in `console.error`; the
   embedding app cannot observe them (the acknowledged `emitError_` TODO).
9. **No `session.closed` watching.** `hardware-context-reset` (sleep/wake,
   GPU switch) kills sessions silently; they must be recreated.
10. **Smaller:** Widevine default video robustness should be
    `SW_SECURE_DECODE` (audio `SW_SECURE_CRYPTO`); PlayReady unwrap should
    copy `SOAPAction`/`Content-Type` envelope headers (default
    `text/xml; charset=utf-8`); manifest `dashif:Laurl` unsupported.

### Out of scope by design

Expiration polling / proactive renewal, persistent sessions and offline,
ClearKey, HDCP policy checks (`getStatusForPolicy`), in-band PSSH parsing,
individualization servers, `delayLicenseRequestUntilPlayed`, and all
legacy-platform quirks (EdgeHTML keyStatuses argument swap, dummy key IDs,
Xbox little-endian key ID GUIDs, legacy Apple FairPlay polyfill paths,
`com.chromecast.playready` mapping).

## Structural problems being fixed

Deviations from project conventions in `eme_controller.ts`:

- Fire-and-forget async (`void this.activate_()`, `void this.teardown_()`)
  for critical flows; other controllers cancel/stop synchronously and track
  in-flight work.
- Two interleaved state machines (FairPlay lazy-attach vs. manifest path)
  branching inside `activate_`.
- Mixed responsibilities: key-system discovery, MediaKeys lifecycle, session
  management, license exchange, and key-status policy in one class.
- Inline utilities (`toArrayBuffer`, `bytesFingerprint`) instead of
  `lib/utils/`.
- `log.info("error", …)` plus raw `console.error` instead of the Log
  abstraction; `manifest_` cached as a field; stored `onEncrypted_` handler
  field; redundant `mediaKeysAttached_` flag.

## Target architecture

```
lib/drm/
  eme_controller.ts   — orchestrator: gates, license fetch, status batching (~200 lines)
  session_manager.ts  — MediaKeys + session lifecycle
  drm_utils.ts        — existing utils + pure functions: mspr:pro PSSH synthesis,
                        license request building, key status classification
```

Only `session_manager.ts` is a new class file — session lifecycle is real
state with real invariants and is the part needing EME fakes to test.
Stateless logic (license exchange, status classification) follows the
project's pure-function-utils pattern instead of getting classes; the
controller owns the tracked license request and the batching timer, exactly
like `ManifestController.request_` / `GapController.timer_`.

### eme_controller.ts

Follows the established controller shape: event subscriptions
(`MANIFEST_LOADING`, `STREAMS_CREATED`, `MEDIA_ATTACHED`, `MEDIA_DETACHING`,
plus `MANIFEST_UPDATED` for rotation), the readiness gate
(manifest + media + key system selected → activate), the tracked license
request flow (build via `drm_utils`, POST via `NetworkService`, tracked like
`ManifestController.request_`), the 0.5 s key-status batching `timer_`, and
a synchronous `destroy()` that cancels in-flight work and disposes the
session manager. No session state, no inline utils, no cached manifest.

The FairPlay-vs-manifest branching collapses into one activation rule:
*attach MediaKeys eagerly and create manifest sessions when PSSH exists;
otherwise (FairPlay, or no manifest PSSH for the chosen key system) listen
for `encrypted`.* This single rule replaces both code paths and fixes gap 1.

### session_manager.ts

Owns the `MediaKeys` instance and all `MediaKeySession`s:

- Create MediaKeys from the presentation's access; set server certificate
  before any `generateRequest`.
- Attach/detach the media element (single tracked attach promise — no flag).
- Create sessions with byte-level init-data dedup (replaces `psshSeen_`);
  sessions keep `{ initData, initDataType }` metadata for dedup and
  recreation.
- Close each session racing a 1 s timeout (gap 4); on `destroy()`,
  synchronously stop accepting work, then run timed-out closes and
  `setMediaKeys(null)`.
- Watch `session.closed`: `hardware-context-reset` → recreate from stored
  init data (gap 9); other reasons → drop from the active set.
- Narrow callbacks out: `onmessage`, `onkeystatuses`.

### License exchange (drm_utils.ts + controller)

License exchange is stateless, so it is pure functions in `drm_utils.ts` /
`playready_utils.ts`, orchestrated by the controller:

- License URL resolution: app config first, then manifest `dashif:Laurl`.
- PlayReady envelope unwrap (content-sniffed, as today) plus copying
  `SOAPAction`/`Content-Type` headers from the envelope; defaults
  `Content-Type: text/xml; charset=utf-8` when already unwrapped.
- The controller POSTs via `NetworkService` (tracked request) and feeds the
  response to `session.update()` through the session manager.

### Key status policy (drm_utils.ts + controller)

The session manager reports raw `keyStatuses` per session; the controller
accumulates them into one map and debounces 0.5 s with a `Timer`. After the
batch settles, a pure classification function in `drm_utils.ts`
(`statuses → { allExpired, restrictedKeyIds }`) decides:

- Every reported status `expired` → fatal `ALL_KEYS_EXPIRED`.
- Key IDs with `internal-error` / `output-restricted` → restricted set.
- Everything else → usable.

One consolidated verdict per batch (gap 3).

### Key-system selection (stream_utils.ts)

Presentation-level selection replacing per-stream probing (gaps 6, 7, 10):

1. When the manifest carries protection, for each candidate in
   `preferredKeySystems` that appears in the manifest, run **one**
   `decodingInfo` probe combining a representative pair — the
   highest-bandwidth video track and the first audio track of the protected
   switching sets (omit the capability entirely for audio-only or video-only
   presentations) — with `encryptionScheme` from the protection scheme and robustness
   defaults (Widevine video `SW_SECURE_DECODE`, audio `SW_SECURE_CRYPTO`;
   PlayReady `"150"`). First supported candidate wins; its access is the
   presentation's access.
2. Per-track probes then run against the chosen system only (to drop tracks
   the CDM can't handle); their accesses are ignored.

`PROP_KEY_SYSTEM_ACCESS` on streams is removed. The selection result
(key system + access) travels with the built streams; `EmeController` reads
it from the player instead of scanning streams for a symbol.

### Error surface

New `Events.ERROR` carrying a `PlayerError`:

```ts
{ code: ErrorCode, fatal: boolean, cause?: unknown }
```

`ErrorCode` starts with only the DRM codes needed now:
`NO_SUPPORTED_KEY_SYSTEM`, `MEDIA_KEYS_SETUP_FAILED`,
`LICENSE_REQUEST_FAILED`, `LICENSE_RESPONSE_REJECTED`, `ALL_KEYS_EXPIRED`,
`KEY_STATUS_RESTRICTED`. The event surface is general for later adoption by
other controllers; no speculative taxonomy.

Severity rules (mirroring Shaka): a license request failure is fatal only
when it kills the *only* active session — multi-key content survives one key
failing (gap 8 tolerance); `session.update()` rejection is fatal; MediaKeys /
certificate setup failures are fatal.

### Restriction flow

After a status batch settles, restricted key IDs are matched against each
switching set's `defaultKid` (already parsed —
`lib/dash/dash_helpers.ts`). Mechanism: the player holds the current
restricted key ID set; stream selection (ABR + stream controller) excludes
streams whose switching set's `defaultKid` is in that set. The controller
emits the existing `KEY_STATUSES_CHANGED`, updates the restricted set, and
emits an event prompting re-selection; if the active stream became
restricted, a switch is triggered; only when no playable stream remains does
it escalate to fatal `KEY_STATUS_RESTRICTED`. This is the one piece touching
code outside `lib/drm/`.

### Session lifecycle behaviors

- Manifest PSSH sessions are re-evaluated on `MANIFEST_UPDATED`; byte-dedup
  makes it idempotent (gap 5).
- PlayReady: synthesize a v0 PSSH box from `<mspr:pro>` when `<cenc:pssh>`
  is absent (gap 2) — lives in `drm_utils.ts` next to the existing
  ContentProtection mapping.
- The `encrypted` listener feeds `event.initDataType` / `initData` through
  the same dedup'd session-creation path as manifest PSSH.
- FairPlay: unchanged modern-EME behavior — defer `setMediaKeys` to the
  first `encrypted` event, pass `skd` init data untransformed, certificate
  set before `generateRequest`.

### Utilities

`toArrayBuffer` / `bytesFingerprint` move to a shared buffer utils module in
`lib/utils/`. All logging through the `Log` abstraction; no `console.error`.

## Testing

happy-dom has no EME, so `test/__framework__/` gains fakes:
`FakeMediaKeySystemAccess` / `FakeMediaKeys` / `FakeMediaKeySession` with
controllable `message`, `keystatuseschange`, and `closed` triggers, plus a
stubbed `navigator.mediaCapabilities.decodingInfo`. These make the
interesting cases testable: close-timeout hangs, `hardware-context-reset`
recreation, cross-session status batching, rotation dedup.

Tests mirror the module layout per project convention:
`test/drm/session_manager.test.ts`, `eme_controller.test.ts`, the existing
`drm_utils.test.ts` growing cases for license building / status
classification / mspr:pro synthesis (pure functions — no fakes needed), plus
selection tests in the existing `stream_utils` suite.

## Execution stages

Each stage independently shippable, tests included:

1. **Restructure** — behavior-preserving split: session lifecycle extracted
   into `session_manager.ts`, stateless logic into `drm_utils.ts` pure
   functions, inline utils moved to `lib/utils/`, conventions fixed (no
   untracked fire-and-forget async, synchronous destroy, Log usage). EME
   fakes land here.
2. **Error surface** — `Events.ERROR` + `PlayerError`, wired through all DRM
   failure paths. Early because later stages report through it.
3. **Selection rework** — presentation-level key system selection, joint
   audio+video probe, `encryptionScheme`, robustness defaults.
4. **Session lifecycle** — close timeout, `session.closed` watching,
   `encrypted` fallback for non-FairPlay, `mspr:pro` PSSH synthesis, live
   rotation, license client extras (SOAPAction headers, `dashif:Laurl`,
   multi-session failure tolerance).
5. **Key status policy** — the tracker with batching, all-expired fatal, and
   restriction-based stream filtering.
