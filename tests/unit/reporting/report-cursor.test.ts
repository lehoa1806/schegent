// FR-R6-F11 T015 — the report cursor (data-model "Cursor").
//
// WHAT THIS PINS:
//   - a cursor round-trips and stays at most 256 characters;
//   - a tampered digest, a bad offset, extra or missing keys, a wrong version, non-JSON and
//     non-base64url text each refuse `invalid-cursor`;
//   - a cursor naming a report that is not live is `expired` with `restart-report-query`.

import { describe, expect, it } from 'vitest';
import { MAX_CURSOR_CHARS } from '../../../src/contracts/reporting/report-query';
import {
  type CursorTarget,
  encodeReportCursor,
  resolveReportCursor
} from '../../../src/services/reporting/report-cursor';

const REPORT_ID = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const ROW_COUNT = 120;

function lookup(reportId: string): CursorTarget | undefined {
  return reportId === REPORT_ID ? { queryDigest: DIGEST, rowCount: ROW_COUNT } : undefined;
}

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const INVALID = { ok: false, outcome: 'refused', reason: 'invalid-cursor' };

describe('FR-R6-F11 T015 — report cursor', () => {
  it('round-trips the report and offset, within 256 characters', () => {
    const cursor = encodeReportCursor(REPORT_ID, DIGEST, 50);
    expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_CHARS);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolveReportCursor(cursor, lookup)).toEqual({ ok: true, value: { reportId: REPORT_ID, offset: 50 } });

    const longest = encodeReportCursor('r'.repeat(128), DIGEST, Number.MAX_SAFE_INTEGER);
    expect(longest.length).toBeLessThanOrEqual(MAX_CURSOR_CHARS);
  });

  it('carries only the first 16 digest characters', () => {
    const decoded: unknown = JSON.parse(Buffer.from(encodeReportCursor(REPORT_ID, DIGEST, 1), 'base64url').toString('utf8'));
    expect(decoded).toEqual({ v: 1, r: REPORT_ID, d: DIGEST.slice(0, 16), o: 1 });
  });

  it('refuses a tampered digest', () => {
    expect(resolveReportCursor(encodeReportCursor(REPORT_ID, OTHER_DIGEST, 50), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(raw({ v: 1, r: REPORT_ID, d: 'A'.repeat(16), o: 1 }), lookup)).toEqual(INVALID);
  });

  it('refuses an offset that is negative, fractional, not a number, or not within the rows', () => {
    for (const offset of [-1, 1.5, '5', null, ROW_COUNT, ROW_COUNT + 1]) {
      expect(resolveReportCursor(raw({ v: 1, r: REPORT_ID, d: DIGEST.slice(0, 16), o: offset }), lookup)).toEqual(INVALID);
    }
    expect(resolveReportCursor(raw({ v: 1, r: REPORT_ID, d: DIGEST.slice(0, 16), o: ROW_COUNT - 1 }), lookup)).toEqual({
      ok: true,
      value: { reportId: REPORT_ID, offset: ROW_COUNT - 1 }
    });
  });

  it('refuses extra keys, missing keys and a wrong version', () => {
    const base = { v: 1, r: REPORT_ID, d: DIGEST.slice(0, 16), o: 1 };
    expect(resolveReportCursor(raw({ ...base, x: 1 }), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(raw({ v: 1, r: REPORT_ID, d: DIGEST.slice(0, 16) }), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(raw({ ...base, v: 2 }), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(raw([1, REPORT_ID, DIGEST, 1]), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(raw({ ...base, r: '../x' }), lookup)).toEqual(INVALID);
  });

  it('refuses non-JSON, non-base64url, over-long and non-string input', () => {
    expect(resolveReportCursor(Buffer.from('not json', 'utf8').toString('base64url'), lookup)).toEqual(INVALID);
    expect(resolveReportCursor('abc+/=', lookup)).toEqual(INVALID);
    expect(resolveReportCursor('', lookup)).toEqual(INVALID);
    expect(resolveReportCursor('A'.repeat(MAX_CURSOR_CHARS + 1), lookup)).toEqual(INVALID);
    expect(resolveReportCursor(42, lookup)).toEqual(INVALID);
    const padded = `${encodeReportCursor(REPORT_ID, DIGEST, 50)}=`;
    expect(resolveReportCursor(padded, lookup)).toEqual(INVALID);
  });

  it('answers expired for a report that is not live', () => {
    const cursor = encodeReportCursor('0aa1bb2c-0000-4000-8000-000000000000', DIGEST, 5);
    expect(resolveReportCursor(cursor, lookup)).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
  });
});
