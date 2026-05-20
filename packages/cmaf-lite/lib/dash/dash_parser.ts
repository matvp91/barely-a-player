import { processUriTemplate } from "@svta/cml-dash";
import type * as txml from "txml";
import { EMPTY_MANIFEST } from "../constants";
import type { Manifest, Segment, SwitchingSet, Track } from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as ManifestUtils from "../utils/manifest_utils";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";
import * as DashHelpers from "./dash_helpers";

type ReadContext = {
  manifest: Manifest;
  switchingSetsById: Map<string, SwitchingSet>;
  tracksById: Map<string, Track>;
  sourceUrl: string;
  isUpdate: boolean;
};

export function create(text: string, sourceUrl: string): Manifest {
  // Deep copy an empty manifest and use that as the stable manifest base.
  const manifest = structuredClone(EMPTY_MANIFEST);
  const mpd = XmlUtils.parseXml(text, "MPD");
  readMpd(manifest, mpd, sourceUrl, false);
  return manifest;
}

export function update(
  manifest: Manifest,
  text: string,
  sourceUrl: string,
): void {
  const mpd = XmlUtils.parseXml(text, "MPD");
  readMpd(manifest, mpd, sourceUrl, true);
}

function readMpd(
  manifest: Manifest,
  mpd: txml.TNode,
  sourceUrl: string,
  isUpdate: boolean,
): void {
  const periods = XmlUtils.children(mpd, "Period");
  if (periods.length === 0) {
    throw new Error("No Period found in manifest");
  }

  const ctx = createContext(manifest, sourceUrl, isUpdate);
  for (let i = 0; i < periods.length; i++) {
    readPeriod(ctx, mpd, periods, i);
  }

  const type = XmlUtils.attr(mpd, "type", XmlUtils.parseString);
  manifest.isLive = type === "dynamic";
  const timing = DashHelpers.resolveTiming(manifest.switchingSets);
  manifest.start = timing.firstSegmentStart;
  manifest.end = timing.lastSegmentEnd;

  const availabilityStartTime = XmlUtils.attr(
    mpd,
    "availabilityStartTime",
    XmlUtils.parseDate,
  );
  manifest.baseDateTime = availabilityStartTime;
}

function readPeriod(
  ctx: ReadContext,
  mpd: txml.TNode,
  periods: txml.TNode[],
  periodIndex: number,
): void {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");
  const periodDuration = DashHelpers.resolvePeriodDuration(
    mpd,
    periods,
    periodIndex,
  );

  for (const adaptationSet of XmlUtils.children(period, "AdaptationSet")) {
    readAdaptationSet(ctx, mpd, period, adaptationSet, periodDuration);
  }
}

function readAdaptationSet(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  periodDuration: number | null,
): void {
  const representations = XmlUtils.children(adaptationSet, "Representation");
  if (representations.length === 0) {
    return;
  }

  const switchingSet = upsertSwitchingSet(ctx, adaptationSet, representations);

  for (const representation of representations) {
    readRepresentation(
      ctx,
      mpd,
      period,
      adaptationSet,
      representation,
      switchingSet,
      periodDuration,
    );
  }
}

function readRepresentation(
  ctx: ReadContext,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  switchingSet: SwitchingSet,
  periodDuration: number | null,
): void {
  const track = upsertTrack(ctx, switchingSet, adaptationSet, representation);
  const startAfter = ctx.isUpdate
    ? (track.segments.at(-1)?.start ?? -Infinity)
    : -Infinity;
  const periodStart = XmlUtils.attr(period, "start", XmlUtils.parseDuration, 0);
  const { maxSegmentDuration, firstAvailableStart } = appendSegments(
    ctx,
    track.segments,
    mpd,
    period,
    adaptationSet,
    representation,
    periodStart,
    periodDuration,
    startAfter,
  );
  if (ctx.isUpdate) {
    ManifestUtils.evictSegments(
      track.segments,
      periodStart,
      firstAvailableStart,
    );
  }
  track.maxSegmentDuration = Math.max(
    track.maxSegmentDuration,
    maxSegmentDuration,
  );
}

function createContext(
  manifest: Manifest,
  sourceUrl: string,
  isUpdate: boolean,
): ReadContext {
  const ctx: ReadContext = {
    manifest,
    switchingSetsById: new Map(),
    tracksById: new Map(),
    sourceUrl,
    isUpdate,
  };
  for (const switchingSet of manifest.switchingSets) {
    ctx.switchingSetsById.set(switchingSet.id, switchingSet);
    for (const track of switchingSet.tracks) {
      ctx.tracksById.set(`${switchingSet.id}:${track.id}`, track);
    }
  }
  return ctx;
}

function upsertSwitchingSet(
  ctx: ReadContext,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const { switchingSets } = ctx.manifest;
  const id = getAdaptationSetId(adaptationSet, representations);
  return ctx.switchingSetsById.getOrInsertComputed(id, () => {
    const switchingSet = parseAdaptationSet(id, adaptationSet, representations);
    switchingSets.push(switchingSet);
    return switchingSet;
  });
}

function upsertTrack(
  ctx: ReadContext,
  switchingSet: SwitchingSet,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const id = XmlUtils.attrRequired(representation, "id", XmlUtils.parseString);
  const key = `${switchingSet.id}:${id}`;
  return ctx.tracksById.getOrInsertComputed(key, () => {
    const track = buildTrack(
      switchingSet.type,
      id,
      adaptationSet,
      representation,
    );
    // We'll have to cast tracks to Track as it is the overarching type,
    // but we'll know that type is matching because we created the
    // track with the same type as the switchingSet.
    (switchingSet.tracks as Track[]).push(track);
    return track;
  });
}

function getAdaptationSetId(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const type = DashHelpers.resolveType(adaptationSet, representations);
  const codec = DashHelpers.resolveCodec(adaptationSet, representations);
  const id = `${type}:${codec}`;

  if (type === MediaType.VIDEO) {
    return id;
  }
  if (type === MediaType.AUDIO) {
    const language = DashHelpers.resolveLanguage(adaptationSet);
    return `${id}:${language}`;
  }
  if (type === MediaType.SUBTITLE) {
    const language = DashHelpers.resolveLanguage(adaptationSet);
    return `${id}:${language}`;
  }
  throw new Error("Unsupported media type");
}

function parseAdaptationSet(
  id: string,
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): SwitchingSet {
  const type = DashHelpers.resolveType(adaptationSet, representations);
  const codec = DashHelpers.resolveCodec(adaptationSet, representations);
  const protection = DashHelpers.resolveProtection(
    adaptationSet,
    representations,
  );

  if (type === MediaType.VIDEO) {
    return {
      id,
      type,
      codec,
      ...(protection ? { protection } : {}),
      tracks: [],
    };
  }
  if (type === MediaType.AUDIO) {
    const language = DashHelpers.resolveLanguage(adaptationSet);
    return {
      id,
      type,
      codec,
      language,
      ...(protection ? { protection } : {}),
      tracks: [],
    };
  }
  if (type === MediaType.SUBTITLE) {
    const language = DashHelpers.resolveLanguage(adaptationSet);
    return {
      id,
      type,
      codec,
      language,
      ...(protection ? { protection } : {}),
      tracks: [],
    };
  }
  throw new Error("Unsupported media type");
}

/**
 * Parses a DASH `@frameRate` attribute value, which is either an integer
 * (e.g. `"30"`) or a fraction (e.g. `"30000/1001"`), into a decimal number.
 * Returns `undefined` for malformed values.
 */
function parseFrameRate(value: string): number | undefined {
  const trimmed = value.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const num = Number(trimmed.substring(0, slashIdx));
  const den = Number(trimmed.substring(slashIdx + 1));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  return num / den;
}

function buildTrack(
  type: MediaType,
  id: string,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): Track {
  const bandwidth = XmlUtils.attrRequired(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );

  if (type === MediaType.VIDEO) {
    const width = Functional.findMap([representation, adaptationSet], (node) =>
      XmlUtils.attr(node, "width", XmlUtils.parseNumber),
    );
    asserts.assertExists(width, "width is mandatory");
    const height = Functional.findMap([representation, adaptationSet], (node) =>
      XmlUtils.attr(node, "height", XmlUtils.parseNumber),
    );
    asserts.assertExists(height, "height is mandatory");
    const frameRate = Functional.findMap(
      [representation, adaptationSet],
      (node) => XmlUtils.attr(node, "frameRate", parseFrameRate),
    );
    return {
      id,
      type,
      width,
      height,
      bandwidth,
      segments: [],
      maxSegmentDuration: 0,
      ...(frameRate !== undefined ? { frameRate } : {}),
    };
  }
  if (type === MediaType.AUDIO) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  if (type === MediaType.SUBTITLE) {
    return { id, type, bandwidth, segments: [], maxSegmentDuration: 0 };
  }
  throw new Error("Unsupported media type");
}

function appendSegments(
  ctx: ReadContext,
  target: Segment[],
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
  periodStart: number,
  periodDuration: number | null,
  startAfter: number,
): { maxSegmentDuration: number; firstAvailableStart: number } {
  const baseUrl = DashHelpers.resolveBaseUrl(
    ctx.sourceUrl,
    mpd,
    period,
    adaptationSet,
    representation,
  );

  const segmentTemplate = DashHelpers.resolveSegmentTemplate(
    period,
    adaptationSet,
    representation,
  );

  const bandwidth = XmlUtils.attrRequired(
    representation,
    "bandwidth",
    XmlUtils.parseNumber,
  );

  const initialization = XmlUtils.attrRequired(
    segmentTemplate,
    "initialization",
    XmlUtils.parseString,
  );

  const media = XmlUtils.attrRequired(
    segmentTemplate,
    "media",
    XmlUtils.parseString,
  );

  const id = XmlUtils.attrRequired(representation, "id", XmlUtils.parseString);

  const timescale = XmlUtils.attr(
    segmentTemplate,
    "timescale",
    XmlUtils.parseNumber,
    1,
  );
  const startNumber = XmlUtils.attr(
    segmentTemplate,
    "startNumber",
    XmlUtils.parseNumber,
    1,
  );
  const presentationTimeOffset = XmlUtils.attr(
    segmentTemplate,
    "presentationTimeOffset",
    XmlUtils.parseNumber,
    0,
  );

  // If we have segments, we'll preserve the initSegment to keep a stable
  // reference to it.
  let initSegment = target[0]?.initSegment;
  if (!initSegment) {
    const uri = processUriTemplate(
      initialization,
      id,
      null,
      null,
      bandwidth,
      null,
    );
    const url = UrlUtils.resolveUrl(uri, baseUrl);
    initSegment = { url };
  }

  let maxSegmentDuration = 0;

  const timeline = XmlUtils.child(segmentTemplate, "SegmentTimeline");
  if (timeline) {
    const entries = XmlUtils.children(timeline, "S");
    const firstT = entries[0]
      ? XmlUtils.attr(entries[0], "t", XmlUtils.parseNumber, 0)
      : 0;
    const firstAvailableStart = entries[0]
      ? (firstT - presentationTimeOffset) / timescale + periodStart
      : periodStart;

    let time = 0;
    let number = startNumber;
    for (const timelineEntry of entries) {
      const duration = XmlUtils.attrRequired(
        timelineEntry,
        "d",
        XmlUtils.parseNumber,
      );
      const repeat = XmlUtils.attr(timelineEntry, "r", XmlUtils.parseNumber, 0);
      time = XmlUtils.attr(timelineEntry, "t", XmlUtils.parseNumber, time);

      for (let i = 0; i <= repeat; i++) {
        const start = (time - presentationTimeOffset) / timescale + periodStart;
        const end =
          (time - presentationTimeOffset + duration) / timescale + periodStart;

        if (start <= startAfter) {
          time += duration;
          number++;
          continue;
        }

        const segmentUri = processUriTemplate(
          media,
          id,
          number,
          null,
          bandwidth,
          time,
        );
        const url = UrlUtils.resolveUrl(segmentUri, baseUrl);

        target.push({ url, start, end, initSegment });

        maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
        time += duration;
        number++;
      }
    }

    return { maxSegmentDuration, firstAvailableStart };
  }

  asserts.assertExists(
    periodDuration,
    "Duration-based addressing requires a resolvable period duration",
  );

  const duration = XmlUtils.attrRequired(
    segmentTemplate,
    "duration",
    XmlUtils.parseNumber,
  );

  const firstAvailableStart =
    (0 - presentationTimeOffset) / timescale + periodStart;

  const count = Math.ceil(periodDuration / (duration / timescale));
  for (let i = 0; i < count; i++) {
    const number = startNumber + i;
    const time = i * duration;
    const start = (time - presentationTimeOffset) / timescale + periodStart;
    const end =
      (time - presentationTimeOffset + duration) / timescale + periodStart;

    if (start <= startAfter) {
      continue;
    }

    const segmentUri = processUriTemplate(
      media,
      id,
      number,
      null,
      bandwidth,
      time,
    );
    const url = UrlUtils.resolveUrl(segmentUri, baseUrl);
    target.push({ url, start, end, initSegment });
    maxSegmentDuration = Math.max(maxSegmentDuration, end - start);
  }

  return { maxSegmentDuration, firstAvailableStart };
}
