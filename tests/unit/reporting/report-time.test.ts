// FR-R6-F11 T010 — the report time basis (research R5).
//
// WHAT THIS PINS:
//   - a local-day key follows the timezone's own days across a daylight-saving start and end,
//     for a one-hour shift (America/New_York) and a half-hour shift (Australia/Lord_Howe);
//   - a timezone name resolves to its canonical spelling, and an unknown or oversized one refuses.

import { describe, expect, it } from 'vitest';
import { createLocalDayKeyer, resolveTimezone, toUtcIso } from '../../../src/services/reporting/report-time';

function dayOf(timezone: string, iso: string): string {
  return createLocalDayKeyer(timezone)(Date.parse(iso));
}

describe('FR-R6-F11 T010 — report time', () => {
  it.each<[string, string, string]>([
    ['America/New_York', '2026-03-08T04:59:59.999Z', '2026-03-07'],
    ['America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-08'],
    ['America/New_York', '2026-03-09T03:59:59.999Z', '2026-03-08'],
    ['America/New_York', '2026-03-09T04:00:00.000Z', '2026-03-09'],
    ['America/New_York', '2026-11-01T03:59:59.999Z', '2026-10-31'],
    ['America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T04:59:59.999Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T05:00:00.000Z', '2026-11-02'],
    ['Australia/Lord_Howe', '2026-04-04T12:59:59.999Z', '2026-04-04'],
    ['Australia/Lord_Howe', '2026-04-04T13:00:00.000Z', '2026-04-05'],
    ['Australia/Lord_Howe', '2026-04-05T13:29:59.999Z', '2026-04-05'],
    ['Australia/Lord_Howe', '2026-04-05T13:30:00.000Z', '2026-04-06'],
    ['Australia/Lord_Howe', '2026-10-03T13:29:59.999Z', '2026-10-03'],
    ['Australia/Lord_Howe', '2026-10-03T13:30:00.000Z', '2026-10-04'],
    ['Australia/Lord_Howe', '2026-10-04T12:59:59.999Z', '2026-10-04'],
    ['Australia/Lord_Howe', '2026-10-04T13:00:00.000Z', '2026-10-05']
  ])('%s: %s is local day %s', (timezone, iso, expected) => {
    expect(dayOf(timezone, iso)).toBe(expected);
  });

  it('keeps answering correctly when one keyer is reused across a transition in any order', () => {
    const keyer = createLocalDayKeyer('America/New_York');
    const instants = ['2026-11-02T05:00:00.000Z', '2026-11-01T03:59:59.999Z', '2026-11-02T04:59:59.999Z', '2026-11-01T04:00:00.000Z'];
    expect(instants.map((iso) => keyer(Date.parse(iso)))).toEqual(['2026-11-02', '2026-10-31', '2026-11-01', '2026-11-01']);
  });

  it('cuts a day correctly when the offset is not a whole number of quarter hours, in either read order', () => {
    const before = Date.parse('2026-11-10T23:50:00.000Z');
    const after = Date.parse('2026-11-10T23:55:00.000Z');
    const forward = createLocalDayKeyer('+00:07');
    expect([forward(before), forward(after)]).toEqual(['2026-11-10', '2026-11-11']);
    const backward = createLocalDayKeyer('+00:07');
    expect([backward(after), backward(before)]).toEqual(['2026-11-11', '2026-11-10']);
    const monrovia = createLocalDayKeyer('Africa/Monrovia');
    expect([monrovia(Date.parse('1971-06-01T00:44:00.000Z')), monrovia(Date.parse('1971-06-01T00:44:45.000Z'))]).toEqual([
      '1971-05-31',
      '1971-06-01'
    ]);
  });

  it('resolves a timezone to its canonical name and refuses an unknown, empty or oversized one', () => {
    expect(resolveTimezone('america/new_york')).toBe('America/New_York');
    expect(resolveTimezone('UTC')).toBe('UTC');
    expect(resolveTimezone('Nope/Zone')).toBeUndefined();
    expect(resolveTimezone('')).toBeUndefined();
    expect(resolveTimezone(`${'A'.repeat(60)}/Zone`)).toBeUndefined();
    expect(resolveTimezone(42)).toBeUndefined();
  });

  it('formats a UTC instant with milliseconds', () => {
    expect(toUtcIso(Date.parse('2026-03-08T05:00:00.000Z'))).toBe('2026-03-08T05:00:00.000Z');
  });
});
