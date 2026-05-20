import { describe, expect, it } from "vitest";
import * as DashParser from "../../lib/dash/dash_parser";
import { EncryptionScheme, KeySystem } from "../../lib/types/drm";
import type { AudioTrack, VideoTrack } from "../../lib/types/manifest";
import { MediaType } from "../../lib/types/media";
import { loadFixture } from "../fixtures";
import { findAudio, findSubtitle, findVideo } from "./helpers";

describe("DashParser", () => {
  const sourceUrl = "https://cdn.test/manifest.mpd";

  describe("structure", () => {
    it("parses a basic MPD into a manifest with correct duration", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      expect(manifest.start).toBe(0);
      expect(manifest.end).toBe(60);
      expect(manifest.switchingSets).toHaveLength(2);
    });

    it("extracts a video switching set with the declared codec", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      expect(video.codec).toBe("avc1.64001f");
      expect(video.tracks).toHaveLength(2);
    });

    it("extracts an audio switching set with the declared codec", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const audio = findAudio(manifest);
      expect(audio.codec).toBe("mp4a.40.2");
      expect(audio.tracks).toHaveLength(1);
    });

    it("resolves video track dimensions from representations", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const track1080 = video.tracks.find(
        (t) => t.type === MediaType.VIDEO && t.height === 1080,
      );
      const track720 = video.tracks.find(
        (t) => t.type === MediaType.VIDEO && t.height === 720,
      );
      expect(track1080).toBeDefined();
      expect(track720).toBeDefined();
    });

    it("infers media type from mimeType when contentType is absent", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-mimetype-fallback.mpd"),
        sourceUrl,
      );
      expect(manifest.switchingSets).toHaveLength(2);
      findVideo(manifest);
      findAudio(manifest);
    });

    it("computes maxSegmentDuration on each track", () => {
      const result = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      for (const ss of result.switchingSets) {
        for (const track of ss.tracks) {
          expect(track.maxSegmentDuration).toBe(4);
        }
      }
    });

    it("parses a subtitle AdaptationSet into a subtitle switching set with language", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-subtitle.mpd"),
        sourceUrl,
      );
      const subtitle = findSubtitle(manifest);
      expect(subtitle.codec).toBe("wvtt");
      expect(subtitle.type).toBe(MediaType.SUBTITLE);
      expect(subtitle.language).toBe("en");
      expect(subtitle.tracks).toHaveLength(1);
    });

    it("assigns SwitchingSet.id as type:codec for video and type:codec:language for audio", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const audio = findAudio(manifest);
      expect(video.id).toBe("video:avc1.64001f");
      expect(audio.id).toBe("audio:mp4a.40.2:unk");
    });

    it("assigns Track.id from Representation@id", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const ids = video.tracks.map((t) => t.id).sort();
      expect(ids).toEqual(["1", "2"]);
    });

    it("sets isLive to false for a static MPD", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      expect(manifest.isLive).toBe(false);
    });

    it("sets isLive to true for a dynamic MPD", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-basic.mpd"),
        sourceUrl,
      );
      expect(manifest.isLive).toBe(true);
    });

    it("falls back to AdaptationSet codecs when Representation omits it", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-codec-on-adaptation-set.mpd"),
        sourceUrl,
      );
      expect(findVideo(manifest).codec).toBe("avc1.64001f");
    });

    it("creates separate audio switching sets per language and normalizes lang='und' to 'unk'", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-language-audio.mpd"),
        sourceUrl,
      );
      const audios = manifest.switchingSets.filter(
        (ss) => ss.type === MediaType.AUDIO,
      );
      const ids = audios.map((ss) => ss.id).sort();
      expect(ids).toEqual([
        "audio:mp4a.40.2:en",
        "audio:mp4a.40.2:fr",
        "audio:mp4a.40.2:unk",
      ]);
    });

    it("drops AdaptationSets with zero Representations", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-no-representations.mpd"),
        sourceUrl,
      );
      expect(manifest.switchingSets).toHaveLength(1);
      expect(manifest.switchingSets[0]!.type).toBe(MediaType.VIDEO);
    });
  });

  describe("frameRate", () => {
    it("parses frameRate as a decimal integer", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-framerate-integer.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]! as VideoTrack;
      expect(track.frameRate).toBe(30);
    });

    it("parses frameRate in fractional form", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-framerate-fractional.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]! as VideoTrack;
      expect(track.frameRate).toBeCloseTo(29.97, 2);
    });

    it("falls back to AdaptationSet frameRate when Representation lacks it", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-framerate-on-adaptation-set.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]! as VideoTrack;
      expect(track.frameRate).toBe(24);
    });

    it("leaves frameRate undefined when neither node declares it", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]! as VideoTrack;
      expect(track.frameRate).toBeUndefined();
    });
  });

  describe("audioSamplingRate and AudioChannelConfiguration", () => {
    it("parses audioSamplingRate as a number when a single value is declared", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-audio-samplerate-single.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.sampleRate).toBe(48000);
    });

    it("uses the first value when audioSamplingRate is space-separated", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-audio-samplerate-multi.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.sampleRate).toBe(48000);
    });

    it("parses channel count from MPEG DASH AudioChannelConfiguration scheme", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-audio-channels-mpeg-dash.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.channels).toBe(2);
    });

    it("parses channel count from MPEG CICP AudioChannelConfiguration scheme", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-audio-channels-cicp.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.channels).toBe(6);
    });

    it("leaves channels undefined for an unknown AudioChannelConfiguration schemeIdUri", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-audio-channels-unknown-scheme.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.channels).toBeUndefined();
    });

    it("leaves sampleRate and channels undefined when neither node declares them", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const track = findAudio(manifest).tracks[0]! as AudioTrack;
      expect(track.sampleRate).toBeUndefined();
      expect(track.channels).toBeUndefined();
    });
  });

  describe("segments", () => {
    it("generates segments with URLs derived from the SegmentTemplate", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const track = video.tracks[0]!;
      expect(track.segments.length).toBeGreaterThan(0);

      const firstSeg = track.segments[0]!;
      expect(firstSeg.url).toContain("video-");
      expect(firstSeg.start).toBe(0);
      expect(firstSeg.initSegment.url).toContain("video-init.mp4");
    });

    it("generates the correct number of segments for the presentation duration", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const track = video.tracks[0]!;
      // 60s duration / 4s segments = 15 segments
      expect(track.segments).toHaveLength(15);
    });

    it("flattens multi-period MPD into a single manifest with concatenated segments", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period.mpd"),
        sourceUrl,
      );
      expect(manifest.start).toBe(0);
      // TODO(matvp): This used to be 60, but we no longer read mediaPresentationDuration.
      // The idea is to read period duration and store it in the InitSegment struct as optional
      // duration. If it's there, we can use it.
      expect(manifest.end).toBe(62);
      expect(manifest.switchingSets).toHaveLength(2);

      const video = findVideo(manifest);
      // Single track with segments from both periods
      expect(video.tracks).toHaveLength(1);
      const segments = video.tracks[0]!.segments;
      // 30s / 4s = 7.5 → 8 segments per period × 2 = 16
      // Verify segments span the full duration
      expect(segments[0]!.start).toBe(0);
      expect(segments.at(-1)!.end).toBeGreaterThanOrEqual(60);
    });

    it("concatenates segments from multiple periods in timeline order", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      const segments = video.tracks[0]!.segments;
      // Period 2 segments should start at or after 30s
      const p2Segments = segments.filter((s) => s.start >= 30);
      expect(p2Segments.length).toBeGreaterThan(0);
      expect(p2Segments[0]!.url).toContain("p2-video-");
    });

    it("builds subtitle track segments from the SegmentTemplate", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-subtitle.mpd"),
        sourceUrl,
      );
      const subtitle = findSubtitle(manifest);
      const track = subtitle.tracks[0]!;
      expect(track.segments.length).toBeGreaterThan(0);
      expect(track.segments[0]!.url).toContain("subtitle-");
      expect(track.segments[0]!.initSegment.url).toContain("subtitle-init.mp4");
    });

    it("concatenates audio segments across periods into a single track", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period.mpd"),
        sourceUrl,
      );
      const audio = findAudio(manifest);
      expect(audio.tracks).toHaveLength(1);
      const segments = audio.tracks[0]!.segments;
      const p1Segments = segments.filter((s) => s.url.includes("p1-audio-"));
      const p2Segments = segments.filter((s) => s.url.includes("p2-audio-"));
      expect(p1Segments.length).toBeGreaterThan(0);
      expect(p2Segments.length).toBeGreaterThan(0);
      expect(p2Segments[0]!.start).toBeGreaterThanOrEqual(30);
    });

    it("flattens a multi-period SegmentTimeline manifest into one track with concatenated segments", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period-timeline.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // Each period declares <S t="0"> — period-relative. The parser adds
      // Period@start (0 and 12) to produce absolute starts.
      // Period 1: [0, 4, 8] (3 segments); Period 2: [12, 16, 20] (3 segments)
      expect(segments.map((s) => s.start)).toEqual([0, 4, 8, 12, 16, 20]);
    });

    it("accepts asymmetric Representations across periods (Period 2 adds a new track)", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period-asymmetric.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      expect(video.tracks).toHaveLength(2);
      const ids = video.tracks.map((t) => t.id).sort();
      expect(ids).toEqual(["1", "2"]);
      const extra = video.tracks.find((t) => t.id === "2")!;
      expect(extra.segments.length).toBeGreaterThan(0);
      expect(extra.segments[0]!.start).toBeGreaterThanOrEqual(30);
    });

    it("continues segment numbering across periods via @startNumber", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-multi-period-startnumber.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // Period 1 starts at number 1 ("v-1.m4s"); Period 2 starts at number 8.
      const p2First = segments.find((s) => s.start >= 30);
      expect(p2First).toBeDefined();
      expect(p2First!.url).toContain("v-8.m4s");
    });

    it("expands $Bandwidth$ placeholder in segment URLs", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-url-placeholders.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      expect(track.segments[0]!.url).toContain("2000000");
    });

    it("expands $RepresentationID$ placeholder in segment URLs", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-url-placeholders.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      expect(track.segments[0]!.url).toContain("rep-1");
      expect(track.segments[0]!.initSegment.url).toContain("rep-1");
    });

    it("applies @presentationTimeOffset to segment start and end times", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-presentation-time-offset.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // timescale=1000, pto=10000, first S t=10000, d=4000 r=2.
      // start = (time - pto) / timescale → segments at 0, 4, 8.
      expect(segments[0]!.start).toBeCloseTo(0, 5);
      expect(segments[0]!.end).toBeCloseTo(4, 5);
      expect(segments[1]!.start).toBeCloseTo(4, 5);
      expect(segments[2]!.start).toBeCloseTo(8, 5);
    });

    it("last segment covers the full presentation duration", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      expect(track.segments.at(-1)!.end).toBeCloseTo(60, 0);
    });

    it("produces contiguous segments with no gaps between them", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      for (let i = 1; i < segments.length; i++) {
        expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.end, 5);
      }
    });

    it("attaches an init segment to every media segment", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      for (const seg of segments) {
        expect(seg.initSegment).toBeDefined();
        expect(seg.initSegment.url).toContain("init");
      }
    });

    it("merges SegmentTemplate attributes from period, adaptation set, and representation levels", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-inherited-template.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // periodDuration=12s, timescale=1000, duration=4000 → 3 segments.
      expect(segments).toHaveLength(3);
      expect(segments[0]!.initSegment.url).toContain("v-init.mp4");
      expect(segments[0]!.url).toContain("v-");
    });

    it("inherits @startNumber from a Period-level SegmentTemplate", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-inherited-template.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // startNumber=5 on Period-level template → first segment URL contains "v-5.m4s".
      expect(segments[0]!.url).toContain("v-5.m4s");
    });

    it("inherits @duration from a Period-level SegmentTemplate", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-inherited-template.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // duration=4000 / timescale=1000 → 4s per segment.
      expect(segments[0]!.end - segments[0]!.start).toBeCloseTo(4, 5);
    });

    it("inherits @presentationTimeOffset from a Period-level SegmentTemplate", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-inherited-template.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // pto=8000, timescale=1000; duration-based addressing uses time=i*duration,
      // so start = (0 - 8000)/1000 = -8 for the first segment. The negative
      // value is intentional — it proves pto is applied; a realistic fixture
      // would pair pto with a matching <S t="..."> to yield a non-negative start.
      expect(segments[0]!.start).toBeCloseTo(-8, 5);
    });

    it("resolves <BaseURL> at every level (MPD / Period / AdaptationSet / Representation)", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-base-url.mpd"),
        sourceUrl,
      );
      const url = findVideo(manifest).tracks[0]!.segments[0]!.url;
      expect(url).toContain("mpd/");
      expect(url).toContain("period/");
      expect(url).toContain("as/");
      expect(url).toContain("rep/");
      expect(url).toContain("v-1.m4s");
    });

    it("uses SegmentTimeline when both @duration and <SegmentTimeline> are present", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-timeline-with-duration.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // <S r=2> produces 3 segments at 4s each; @duration="9999999" is ignored.
      expect(segments).toHaveLength(3);
      expect(segments[0]!.end - segments[0]!.start).toBeCloseTo(4, 5);
    });

    it("generates the correct number of segments from SegmentTimeline with repeat count", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-timeline.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // r="2" means 3 total segments (original + 2 repeats)
      expect(segments).toHaveLength(3);
    });

    it("calculates correct start and end times from timeline entries", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-timeline.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      expect(segments[0]!.start).toBeCloseTo(0, 5);
      expect(segments[0]!.end).toBeCloseTo(4, 5);
      expect(segments[1]!.start).toBeCloseTo(4, 5);
      expect(segments[2]!.start).toBeCloseTo(8, 5);
    });

    it("resets segment time when S entry has explicit @t attribute", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-timeline-reset.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      expect(segments).toHaveLength(3);
      expect(segments[0]!.start).toBeCloseTo(0, 5);
      expect(segments[0]!.end).toBeCloseTo(4, 5);
      expect(segments[1]!.start).toBeCloseTo(4, 5);
      expect(segments[1]!.end).toBeCloseTo(8, 5);
      // Third segment: time reset to 900000/90000 = 10s
      expect(segments[2]!.start).toBeCloseTo(10, 5);
      expect(segments[2]!.end).toBeCloseTo(12, 5);
    });

    it("expands $Time$ placeholder in segment URLs", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-timeline-reset.mpd"),
        sourceUrl,
      );
      const segments = findVideo(manifest).tracks[0]!.segments;
      // Timeline: t=0 d=360000 r=1, then t=900000 d=180000.
      // First segment time=0, third time=900000.
      expect(segments[0]!.url).toContain("-0.m4s");
      expect(segments[2]!.url).toContain("-900000.m4s");
    });
  });

  describe("errors", () => {
    it("throws when MPD contains no Period elements", () => {
      expect(() =>
        DashParser.create(
          loadFixture("dash-parser/vod-no-periods.mpd"),
          sourceUrl,
        ),
      ).toThrow();
    });

    it("throws when no SegmentTemplate is declared at any level", () => {
      expect(() =>
        DashParser.create(
          loadFixture("dash-parser/vod-no-template.mpd"),
          sourceUrl,
        ),
      ).toThrow();
    });
  });

  describe("update", () => {
    it("preserves manifest, switching set, track, and segment references when applied twice to the same MPD", () => {
      const text = loadFixture("dash-parser/live-timeline-sliding-1.mpd");
      const manifest = DashParser.create(text, sourceUrl);

      const switchingSetsRef = manifest.switchingSets;
      const firstSet = switchingSetsRef[0]!;
      const firstTrack = firstSet.tracks[0]!;
      const tracksRef = firstSet.tracks;
      const segmentsRef = firstTrack.segments;
      const firstSegment = segmentsRef[0]!;
      const segmentCount = segmentsRef.length;

      DashParser.update(manifest, text, sourceUrl);

      expect(manifest.switchingSets).toBe(switchingSetsRef);
      expect(manifest.switchingSets[0]).toBe(firstSet);
      expect(firstSet.tracks).toBe(tracksRef);
      expect(firstSet.tracks[0]).toBe(firstTrack);
      expect(firstTrack.segments).toBe(segmentsRef);
      expect(firstTrack.segments[0]).toBe(firstSegment);
      expect(firstTrack.segments.length).toBe(segmentCount);
    });

    it("extends an existing track's segments when a new snapshot adds tail segments", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-growing-1.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      const originalSegments = track.segments;
      const originalCount = originalSegments.length;
      const originalFirst = originalSegments[0]!;
      const originalLast = originalSegments.at(-1)!;

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-growing-2.mpd"),
        sourceUrl,
      );

      expect(track.segments).toBe(originalSegments);
      expect(track.segments.length).toBeGreaterThan(originalCount);
      expect(track.segments[0]).toBe(originalFirst);
      expect(track.segments[originalCount - 1]).toBe(originalLast);
    });

    it("preserves references for every segment across a multi-period update", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-multi-period-timeline-1.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      const originalSegments = track.segments;
      const snapshot = [...originalSegments];

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-multi-period-timeline-2.mpd"),
        sourceUrl,
      );

      // Snapshot 1: Period 1 [0, 4, 8], Period 2 [12, 16] → [0, 4, 8, 12, 16].
      // Snapshot 2: Period 1 [4, 8], Period 2 [12, 16, 20] → [4, 8, 12, 16, 20].
      // Head segment at start=0 pruned; tail at start=20 appended.
      // Indices 1..4 of the old snapshot survive as 0..3 in the new array.
      expect(track.segments).toBe(originalSegments);
      expect(track.segments.map((s) => s.start)).toEqual([4, 8, 12, 16, 20]);
      expect(track.segments[0]).toBe(snapshot[1]);
      expect(track.segments[1]).toBe(snapshot[2]);
      expect(track.segments[2]).toBe(snapshot[3]);
      expect(track.segments[3]).toBe(snapshot[4]);
    });
  });

  describe("ContentProtection", () => {
    it("attaches a protection model to the switching set when present", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-protected-widevine-playready.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      expect(video.protection?.scheme).toBe(EncryptionScheme.CENC);
      expect(video.protection?.defaultKid).toBe(
        "abcdef01-2345-6789-abcd-ef0123456789",
      );
      expect(
        video.protection?.keySystems[KeySystem.WIDEVINE]?.pssh,
      ).toBeInstanceOf(Uint8Array);
    });

    it("leaves protection undefined on clear switching sets", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-basic.mpd"),
        sourceUrl,
      );
      expect(findVideo(manifest).protection).toBeUndefined();
    });

    it("parses ContentProtection located on Representation elements", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-protected-representation-level.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      expect(video.protection?.scheme).toBe(EncryptionScheme.CENC);
      expect(
        video.protection?.keySystems[KeySystem.WIDEVINE]?.pssh,
      ).toBeInstanceOf(Uint8Array);
    });

    it("parses FairPlay contentId and cbcs scheme from the value attribute", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/vod-protected-fairplay.mpd"),
        sourceUrl,
      );
      const video = findVideo(manifest);
      expect(video.protection?.scheme).toBe(EncryptionScheme.CBCS);
      expect(video.protection?.keySystems[KeySystem.FAIRPLAY]?.contentId).toBe(
        "skd://example/abc123",
      );
    });

    it("throws when mp4protection is present but cenc:default_KID is missing", () => {
      expect(() =>
        DashParser.create(
          loadFixture("dash-parser/vod-protected-no-default-kid.mpd"),
          sourceUrl,
        ),
      ).toThrow(/default_KID/);
    });
  });

  describe("update — live reconciliation", () => {
    it("appends new tail segments and prunes expired head segments", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      expect(track.segments.map((s) => s.start)).toEqual([0, 4, 8, 12, 16]);

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // After update: DVR window shifted — start=0,4 pruned, start=20,24 appended
      expect(track.segments.map((s) => s.start)).toEqual([8, 12, 16, 20, 24]);
    });

    it("preserves object identity for overlapping segments across an update", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;
      const kept = [track.segments[2]!, track.segments[3]!, track.segments[4]!];

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // Segments that straddle both MPD snapshots must remain the same object refs.
      expect(track.segments[0]).toBe(kept[0]);
      expect(track.segments[1]).toBe(kept[1]);
      expect(track.segments[2]).toBe(kept[2]);
    });

    it("preserves Track and SwitchingSet identity across an update", () => {
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const switchingSet = manifest.switchingSets[0]!;
      const track = switchingSet.tracks[0]!;
      const segmentsArray = track.segments;

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      expect(manifest.switchingSets[0]).toBe(switchingSet);
      expect(switchingSet.tracks[0]).toBe(track);
      expect(switchingSet.tracks[0]!.segments).toBe(segmentsArray);
    });

    it("uses the refreshed MPD's first-segment start as the prune watermark", () => {
      // First <S> in the updated MPD has t != 0 (timeline-2 starts at
      // t=8000 ms → start=8s), so the prune watermark shifts accordingly.
      const manifest = DashParser.create(
        loadFixture("dash-parser/live-timeline-sliding-1.mpd"),
        sourceUrl,
      );
      const track = findVideo(manifest).tracks[0]!;

      DashParser.update(
        manifest,
        loadFixture("dash-parser/live-timeline-sliding-2.mpd"),
        sourceUrl,
      );

      // Head trimmed to the MPD's new earliest start (8), not 0.
      expect(track.segments[0]!.start).toBe(8);
    });
  });
});
