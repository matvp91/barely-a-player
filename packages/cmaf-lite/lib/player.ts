import { EventEmitter } from "@matvp91/eventemitter3";
import { AbrController } from "./abr/abr_controller";
import type { ConfigPath, ConfigPathValue, PlayerConfig } from "./config";
import { DEFAULT_CONFIG } from "./config";
import { EMPTY_ARRAY, EMPTY_MANIFEST, EMPTY_TIME_RANGES } from "./constants";
import { EmeController } from "./drm/eme_controller";
import type { EventMap } from "./events";
import { Events } from "./events";
import { ManifestController } from "./manifest/manifest_controller";
import { BufferController } from "./media/buffer_controller";
import { GapController } from "./media/gap_controller";
import { StreamController } from "./media/stream_controller";
import { NetworkService } from "./net/network_service";
import { TimelineController } from "./timeline/timeline_controller";
import type { DeepPartial } from "./types/helpers";
import type { Stream } from "./types/media";
import { MediaType } from "./types/media";
import * as ObjectUtils from "./utils/object_utils";

/**
 * CMAF media player. Augments a `<video>` element with adaptive streaming
 * through MSE.
 *
 * @public
 */
export class Player extends EventEmitter<EventMap> {
  private config_ = DEFAULT_CONFIG;
  private media_: HTMLMediaElement | null = null;

  private networkService_: NetworkService;

  private manifestController_: ManifestController;
  private bufferController_: BufferController;
  private gapController_: GapController;
  private streamController_: StreamController;
  private emeController_: EmeController;
  private abrController_: AbrController;
  private timelineController_: TimelineController;

  constructor() {
    super();

    this.networkService_ = new NetworkService(this);

    this.manifestController_ = new ManifestController(this);
    this.bufferController_ = new BufferController(this);
    this.gapController_ = new GapController(this);
    this.streamController_ = new StreamController(this);
    this.emeController_ = new EmeController(this);
    this.abrController_ = new AbrController(this);
    this.timelineController_ = new TimelineController(this);
  }

  /**
   * Starts loading and parsing the manifest at the given URL,
   * then begins segment fetching. A media element must be
   * attached via {@link Player.attachMedia} before calling this.
   *
   * @param url - Manifest URL (e.g. a DASH `.mpd`).
   */
  load(url: string) {
    this.emit(Events.MANIFEST_LOADING, { url });
  }

  /**
   * Returns the attached media element, or null.
   */
  getMedia() {
    return this.media_;
  }

  /**
   * Merges the given config into the current config. Accepts either a
   * deep-partial object or a dot-notation path with a value.
   */
  setConfig(config: DeepPartial<PlayerConfig>): void;
  setConfig<P extends ConfigPath>(path: P, value: ConfigPathValue<P>): void;
  setConfig(
    pathOrConfig: string | DeepPartial<PlayerConfig>,
    value?: unknown,
  ): void {
    ObjectUtils.deepMerge(
      this.config_,
      typeof pathOrConfig === "string"
        ? ObjectUtils.unflattenPath(pathOrConfig, value)
        : pathOrConfig,
    );
  }

  /**
   * Returns the current player config.
   */
  getConfig() {
    return this.config_;
  }

  /**
   * Returns the current manifest.
   */
  getManifest() {
    return this.manifestController_.getManifest() ?? EMPTY_MANIFEST;
  }

  /**
   * Returns the presentation timeline. The returned object is stable
   * across calls; its fields compute on read, so it always reflects
   * the current manifest, config, and media state.
   */
  getTimeline() {
    return this.timelineController_.getTimeline();
  }

  /**
   * Returns buffered time ranges for the given media type.
   */
  getBuffered(type: MediaType) {
    if (type === MediaType.SUBTITLE) {
      return EMPTY_TIME_RANGES;
    }
    return this.bufferController_.getBuffered(type) ?? EMPTY_TIME_RANGES;
  }

  /**
   * Returns resolved streams for the given media type.
   */
  getStreams<T extends MediaType>(type: T) {
    return this.streamController_.getStreams(type) ?? EMPTY_ARRAY;
  }

  /**
   * Returns the currently active stream for the given type.
   */
  getActiveStream<T extends MediaType>(type: T) {
    return this.streamController_.getActiveStream(type) ?? null;
  }

  /**
   * Set a stream.
   */
  setActiveStream(stream: Stream) {
    return this.streamController_.setStream(stream);
  }

  /**
   * Returns the network service instance.
   */
  getNetworkService() {
    return this.networkService_;
  }

  /**
   * Attaches a `<video>` or `<audio>` element. Required before playback
   * can begin.
   */
  attachMedia(media: HTMLMediaElement) {
    if (this.media_) {
      throw new Error("Already has a media element attached");
    }
    this.media_ = media;
    this.emit(Events.MEDIA_ATTACHING, { media });
  }

  /**
   * Detaches the current media element.
   */
  detachMedia() {
    if (!this.media_) {
      return;
    }
    this.emit(Events.MEDIA_DETACHING, { media: this.media_ });
    this.media_ = null;
    this.emit(Events.MEDIA_DETACHED);
  }

  /**
   * Destroys the player and releases all resources. The instance cannot
   * be reused after this call.
   */
  destroy() {
    this.manifestController_.destroy();
    this.bufferController_.destroy();
    this.gapController_.destroy();
    this.streamController_.destroy();
    this.emeController_.destroy();
    this.abrController_.destroy();
    this.timelineController_.destroy();
    this.removeAllListeners();
  }
}
