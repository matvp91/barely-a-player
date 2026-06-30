import { PROP_HIERARCHY } from "../constants";
import type {
  AbrAdaptEvent,
  BufferFlushedEvent,
  ManifestUpdatedEvent,
  MediaAttachedEvent,
  StreamsUpdatingEvent,
} from "../events";
import { Events } from "../events";
import type { NetworkRequest } from "../net/network_request";
import type { Player } from "../player";
import type { InitSegment, Segment } from "../types/manifest";
import type { Stream } from "../types/media";
import { MediaType } from "../types/media";
import { ABORTED, NetworkRequestType } from "../types/net";
import * as ArrayUtils from "../utils/array_utils";
import * as asserts from "../utils/asserts";
import { Log } from "../utils/log";
import * as ManifestUtils from "../utils/manifest_utils";
import * as StreamUtils from "../utils/stream_utils";
import * as TimeRangesUtils from "../utils/time_ranges_utils";
import { Timer } from "../utils/timer";

const log = Log.create("StreamController");

const TICK_INTERVAL = 0.1;

type MediaState = {
  type: MediaType;
  lastSegment: Segment | null;
  lastInitSegment: InitSegment | null;
  request: NetworkRequest | null;
  ended: boolean;
  timer: Timer;
};

export class StreamController {
  private isLive_ = false;
  private rangeStart_ = 0;
  private rangeEnd_ = 0;
  private streams_ = new Map<MediaType, Stream[]>();
  private restrictedKeyIds_ = new Set<string>();
  private keySystemAccess_: MediaKeySystemAccess | null = null;
  private activeStream_ = new Map<MediaType, Stream>();
  private media_: HTMLMediaElement | null = null;
  private mediaStates_ = new Map<MediaType, MediaState>();

  constructor(private player_: Player) {
    this.player_.on(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHED, this.onMediaDetached_);
    this.player_.on(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.player_.on(Events.ABR_ADAPT, this.onAbrAdapt_);
    this.player_.on(Events.STREAMS_UPDATING, this.onStreamsUpdating_);
  }

  getStreams<T extends MediaType>(type: T) {
    const list = this.streams_.get(type);
    if (!list) {
      return null;
    }
    // The playable set: streams whose key is not restricted by key status.
    return list.filter(
      (s) => !StreamUtils.isStreamRestricted(s, this.restrictedKeyIds_),
    ) as Stream<T>[];
  }

  getKeySystemAccess() {
    return this.keySystemAccess_;
  }

  getActiveStream<T extends MediaType>(type: T) {
    const stream = this.activeStream_.get(type);
    return stream as Stream<T> | null;
  }

  setStream(stream: Stream) {
    this.switchStream_(stream);
  }

  destroy() {
    const networkService = this.player_.getNetworkService();
    for (const mediaState of this.mediaStates_.values()) {
      if (mediaState.request) {
        networkService.cancel(mediaState.request);
      }
      mediaState.timer.stop();
    }
    this.player_.off(Events.MANIFEST_UPDATED, this.onManifestUpdated_);
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHED, this.onMediaDetached_);
    this.player_.off(Events.BUFFER_FLUSHED, this.onBufferFlushed_);
    this.player_.off(Events.ABR_ADAPT, this.onAbrAdapt_);
    this.player_.off(Events.STREAMS_UPDATING, this.onStreamsUpdating_);
    this.mediaStates_.clear();
  }

  private onManifestUpdated_ = async (event: ManifestUpdatedEvent) => {
    // Update manifest info.
    this.isLive_ = event.manifest.isLive;
    this.rangeStart_ = event.manifest.start;
    this.rangeEnd_ = event.manifest.end;

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
      this.player_.emit(Events.STREAMS_UPDATED);
      this.tryStart_();
    }
  };

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("seeking", this.onSeeking_);
    this.tryStart_();
  };

  private onBufferFlushed_ = (event: BufferFlushedEvent) => {
    const mediaState = this.mediaStates_.get(event.type);
    if (mediaState) {
      mediaState.lastSegment = null;
      mediaState.lastInitSegment = null;
    }
  };

  private onAbrAdapt_ = (event: AbrAdaptEvent) => {
    this.switchStream_(event.stream);
  };

  private onStreamsUpdating_ = (event: StreamsUpdatingEvent) => {
    // Apply the new restriction set, switch any now-unplayable active stream
    // to the first playable one of its type, then announce the changed
    // playable set so ABR and others re-evaluate.
    this.restrictedKeyIds_ = event.restrictedKeyIds;
    for (const type of this.streams_.keys()) {
      if (type === MediaType.SUBTITLE) {
        continue;
      }
      const active = this.getActiveStream(type);
      if (
        !active ||
        !StreamUtils.isStreamRestricted(active, this.restrictedKeyIds_)
      ) {
        continue;
      }
      const replacement = this.getStreams(type)?.[0];
      if (replacement) {
        this.switchStream_(replacement);
      }
    }
    this.player_.emit(Events.STREAMS_UPDATED);
  };

  private switchStream_(stream: Stream) {
    const { type } = stream;
    const oldStream = this.getActiveStream(type);
    if (oldStream === stream) {
      return;
    }

    // Update the active stream before we execute the actual switch,
    // we're allowed to change streams before having a mediaState.
    this.activeStream_.set(type, stream);

    const mediaState = this.mediaStates_.get(type);
    if (!mediaState) {
      return;
    }

    const networkService = this.player_.getNetworkService();
    if (mediaState.request) {
      networkService.cancel(mediaState.request);
    }

    const { switchingSet } = stream[PROP_HIERARCHY];
    if (!oldStream || oldStream[PROP_HIERARCHY].switchingSet !== switchingSet) {
      if (isAV(type)) {
        this.player_.emit(Events.BUFFER_CODECS, {
          type,
          codec: switchingSet.codec,
        });
      }
      // Non-AV types (e.g. text) do not use MSE SourceBuffers,
      // so no codec signalling is needed.
    }

    mediaState.lastSegment = null;
    mediaState.lastInitSegment = null;

    log.info("Switched stream", stream);

    this.player_.emit(Events.STREAM_CHANGED, {
      type,
      oldStream,
      stream,
    });
  }

  private onMediaDetached_ = () => {
    const networkService = this.player_.getNetworkService();
    for (const mediaState of this.mediaStates_.values()) {
      if (mediaState.request) {
        networkService.cancel(mediaState.request);
      }
      mediaState.timer.stop();
    }
    this.media_?.removeEventListener("seeking", this.onSeeking_);
    this.media_ = null;
  };

  private getInitialTime_(): number {
    if (!this.isLive_) {
      return this.rangeStart_;
    }
    const { liveDelay } = this.player_.getConfig();
    return Math.max(this.rangeEnd_ - liveDelay, this.rangeStart_);
  }

  private resolveStream_(type: MediaType, streams: Stream[]): Stream {
    asserts.assertExists(streams[0], "No Streams");
    const { preferences } = this.player_.getConfig();
    const matches = StreamUtils.findStreamsMatchingPreferences(
      type,
      streams,
      preferences,
    );
    const activeStream = this.getActiveStream(type);
    if (matches[0]) {
      if (activeStream) {
        // If we have an active stream already (ABR might have set one), we can
        // find the closest stream of our matches to respect bandwidth estimation.
        const closestStream = StreamUtils.pickClosestByBandwidth(
          matches,
          activeStream,
        );
        if (closestStream) {
          return closestStream;
        }
      }
      // The first match has the highest priority.
      return matches[0];
    }
    if (activeStream) {
      return activeStream;
    }
    return streams[0];
  }

  private tryStart_() {
    if (!this.media_) {
      return;
    }

    for (const [type, streams] of this.streams_) {
      if (type === MediaType.SUBTITLE) {
        // We can't do anything with SUBTITLE here, but we shall not
        // include it in our streamsMap to begin with.
        // TODO(matvp): We shall not include this in our streamsMap to
        // begin with.
        continue;
      }
      const stream = this.resolveStream_(type, streams);
      this.activeStream_.set(type, stream);
      log.info("Initial", type, stream);

      const mediaState: MediaState = {
        type,
        ended: false,
        lastSegment: null,
        lastInitSegment: null,
        request: null,
        timer: new Timer(() => this.update_(mediaState)),
      };
      this.mediaStates_.set(type, mediaState);

      if (isAV(type)) {
        const { switchingSet } = stream[PROP_HIERARCHY];
        this.player_.emit(Events.BUFFER_CODECS, {
          type,
          codec: switchingSet.codec,
        });
      }

      this.player_.emit(Events.STREAM_CHANGED, {
        type,
        oldStream: null,
        stream,
      });
    }

    if (this.media_) {
      this.media_.currentTime = this.getInitialTime_();
    }

    for (const mediaState of this.mediaStates_.values()) {
      mediaState.timer.tickEvery(TICK_INTERVAL);
    }
  }

  /**
   * Core streaming tick. Finds the next segment to fetch
   * via sequential index or time-based lookup.
   */
  private update_(mediaState: MediaState) {
    const stream = this.getActiveStream(mediaState.type);
    asserts.assertExists(stream, `No stream for ${mediaState.type}`);

    if (mediaState.ended || mediaState.request?.inFlight) {
      return;
    }
    if (!this.media_) {
      return;
    }

    const currentTime = this.media_.currentTime;
    const frontBufferLength = this.player_.getConfig().frontBufferLength;
    const bufferEnd = this.getBufferEnd_(mediaState.type, currentTime);

    if (bufferEnd !== null && bufferEnd - currentTime >= frontBufferLength) {
      return;
    }

    let segment = this.getNextSegment_(mediaState, stream);
    if (!segment) {
      if (this.isEnded_(mediaState, stream)) {
        mediaState.ended = true;
        this.checkEndOfStream_();
        return;
      }

      const lookupTime =
        bufferEnd ?? Math.max(0, currentTime - /* maybeSegmentSize= */ 4);
      segment = this.getSegmentForTime_(stream, lookupTime);
      log.debug(`Segment by time at ${lookupTime}`, segment);
    } else {
      log.debug(`Segment by index`, segment);
    }

    if (!segment) {
      if (!this.isLive_) {
        mediaState.ended = true;
        this.checkEndOfStream_();
      }
      return;
    }

    if (segment.initSegment !== mediaState.lastInitSegment) {
      this.loadSegment_(mediaState, segment.initSegment);
    } else if (segment !== mediaState.lastSegment) {
      this.loadSegment_(mediaState, segment);
    }
  }

  private async loadSegment_(
    mediaState: MediaState,
    segment: Segment | InitSegment,
  ) {
    const networkService = this.player_.getNetworkService();
    const config = this.player_.getConfig();

    mediaState.request = networkService.request(
      NetworkRequestType.SEGMENT,
      segment.url,
      config.segmentRequestOptions,
    );

    const response = await mediaState.request.promise;
    if (response === ABORTED) {
      return;
    }

    // Update mediaState AFTER we fetched, it means that we
    // sent this segment to the buffer controller.
    if (ManifestUtils.isInitSegment(segment)) {
      mediaState.lastInitSegment = segment;
    }
    if (ManifestUtils.isMediaSegment(segment)) {
      mediaState.lastSegment = segment;
    }

    if (isAV(mediaState.type)) {
      // If audio or video, we can send it to the buffer controller.
      this.player_.emit(Events.BUFFER_APPENDING, {
        type: mediaState.type,
        segment,
        data: response.arrayBuffer,
      });
    }
  }

  private getBufferEnd_(type: MediaType, time: number): number | null {
    const { maxBufferHole } = this.player_.getConfig();
    const buffered = this.player_.getBuffered(type);
    return TimeRangesUtils.getBufferedEnd(buffered, time, maxBufferHole);
  }

  private getNextSegment_(
    mediaState: MediaState,
    stream: Stream,
  ): Segment | null {
    if (!mediaState.lastSegment) {
      return null;
    }
    const { track } = stream[PROP_HIERARCHY];
    const lastIndex = track.segments.indexOf(mediaState.lastSegment);
    return track.segments[lastIndex + 1] ?? null;
  }

  private getSegmentForTime_(stream: Stream, time: number): Segment | null {
    const { maxSegmentLookupTolerance } = this.player_.getConfig();
    const { track } = stream[PROP_HIERARCHY];
    return ArrayUtils.binarySearch(track.segments, (seg) => {
      if (time >= seg.start && time < seg.end) {
        return 0;
      }
      if (time < seg.start) {
        const tolerance = Math.min(
          maxSegmentLookupTolerance,
          seg.end - seg.start,
        );
        if (seg.start - tolerance > time && seg.start > 0) {
          return -1;
        }
        return 0;
      }
      return 1;
    });
  }

  private isEnded_(mediaState: MediaState, stream: Stream): boolean {
    if (this.isLive_) {
      return false;
    }
    if (!mediaState.lastSegment) {
      return false;
    }
    const { track } = stream[PROP_HIERARCHY];
    const { segments } = track;
    return segments.indexOf(mediaState.lastSegment) === segments.length - 1;
  }

  private checkEndOfStream_() {
    const mediaStates = Array.from(this.mediaStates_.values());
    const allDone = mediaStates.every((ms) => ms.ended);
    if (allDone) {
      this.player_.emit(Events.BUFFER_EOS);
    }
  }

  private onSeeking_ = () => {
    for (const mediaState of this.mediaStates_.values()) {
      mediaState.ended = false;
      if (mediaState.request) {
        const networkService = this.player_.getNetworkService();
        networkService.cancel(mediaState.request);
      }
      mediaState.lastSegment = null;
      this.update_(mediaState);
    }
  };
}

function isAV(type: MediaType) {
  return type === MediaType.AUDIO || type === MediaType.VIDEO;
}
