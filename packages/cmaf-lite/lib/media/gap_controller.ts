import type { MediaAttachedEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import { Log } from "../utils/log";
import * as TimeRangesUtils from "../utils/time_ranges_utils";
import { Timer } from "../utils/timer";

const log = Log.create("GapController");

const TICK_INTERVAL = 0.1;
const MAX_GAP_JUMP = 2;
const GAP_PADDING = 0.1;

export class GapController {
  private media_: HTMLMediaElement | null = null;
  private timer_: Timer;
  private stalled_ = false;
  private lastCurrentTime_ = 0;

  constructor(private player_: Player) {
    this.timer_ = new Timer(() => this.poll_());
    this.player_.on(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.on(Events.MEDIA_DETACHED, this.onMediaDetached_);
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.MEDIA_ATTACHED, this.onMediaAttached_);
    this.player_.off(Events.MEDIA_DETACHED, this.onMediaDetached_);
    this.media_ = null;
  }

  private onMediaAttached_ = (event: MediaAttachedEvent) => {
    this.media_ = event.media;
    this.media_.addEventListener("seeking", this.onSeeking_);
    this.timer_.tickEvery(TICK_INTERVAL);
  };

  private onMediaDetached_ = () => {
    this.timer_.stop();
    this.media_?.removeEventListener("seeking", this.onSeeking_);
    this.media_ = null;
    this.stalled_ = false;
  };

  private onSeeking_ = () => {
    this.stalled_ = false;
  };

  private poll_() {
    const media = this.media_;
    if (!media) {
      return;
    }

    const currentTime = media.currentTime;

    if (currentTime !== this.lastCurrentTime_) {
      this.lastCurrentTime_ = currentTime;
      this.stalled_ = false;
      return;
    }

    if (media.paused || media.ended || media.buffered.length === 0) {
      return;
    }

    // Wait one tick before acting to let the browser self-resolve.
    if (!this.stalled_) {
      this.stalled_ = true;
      return;
    }

    const nextStart = TimeRangesUtils.getNextBufferedStart(
      media.buffered,
      media.currentTime,
    );
    if (nextStart === null) {
      return;
    }

    const from = media.currentTime;
    const to = nextStart;
    const gap = to - from;
    if (gap <= MAX_GAP_JUMP) {
      log.info(
        `Jumped gap (${gap.toFixed(3)}) from ${from.toFixed(3)} to ${to.toFixed(3)}`,
      );
      media.currentTime = to + GAP_PADDING;
    }
  }
}
