import type { NetworkResponseEvent } from "../events";
import { Events } from "../events";
import type { Player } from "../player";
import type { VideoStream } from "../types/media";
import { MediaType } from "../types/media";
import { NetworkRequestType } from "../types/net";
import { Log } from "../utils/log";
import * as StreamUtils from "../utils/stream_utils";
import { Timer } from "../utils/timer";
import { ThroughputEstimator } from "./throughput_estimator";

const log = Log.create("AbrController");

export class AbrController {
  private player_: Player;
  private timer_: Timer;
  private throughput_: ThroughputEstimator;
  private lastSwitchAt_ = -Infinity;
  private candidateStream_: VideoStream | null = null;

  constructor(player: Player) {
    this.player_ = player;

    const { abr } = player.getConfig();
    this.throughput_ = new ThroughputEstimator(abr);

    this.timer_ = new Timer(() => this.onEvaluate_());

    this.player_.on(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.on(Events.STREAMS_CREATED, this.onStreamsCreated_);
  }

  destroy() {
    this.timer_.stop();
    this.player_.off(Events.NETWORK_RESPONSE, this.onNetworkResponse_);
    this.player_.off(Events.STREAMS_CREATED, this.onStreamsCreated_);
  }

  private onStreamsCreated_ = () => {
    // When we have streams, evaluate which may lead to a
    // different default stream selection.
    this.evaluate_();
  };

  private onNetworkResponse_ = (event: NetworkResponseEvent) => {
    if (event.type === NetworkRequestType.SEGMENT) {
      const { response } = event;
      this.throughput_.sample(
        response.durationSec,
        response.arrayBuffer.byteLength,
      );
    }
  };

  private evaluate_() {
    this.timer_.tickNow().tickEvery(1);
  }

  private onEvaluate_() {
    const restricted = this.player_.getRestrictedKeyIds();
    const streams = this.player_
      .getStreams(MediaType.VIDEO)
      .filter((s) => !StreamUtils.isStreamRestricted(s, restricted));
    if (streams.length === 0) {
      return;
    }
    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    const { abr } = this.player_.getConfig();
    const bw = this.throughput_.getEstimate() ?? abr.defaultBandwidthEstimate;

    // Throughput-driven pick. Asymmetric upgrade/downgrade thresholds
    // give the single-signal decision the stability it needs.
    let pick: VideoStream | null = null;
    for (const stream of streams) {
      let scaled = bw;
      if (activeStream) {
        scaled *=
          stream.bandwidth > activeStream.bandwidth
            ? abr.bandwidthUpgradeTarget
            : abr.bandwidthDowngradeTarget;
      }
      if (stream.bandwidth <= scaled) {
        pick = stream;
      }
    }
    pick = pick ?? streams[0] ?? null;
    if (!pick) {
      return;
    }

    this.candidateStream_ = pick;
    this.trySwitch_();
  }

  private trySwitch_() {
    if (!this.candidateStream_) {
      return;
    }

    const { abr } = this.player_.getConfig();
    const now = performance.now();
    if (now - this.lastSwitchAt_ < abr.switchInterval * 1000) {
      return;
    }

    const activeStream = this.player_.getActiveStream(MediaType.VIDEO);
    if (activeStream === this.candidateStream_) {
      return;
    }

    this.lastSwitchAt_ = now;
    const pick = this.candidateStream_;
    log.info("Decision", pick);
    this.player_.emit(Events.ABR_ADAPT, { stream: pick });
  }
}
