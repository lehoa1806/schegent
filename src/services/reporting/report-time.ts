/**
 * FR-R6-F11 (FR-004; research R5) — the report time basis.
 *
 * A timezone is validated by constructing an `Intl.DateTimeFormat` with it, and kept in the
 * spelling `Intl` resolves it to. A local-day key is the `YYYY-MM-DD` the zone shows for an
 * instant. Keys are cached per 15-minute UTC bucket, but only for a bucket whose first and last
 * millisecond fall on the same local day. A bucket a day boundary cuts (an offset such as `+00:07`,
 * or a historical one with seconds, as Africa/Monrovia's -0:44:30 until 1972) is keyed instant
 * by instant, so the cache never moves a row across a day. It assumes no zone changes its offset
 * twice within 15 minutes.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { MAX_TIMEZONE_CHARS } from '../../contracts/reporting/report-query';

const DAY_KEY_LOCALE = 'en-CA';
const KEY_CACHE_BUCKET_MS = 15 * 60 * 1000;

/** The canonical name of a known zone; `undefined` for an unknown, empty or oversized one. */
export function resolveTimezone(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TIMEZONE_CHARS) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat(DAY_KEY_LOCALE, { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function partOf(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/** A function from a UTC instant to the local day it falls on in `timezone`, which must be known. */
export function createLocalDayKeyer(timezone: string): (utcMs: number) => string {
  const format = new Intl.DateTimeFormat(DAY_KEY_LOCALE, {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const keyAt = (utcMs: number): string => {
    const parts = format.formatToParts(utcMs);
    return `${partOf(parts, 'year')}-${partOf(parts, 'month')}-${partOf(parts, 'day')}`;
  };
  // A bucket a day boundary cuts is stored as `null` and keyed instant by instant.
  const cache = new Map<number, string | null>();
  return (utcMs) => {
    const bucket = Math.floor(utcMs / KEY_CACHE_BUCKET_MS);
    const cached = cache.get(bucket);
    if (cached === null) {
      return keyAt(utcMs);
    }
    if (cached !== undefined) {
      return cached;
    }
    const first = keyAt(bucket * KEY_CACHE_BUCKET_MS);
    const uniform = first === keyAt((bucket + 1) * KEY_CACHE_BUCKET_MS - 1);
    cache.set(bucket, uniform ? first : null);
    return uniform ? first : keyAt(utcMs);
  };
}

/** A UTC instant as ISO-8601 with milliseconds. */
export function toUtcIso(utcMs: number): string {
  return new Date(utcMs).toISOString();
}
