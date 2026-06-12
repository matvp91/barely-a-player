import type {
  InitSegment,
  Manifest,
  MediaType,
  NetworkRequest,
  NetworkRequestType,
  NetworkResponse,
  Segment,
  SourceBufferMediaType,
  Stream,
  VideoStream,
} from ".";
import type { KeySystem } from "./types/drm";

/**
 * Event name constants emitted by the {@link Player}.
 *
 * @public
 */
export const Events = {
  MANIFEST_LOADING: "manifestLoading",
  MANIFEST_UPDATED: "manifestUpdated",
  MEDIA_ATTACHING: "mediaAttaching",
  MEDIA_ATTACHED: "mediaAttached",
  MEDIA_DETACHING: "mediaDetaching",
  MEDIA_DETACHED: "mediaDetached",
  BUFFER_CODECS: "bufferCodecs",
  BUFFER_APPENDING: "bufferAppending",
  BUFFER_APPENDED: "bufferAppended",
  BUFFER_EOS: "bufferEos",
  BUFFER_FLUSH: "bufferFlush",
  BUFFER_FLUSHED: "bufferFlushed",
  BUFFER_APPEND_ERROR: "bufferAppendError",
  STREAMS_CREATED: "streamsCreated",
  STREAM_CHANGED: "streamChanged",
  ABR_ADAPT: "abrAdapt",
  TIMELINE_UPDATED: "timelineUpdated",
  NETWORK_REQUEST: "networkRequest",
  NETWORK_RESPONSE: "networkResponse",
  KEY_SESSION_CREATED: "keySessionCreated",
  KEY_STATUSES_CHANGED: "keyStatusesChanged",
} as const;

/**
 * Fired when {@link Player.load} started loading a manifest.
 *
 * @public
 */
export interface ManifestLoadingEvent {
  url: string;
}

/**
 * Fired when a live manifest has been refreshed and reconciled in place.
 * Carries the same mutated manifest reference that consumers already hold.
 *
 * @public
 */
export interface ManifestUpdatedEvent {
  manifest: Manifest;
  isUpdate: boolean;
}

/**
 * Fired when {@link Player.attachMedia} is called and the media element
 * is being attached.
 *
 * @public
 */
export interface MediaAttachingEvent {
  media: HTMLMediaElement;
}

/**
 * Fired when the media element and MediaSource are ready for buffering.
 *
 * @public
 */
export interface MediaAttachedEvent {
  media: HTMLMediaElement;
  mediaSource: MediaSource;
}

/**
 * Fired when {@link Player.detachMedia} is called, before the media element
 * is detached. Listeners can perform detach-time cleanup that needs access
 * to the media element.
 *
 * @public
 */
export interface MediaDetachingEvent {
  media: HTMLMediaElement;
}

/**
 * Fired when a SourceBuffer is being created for a new media type.
 *
 * @public
 */
export interface BufferCodecsEvent {
  type: SourceBufferMediaType;
  codec: string;
}

/**
 * Fired before a segment is appended to a SourceBuffer.
 *
 * @public
 */
export interface BufferAppendingEvent {
  type: SourceBufferMediaType;
  segment: InitSegment | Segment;
  data: ArrayBuffer;
}

/**
 * Fired after a segment has been appended to a SourceBuffer.
 *
 * @public
 */
export interface BufferAppendedEvent {
  type: SourceBufferMediaType;
  segment: InitSegment | Segment;
  data: ArrayBuffer;
}

/**
 * Fired when a SourceBuffer append operation failed.
 *
 * @public
 */
export interface BufferAppendErrorEvent {
  type: SourceBufferMediaType;
  error: DOMException;
}

/**
 * Fired to request a SourceBuffer flush. Paired with
 * {@link BufferFlushedEvent}, which fires after the flush completes.
 *
 * @public
 */
export interface BufferFlushEvent {
  type: SourceBufferMediaType;
}

/**
 * Fired when a SourceBuffer is flushed.
 *
 * @public
 */
export interface BufferFlushedEvent {
  type: SourceBufferMediaType;
}

/**
 * Fired when the active stream changes for a media type.
 * `oldStream` is `null` on initial stream selection.
 *
 * @public
 */
export interface StreamChangedEvent<T extends MediaType = MediaType> {
  type: T;
  oldStream: Stream<T> | null;
  stream: Stream<T>;
}

/**
 * Fired when ABR decides to adapt.
 *
 * @public
 */
export interface AbrAdaptEvent {
  stream: VideoStream;
}

/**
 * Fired before a network request is sent. Listeners can mutate the request
 * URL, headers, and method.
 *
 * @public
 */
export interface NetworkRequestEvent {
  type: NetworkRequestType;
  request: NetworkRequest;
}

/**
 * Fired when a network response has been received.
 *
 * @public
 */
export interface NetworkResponseEvent {
  type: NetworkRequestType;
  response: NetworkResponse;
}

/**
 * Fired when EmeController creates a new MediaKeySession.
 *
 * @public
 */
export interface KeySessionCreatedEvent {
  keySystem: KeySystem;
  sessionId: string;
}

/**
 * Fired when a session's key statuses change.
 *
 * @public
 */
export interface KeyStatusesChangedEvent {
  sessionId: string;
  statuses: Map<string, MediaKeyStatus>;
}

/**
 * Maps each event name to its listener signature.
 *
 * @public
 */
export interface EventMap {
  [Events.MANIFEST_LOADING]: (event: ManifestLoadingEvent) => void;
  [Events.MANIFEST_UPDATED]: (event: ManifestUpdatedEvent) => void;
  [Events.MEDIA_ATTACHING]: (event: MediaAttachingEvent) => void;
  [Events.MEDIA_ATTACHED]: (event: MediaAttachedEvent) => void;
  [Events.MEDIA_DETACHING]: (event: MediaDetachingEvent) => void;
  [Events.MEDIA_DETACHED]: undefined;
  [Events.BUFFER_CODECS]: (event: BufferCodecsEvent) => void;
  [Events.BUFFER_APPENDING]: (event: BufferAppendingEvent) => void;
  [Events.BUFFER_APPENDED]: (event: BufferAppendedEvent) => void;
  [Events.BUFFER_EOS]: undefined;
  [Events.BUFFER_FLUSH]: (event: BufferFlushEvent) => void;
  [Events.BUFFER_APPEND_ERROR]: (event: BufferAppendErrorEvent) => void;
  [Events.BUFFER_FLUSHED]: (event: BufferFlushedEvent) => void;
  [Events.STREAMS_CREATED]: undefined;
  [Events.STREAM_CHANGED]: (event: StreamChangedEvent) => void;
  [Events.ABR_ADAPT]: (event: AbrAdaptEvent) => void;
  [Events.TIMELINE_UPDATED]: undefined;
  [Events.NETWORK_REQUEST]: (event: NetworkRequestEvent) => void;
  [Events.NETWORK_RESPONSE]: (event: NetworkResponseEvent) => void;
  [Events.KEY_SESSION_CREATED]: (event: KeySessionCreatedEvent) => void;
  [Events.KEY_STATUSES_CHANGED]: (event: KeyStatusesChangedEvent) => void;
}
