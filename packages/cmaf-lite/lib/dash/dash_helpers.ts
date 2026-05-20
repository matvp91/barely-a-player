import type * as txml from "txml";
import {
  keySystemFromSchemeIdUri,
  keySystemInfoFromRaw,
} from "../drm/drm_utils";
import type { KeySystem } from "../types/drm";
import { EncryptionScheme } from "../types/drm";
import type {
  KeySystemInfo,
  Protection,
  SwitchingSet,
} from "../types/manifest";
import { MediaType } from "../types/media";
import * as asserts from "../utils/asserts";
import * as Functional from "../utils/functional";
import * as LanguageUtils from "../utils/language_utils";
import * as UrlUtils from "../utils/url_utils";
import * as XmlUtils from "../utils/xml_utils";

export function resolveType(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): MediaType {
  const contentType = XmlUtils.attr(
    adaptationSet,
    "contentType",
    XmlUtils.parseString,
  );
  if (contentType === "video") {
    return MediaType.VIDEO;
  }
  if (contentType === "audio") {
    return MediaType.AUDIO;
  }
  if (contentType === "text") {
    return MediaType.SUBTITLE;
  }
  const mimeType =
    XmlUtils.attr(adaptationSet, "mimeType", XmlUtils.parseString) ??
    (representations[0]
      ? XmlUtils.attr(representations[0], "mimeType", XmlUtils.parseString)
      : undefined);
  if (mimeType?.startsWith("video/")) {
    return MediaType.VIDEO;
  }
  if (mimeType?.startsWith("audio/")) {
    return MediaType.AUDIO;
  }
  if (mimeType?.startsWith("text/") || mimeType?.startsWith("application/")) {
    return MediaType.SUBTITLE;
  }
  throw new Error("Failed to infer media type");
}

export function resolveCodec(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): string {
  const firstRepresentation = representations[0];
  asserts.assertExists(firstRepresentation, "No Representation found");

  const codec = Functional.findMap(
    [firstRepresentation, adaptationSet],
    (node) => XmlUtils.attr(node, "codecs", XmlUtils.parseString),
  );
  asserts.assertExists(codec, "codecs is mandatory");

  return codec;
}

export function resolveSegmentTemplate(
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): txml.TNode {
  const templates = [
    XmlUtils.child(representation, "SegmentTemplate"),
    XmlUtils.child(adaptationSet, "SegmentTemplate"),
    XmlUtils.child(period, "SegmentTemplate"),
  ].filter((template): template is txml.TNode => template !== undefined);

  if (templates.length === 0) {
    throw new Error("We've got to have some sort of templating");
  }

  const attributes: Record<string, string | null> = {};
  for (const template of templates.slice().reverse()) {
    Object.assign(attributes, template.attributes);
  }

  const segmentTimeline = Functional.findMap(templates, (template) =>
    XmlUtils.child(template, "SegmentTimeline"),
  );

  return {
    tagName: "SegmentTemplate",
    attributes,
    children: segmentTimeline ? [segmentTimeline] : [],
  };
}

export function resolveBaseUrl(
  sourceUrl: string,
  mpd: txml.TNode,
  period: txml.TNode,
  adaptationSet: txml.TNode,
  representation: txml.TNode,
): string {
  const baseUrls = [mpd, period, adaptationSet, representation].flatMap(
    (node) => XmlUtils.children(node, "BaseURL").map(XmlUtils.text),
  );
  return UrlUtils.resolveUrls([
    sourceUrl,
    ...baseUrls.filter((url): url is string => url != null),
  ]);
}

export function resolvePeriodDuration(
  mpd: txml.TNode,
  periods: txml.TNode[],
  periodIndex: number,
): number | null {
  const period = periods[periodIndex];
  asserts.assertExists(period, "Period not found");

  const duration = XmlUtils.attr(period, "duration", XmlUtils.parseDuration);
  if (duration != null) {
    return duration;
  }

  const start = XmlUtils.attr(period, "start", XmlUtils.parseDuration) ?? 0;

  const nextPeriod = periods[periodIndex + 1];
  const nextStart = nextPeriod
    ? XmlUtils.attr(nextPeriod, "start", XmlUtils.parseDuration)
    : undefined;
  if (nextStart != null) {
    return nextStart - start;
  }

  const mpdDuration = XmlUtils.attr(
    mpd,
    "mediaPresentationDuration",
    XmlUtils.parseDuration,
  );
  if (mpdDuration != null) {
    return mpdDuration - start;
  }

  return null;
}

export function resolveTiming(switchingSets: SwitchingSet[]) {
  const lastSegmentEnd = switchingSets[0]?.tracks[0]?.segments.at(-1)?.end;
  asserts.assertExists(lastSegmentEnd, "Cannot resolve end");
  const firstSegmentStart = switchingSets[0]?.tracks[0]?.segments.at(0)?.start;
  asserts.assertExists(firstSegmentStart, "Cannot resolve start");
  return {
    firstSegmentStart,
    lastSegmentEnd,
  };
}

export function resolveLanguage(node: txml.TNode) {
  const lang = XmlUtils.attr(node, "lang", XmlUtils.parseString);
  // TODO(matvp): Make language nullable instead of defaulting to unk.
  return lang && lang !== "und" ? LanguageUtils.toBCP47(lang) : "unk";
}

/**
 * Parse a DASH MPD `@frameRate` attribute. The MPD spec allows either
 * a single decimal (`"30"`) or a fractional form (`"30000/1001"`).
 * Returns the decimal value, or undefined when malformed.
 */
export function parseFrameRate(value: string): number | undefined {
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

/**
 * Parse the first number in a whitespace-separated list. Used for DASH
 * MPD attributes like `@audioSamplingRate` which may be a list of
 * supported values; the first is sufficient for capability probing.
 */
export function parseFirstNumber(value: string): number | undefined {
  const first = value.trim().split(/\s+/)[0];
  if (!first) {
    return undefined;
  }
  const n = Number(first);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveProtection(
  adaptationSet: txml.TNode,
  representations: txml.TNode[],
): Protection | null {
  let elements = XmlUtils.children(adaptationSet, "ContentProtection");
  if (elements.length === 0 && representations[0]) {
    elements = XmlUtils.children(representations[0], "ContentProtection");
  }
  if (elements.length === 0) {
    return null;
  }

  let scheme: EncryptionScheme | null = null;
  let defaultKid: string | null = null;
  const keySystems: Partial<Record<KeySystem, KeySystemInfo>> = {};

  for (const el of elements) {
    const schemeIdUri = XmlUtils.attr(el, "schemeIdUri", XmlUtils.parseString);
    if (!schemeIdUri) {
      continue;
    }

    // DASH scheme URN for the mp4protection element that carries scheme
    // and default_KID.
    if (schemeIdUri === "urn:mpeg:dash:mp4protection:2011") {
      const value = XmlUtils.attr(el, "value", XmlUtils.parseString);
      if (value === EncryptionScheme.CENC || value === EncryptionScheme.CBCS) {
        scheme = value;
      }
      const kid = XmlUtils.attr(el, "cenc:default_KID", XmlUtils.parseString);
      if (kid) {
        defaultKid = kid.toLowerCase();
      }
      continue;
    }

    const keySystem = keySystemFromSchemeIdUri(schemeIdUri);
    if (!keySystem) {
      continue;
    }
    const value = XmlUtils.attr(el, "value", XmlUtils.parseString);
    const psshNode = XmlUtils.children(el, "cenc:pssh")[0];
    const psshText = psshNode ? XmlUtils.text(psshNode) : undefined;
    keySystems[keySystem] = keySystemInfoFromRaw(
      keySystem,
      value ?? undefined,
      psshText,
    );
  }

  if (scheme === null) {
    return null;
  }
  if (defaultKid === null) {
    throw new Error(
      "ContentProtection: mp4protection present without cenc:default_KID",
    );
  }
  return { scheme, defaultKid, keySystems };
}
