// DRM test streams:
// - Widevine (Chrome/Edge/Firefox):
//     manifest: https://bitmovin-a.akamaihd.net/content/art-of-motion_drm/mpds/11331.mpd
//     license:  https://cwip-shaka-proxy.appspot.com/no_auth
// - PlayReady (Edge):
//     manifest: https://test.playready.microsoft.com/media/profficialsite/2018ifa_h264/manifest.mpd
//     license:  https://test.playready.microsoft.com/service/rightsmanager.asmx
// - FairPlay (Safari): no fully public test stream — wire your own.
import {
  Events,
  KeySystem,
  Log,
  LogLevel,
  MediaType,
  NetworkRequestType,
  Player,
  Timer,
} from "cmaf-lite";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

Log.setLevel(LogLevel.INFO);

const player = new Player();
Object.assign(window, { player });

player.setConfig("abr.defaultBandwidthEstimate", 10_000 * 10_000);

player.setConfig("drm.licenseUrls", {
  [KeySystem.WIDEVINE]: "https://cwip-shaka-proxy.appspot.com/no_auth",
  // [KeySystem.PLAYREADY]: "https://test.playready.microsoft.com/service/rightsmanager.asmx",
  // [KeySystem.FAIRPLAY]: "<vendor-specific>",
});

player.setConfig("preferences", [
  {
    type: MediaType.VIDEO,
    codec: "hevc",
  },
  {
    type: MediaType.VIDEO,
    codec: "avc",
  },
]);

const video = document.getElementById("videoElement") as HTMLVideoElement;

player.attachMedia(video);

player.addListener(Events.NETWORK_REQUEST, (event) => {
  if (event.type === NetworkRequestType.LICENSE) {
    console.log("[license request]", event.request.url);
  }
});

player.addListener(Events.NETWORK_RESPONSE, (event) => {
  if (event.type === NetworkRequestType.LICENSE) {
    console.log("[license response]", event.response.status);
  }
});

player.load(
  // "https://ue-video-vtmgo.dpgmedia.net/out/v1/df5b9943928b4c60ab9a86cef9a399c7/89f639bc23ee4456b296e61523441025/0f1c129bf59346c99c27dfa3e1f0dd18/index.mpd?aws.manifestfilter=subtitle_language%3Azzz%3Btrickplay_type%3Anone%3Baudio_codec%3AAACL",
  // "https://d305rncpy6ne2q.cloudfront.net/v1/dash/94063eadf7d8c56e9e2edd84fdf897826a70d0df/SFP-MediaTailor-VOD-HLS-DASH/out/v1/b94f3611978f419985a18335bac9d9cb/ddb73bf548a44551a0059c346226445a/eaa5485198bf497284559efb8172425e/index.mpd?aws.sessionId=21567779-c8a8-4be9-9f18-d628dea03826",
  // "https://livesim2.dashif.org/livesim2/segtimeline_1/testpic_2s/Manifest.mpd",
  // "https://dash.akamaized.net/dash264/TestCasesIOP33/adapatationSetSwitching/1/manifest.mpd",
  // "https://dash.akamaized.net/dash264/TestCasesHEVC/2a/12/tos_ondemand_multires_10bit_hev.mpd"
  // "https://divudqsyr5kmn.cloudfront.net/cmaf/bbb-avc-av1/bbb_sunflower_2160p_30fps.mpd",
  // "https://livesim2.dashif.org/livesim2/segtimeline_1/testpic_2s/Manifest.mpd",
  // "https://demo.unified-streaming.com/k8s/live/scte35.isml/.mpd"
  // "https://media.axprod.net/TestVectors/v7-MultiDRM-SingleKey/Manifest_1080p.mpd",
  "https://bitmovin-a.akamaihd.net/content/art-of-motion_drm/mpds/11331.mpd",
);

// biome-ignore lint/style/noNonNullAssertion: We definitely got this
const appElement = document.getElementById("app")!;
const root = createRoot(appElement);
const timer = new Timer(() => {
  root.render(<App player={player} />);
});
const tick = () => timer.tickNow().tickEvery(0.1);
Object.values(Events).forEach((name) => {
  player.addListener(name, tick);
});
