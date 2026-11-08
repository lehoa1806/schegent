// FR-R5-F32 (F32-T04, F32-T05) — Pure formatting helpers for CandidateBlockInspector.
//
// Preserves uncertainty and missing values honestly (never defaulting missing recovery
// coverage to 'complete' or missing effect certainty to 'safe') and formats deadlines,
// reset estimates, and next-check timestamps in the operator's local or chosen timezone
// with explicit calendar-day rollover indicators.

import type { ControlProjection } from '../../lib/snapshot-types';

export interface FormatControlTimestampOptions {
  readonly timeZone?: string;
  readonly referenceTimeMs?: number;
}

function calendarDateInZone(epochMs: number, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date(epochMs));
}

export function formatControlTimestamp(
  timestamp: number | string | undefined,
  options: FormatControlTimestampOptions = {}
): string {
  if (timestamp === undefined || timestamp === '') return 'Not scheduled';
  const targetMs = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(targetMs)) return 'Invalid timestamp';

  const refMs = options.referenceTimeMs ?? Date.now();
  const timeZone = options.timeZone;

  const targetDate = calendarDateInZone(targetMs, timeZone);
  const refDate = calendarDateInZone(refMs, timeZone);
  const isRollover = targetDate !== refDate;

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
  const formattedTime = timeFormatter.format(new Date(targetMs));
  return isRollover
    ? `${targetDate} ${formattedTime} (day rollover)`
    : `${targetDate} ${formattedTime}`;
}

export function formatRecoveryCoverageLabel(
  coverage: ControlProjection['recoveryCoverage'],
  manifestTruncated?: boolean,
  preexistingDirtyCount?: number
): string {
  if (coverage === undefined) {
    return 'Not recorded (unavailable)';
  }
  const suffixes: string[] = [];
  if (manifestTruncated === true) {
    suffixes.push('manifest truncated');
  }
  if (typeof preexistingDirtyCount === 'number' && preexistingDirtyCount > 0) {
    suffixes.push(`${preexistingDirtyCount} preexisting dirty path(s) preserved`);
  }
  return suffixes.length > 0 ? `${coverage} (${suffixes.join(', ')})` : coverage;
}

export function formatEffectCertaintyLabel(
  certainty: ControlProjection['effectCertainty']
): string {
  if (certainty === undefined) {
    return 'Not recorded (unknown)';
  }
  return certainty;
}

export function formatMicrousd(microusd: number | undefined): string {
  if (microusd === undefined || !Number.isFinite(microusd)) {
    return 'Unavailable';
  }
  const usd = microusd / 1_000_000;
  return `$${usd.toFixed(4)} (${microusd} µUSD)`;
}
