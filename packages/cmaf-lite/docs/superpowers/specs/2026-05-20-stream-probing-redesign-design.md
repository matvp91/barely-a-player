# Stream Probing Redesign

## Context

`lib/utils/stream_utils.ts` builds `Stream`s from a parsed `Manifest` by
probing each track with `navigator.mediaCapabilities.decodingInfo`. The
current implementation has several frictions:

- `buildStreams` takes `DrmConfig` directly, coupling stream building to
  one slice of config instead of the full `PlayerConfig`.
- Key system candidates are filtered by what the manifest's `protection`
  block lists, but the browser is the actual source of truth for which
  key system is supported. The intersection adds nothing in practice and
  makes the flow harder to reason about.
- The MSE/EME content-type string `video/mp4; codecs="…"` is built inline
  in three places. `codec_utils.getContentType` exists for exactly this
  purpose but is unused inside `stream_utils`.
- Probing is split across `probeDecodingInfo` (loops key systems) and
  `probeOnce` (single call). The split is artificial — `probeOnce` is
  just "build config + call decodingInfo".
- The `DecodingProbe` wrapper type duplicates `keySystemAccess`, which
  already lives on `MediaCapabilitiesDecodingInfo`.
- Probe inputs use hardcoded values that should come from the manifest:
  video `framerate: 30`, audio `channels: "2"`, audio `samplerate: 48000`.

## Goal

Restructure probing so the flow is clearer, `PlayerConfig` is
authoritative for DRM ordering, mime-type construction is centralized,
and probe inputs reflect actual track metadata with documented sane
defaults when missing.

## Non-Goals

- Session-level key system resolution (one `MediaKeySystemAccess` per
  session). The current per-track resolution model is retained.
- Expanding `DrmConfig` with per-key-system probe options
  (`robustness`, `distinctiveIdentifier`, `persistentState`,
  `sessionTypes`). Current values become documented defaults.
- Changes to `EmeController`, `BufferController`, `StreamController`
  beyond updating the `buildStreams` call site.

## Design

### Pipeline shape

```
buildStreams(manifest, config)
  └─ for each switchingSet × track:
       buildStream(switchingSet, track, config)
         └─ probeTrack(track, switchingSet, config)
              └─ buildDecodingConfig(track, switchingSet, keySystem?)
              └─ navigator.mediaCapabilities.decodingInfo(...)
         └─ if supported: construct Stream with decodingInfo
            (+ keySystemAccess if present)
         └─ else: return null (track is dropped)
```

### Function shapes

```ts
// Public entry — unchanged caller-side contract except signature.
export async function buildStreams(
  manifest: Manifest,
  config: PlayerConfig,
): Promise<Map<MediaType, Stream[]>>;

// Per-track construction. Pulls drm out of config internally.
async function buildStream(
  switchingSet: SwitchingSet,
  track: Track,
  config: PlayerConfig,
): Promise<Stream | null>;

// Single probe function. Loops candidate key systems (config order) for
// protected content, or runs a single unprotected probe for clear
// content. Returns the first supported result, or the last unsupported
// one.
async function probeTrack(
  track: Track,
  switchingSet: SwitchingSet,
  config: PlayerConfig,
): Promise<MediaCapabilitiesDecodingInfo>;

// Pure builder — the single source of truth for what we hand to
// mediaCapabilities. Uses getContentType for both the media contentType
// and the EME capability contentType.
function buildDecodingConfig(
  track: Track,
  switchingSet: SwitchingSet,
  keySystem?: KeySystem,
): MediaDecodingConfiguration;
```

`probeDecodingInfo`, `probeOnce`, and the `DecodingProbe` wrapper type
are removed.

### Key system selection

For protected content, `probeTrack` iterates
`config.drm.preferredKeySystems` in order. The
`switchingSet.protection.keySystems` intersection filter is removed —
config is authoritative for ordering, and the browser is authoritative
for support. The first probe that returns `supported: true` wins for
that track.

A track is considered protected when `switchingSet.protection` is
present. Clear tracks run a single probe with no
`keySystemConfiguration`.

### DRM probe defaults

`DrmConfig` does not grow in this change. The current hardcoded values
become documented defaults inside `buildDecodingConfig`:

| Field                    | Default                                  |
|--------------------------|------------------------------------------|
| `initDataTypes`          | `["cenc"]`                               |
| `distinctiveIdentifier`  | `"optional"`                             |
| `persistentState`        | `"optional"`                             |
| `sessionTypes`           | `["temporary"]`                          |
| `robustness` (Widevine)  | `"SW_SECURE_CRYPTO"`                     |
| `robustness` (PlayReady) | `"150"`                                  |
| `robustness` (other)     | `""`                                     |

A follow-up may make these config-driven; out of scope here.

### Manifest enrichment

Add optional fields to track types in `lib/types/manifest.ts`:

```ts
interface VideoTrack extends BaseTrack {
  type: MediaType.VIDEO;
  width: number;
  height: number;
  frameRate?: number;
}

interface AudioTrack extends BaseTrack {
  type: MediaType.AUDIO;
  channels?: number;
  sampleRate?: number;
}
```

Update `lib/dash/dash_parser.ts` to populate them using the existing
`Functional.findMap([representation, adaptationSet], …)` fallback
pattern:

- `frameRate`: `@frameRate` attribute on `Representation` or
  `AdaptationSet`. Parsed as a number; DASH allows `"30"` or `"30000/1001"`
  fractional form — parse both, store as a decimal number.
- `sampleRate`: `@audioSamplingRate` attribute on `Representation` or
  `AdaptationSet`. May be a single value or space-separated list — take
  the first.
- `channels`: `AudioChannelConfiguration@value` child element under
  `Representation` or `AdaptationSet`. Parse as a number. Stored values
  vary by `schemeIdUri`; for this change, only handle the common
  `urn:mpeg:dash:23003:3:audio_channel_configuration:2011` and
  `urn:mpeg:mpegB:cicp:ChannelConfiguration` schemes where `@value` is
  the channel count.

When a field is missing, the track field stays `undefined` and
`buildDecodingConfig` falls back to:

| Probe input | Fallback |
|---|---|
| video `framerate` | `30` |
| audio `channels`  | `"2"` |
| audio `samplerate` | `48000` |

### `Stream` shape

Unchanged. `Stream` still carries `[PROP_HIERARCHY]`,
`[PROP_DECODING_INFO]`, and optional `[PROP_KEY_SYSTEM_ACCESS]`. ABR's
use of `decodingInfo` (smooth / powerEfficient hints) is preserved.

`buildStream` reads `keySystemAccess` directly off the
`MediaCapabilitiesDecodingInfo` result returned by `probeTrack` (the
native field, typed `MediaKeySystemAccess | null`) and attaches it to
the Stream when present:

```ts
const info = await probeTrack(track, switchingSet, config);
if (!info.supported) return null;
const stream: VideoStream = {
  /* ... */
  [PROP_DECODING_INFO]: info,
};
if (info.keySystemAccess) {
  stream[PROP_KEY_SYSTEM_ACCESS] = info.keySystemAccess;
}
```

### Call site updates

- `lib/media/stream_controller.ts` — change
  `StreamUtils.buildStreams(manifest, this.config_.drm)` to
  `StreamUtils.buildStreams(manifest, this.config_)`.

## Testing

- `test/utils/stream_utils.test.ts` — update all `buildStreams(manifest, DEFAULT_DRM_CONFIG)`
  call sites to pass a full `PlayerConfig`. Add `DEFAULT_CONFIG` fixture
  if not already present.
- Add coverage for the removal of the protection-intersection filter:
  a protected switching set whose `protection.keySystems` does not list
  the configured key system should still probe (and the test should
  assert the probe was attempted with the configured key system).
- Add coverage for `buildDecodingConfig` populating from manifest fields
  vs falling back to defaults.
- DASH parser tests — add fixtures exercising `@frameRate` (both decimal
  and fractional forms), `@audioSamplingRate`, and
  `AudioChannelConfiguration@value`, plus the missing-field paths.

## Migration

Single PR. No public API change beyond the internal `buildStreams`
signature (used only by `StreamController`). Manifest type additions are
optional fields, so existing consumers compile unchanged. Probe
behavior changes only in edge cases where the manifest's
`protection.keySystems` excluded a configured key system — those tracks
will now be probed and may become supported where they previously
weren't.
