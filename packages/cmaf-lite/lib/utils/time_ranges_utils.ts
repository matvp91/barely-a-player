/**
 * Find the end of the buffered range containing the given
 * position. Merges adjacent ranges with gaps smaller than
 * maxHole and tolerates the position being slightly before
 * a range start.
 */
export function getBufferedEnd(
  buffered: TimeRanges,
  pos: number,
  maxHole: number,
): number | null {
  let rangeStart = 0;
  let rangeEnd = 0;

  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);

    if (i > 0 && start - rangeEnd < maxHole) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      if (pos + maxHole >= rangeStart && pos < rangeEnd) {
        return rangeEnd;
      }
      rangeStart = start;
      rangeEnd = end;
    }
  }

  if (pos + maxHole >= rangeStart && pos < rangeEnd) {
    return rangeEnd;
  }

  return null;
}

/**
 * Find the start of the first buffered range after the
 * given position.
 */
export function getNextBufferedStart(
  buffered: TimeRanges,
  pos: number,
): number | null {
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    if (start > pos) {
      return start;
    }
  }
  return null;
}
