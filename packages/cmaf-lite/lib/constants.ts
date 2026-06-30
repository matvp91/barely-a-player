import type { Manifest } from "./types/manifest";

export const EMPTY_ARRAY = [];

export const EMPTY_TIME_RANGES: TimeRanges = {
  length: 0,
  start: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
  end: (_index: number) => {
    throw new DOMException("IndexSizeError");
  },
};

export const EMPTY_MANIFEST: Manifest = {
  isLive: false,
  start: 0,
  end: 0,
  switchingSets: [],
};

export const PROP_HIERARCHY = Symbol("hierarchy");
export const PROP_DECODING_INFO = Symbol("decodingInfo");
