// FR-R6-F11 T009 — the report query validator (FR-001, FR-002, FR-004; data-model ReportQuery).
//
// WHAT THIS PINS:
//   - an exact key set at every level, refused `invalid-query` before any read;
//   - the defaults: the 30 days ending at query start, the host zone, page size 50, the view's
//     default grouping and sort;
//   - each spec Edge Case refusal: an empty or over-wide range, an unknown zone, a dimension or
//     filter the view does not carry (`unsupported-dimension`), more than 64 filter values and
//     more than three grouping dimensions;
//   - the canonical form and its digest do not depend on filter order.

import { describe, expect, it } from 'vitest';
import { DAY_MS, type ReportQuery } from '../../../src/contracts/reporting/report-query';
import type { ReportResult } from '../../../src/contracts/reporting/report-outcomes';
import {
  canonicalQueryJson,
  queryDigest,
  validateReportQuery
} from '../../../src/services/reporting/report-query-validator';

const NOW = 1_800_000_000_000;
const CONTEXT = { nowMs: NOW, hostTimezone: 'america/new_york' };

function validate(input: unknown): ReportResult<ReportQuery> {
  return validateReportQuery(input, CONTEXT);
}

function accepted(input: unknown): ReportQuery {
  const result = validate(input);
  if (!result.ok) {
    throw new Error(`expected a query, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

function refusal(input: unknown): string | undefined {
  const result = validate(input);
  if (result.ok || result.outcome !== 'refused') {
    return undefined;
  }
  return result.reason;
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);
}

describe('FR-R6-F11 T009 — report query validator', () => {
  it('applies the defaults for a run-derived view', () => {
    expect(accepted({ view: 'execution-summary' })).toEqual({
      view: 'execution-summary',
      range: { startMs: NOW - 30 * DAY_MS, endMs: NOW },
      timezone: 'America/New_York',
      filters: {},
      groupBy: [],
      sort: 'root-created-desc',
      pageSize: 50
    });
  });

  it.each<[string, readonly string[], string]>([
    ['usage', ['backend', 'model'], 'key-asc'],
    ['failure-cause', [], 'key-asc'],
    ['workflow-revision', [], 'key-asc'],
    ['time-series', [], 'key-asc'],
    ['attempt-detail', [], 'root-created-desc']
  ])('defaults %s to grouping %j and sort %s', (view, groupBy, sort) => {
    const query = accepted({ view });
    expect(query.groupBy).toEqual(groupBy);
    expect(query.sort).toBe(sort);
  });

  it('switches the execution summary to group sorts once it is grouped', () => {
    expect(accepted({ view: 'execution-summary', groupBy: ['outcome'] }).sort).toBe('key-asc');
    expect(accepted({ view: 'execution-summary', groupBy: ['outcome'], sort: 'roots-desc' }).sort).toBe('roots-desc');
    expect(refusal({ view: 'execution-summary', groupBy: ['outcome'], sort: 'duration-desc' })).toBe('invalid-query');
    expect(refusal({ view: 'execution-summary', sort: 'roots-desc' })).toBe('invalid-query');
  });

  it('keeps an explicit empty grouping on the usage view', () => {
    expect(accepted({ view: 'usage', groupBy: [] }).groupBy).toEqual([]);
  });

  it('refuses a request that is not an exact key set', () => {
    expect(refusal(null)).toBe('invalid-query');
    expect(refusal([])).toBe('invalid-query');
    expect(refusal({})).toBe('invalid-query');
    expect(refusal({ view: 'pivot' })).toBe('invalid-query');
    expect(refusal({ view: 'usage', sql: 'DROP TABLE runs' })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: 1, endMs: 2, extra: 3 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', filters: { label: ['x'] } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', filters: [] })).toBe('invalid-query');
  });

  it('refuses a range that is empty, inverted, too wide or not integral, and accepts exactly 90 days', () => {
    expect(refusal({ view: 'usage', range: { startMs: 5, endMs: 5 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: 6, endMs: 5 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: 0, endMs: 90 * DAY_MS + 1 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: 0.5, endMs: 5 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: -1, endMs: 5 } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', range: { startMs: '0', endMs: 5 } })).toBe('invalid-query');
    expect(accepted({ view: 'usage', range: { startMs: 0, endMs: 90 * DAY_MS } }).range).toEqual({ startMs: 0, endMs: 90 * DAY_MS });
    // The last instant a date can hold is 8,640,000,000,000,000 ms; a range past it is refused, never thrown.
    const lastDateMs = 8_640_000_000_000_000;
    expect(refusal({ view: 'usage', range: { startMs: lastDateMs - 1, endMs: lastDateMs + 1 } })).toBe('invalid-query');
    expect(accepted({ view: 'usage', range: { startMs: lastDateMs - 1, endMs: lastDateMs } }).range).toEqual({
      startMs: lastDateMs - 1,
      endMs: lastDateMs
    });
  });

  it('refuses an unknown timezone and canonicalizes a known one', () => {
    expect(refusal({ view: 'usage', timezone: 'Mars/Olympus' })).toBe('invalid-query');
    expect(refusal({ view: 'usage', timezone: '' })).toBe('invalid-query');
    expect(accepted({ view: 'usage', timezone: 'utc' }).timezone).toBe('UTC');
  });

  it('refuses a filter or dimension the view does not carry as unsupported-dimension', () => {
    expect(refusal({ view: 'usage', filters: { workflowId: ['wf-a'] } })).toBe('unsupported-dimension');
    expect(refusal({ view: 'usage', filters: { outcome: ['failed'] } })).toBe('unsupported-dimension');
    expect(refusal({ view: 'execution-summary', filters: { backend: ['claude'] } })).toBe('unsupported-dimension');
    expect(refusal({ view: 'execution-summary', groupBy: ['localDay'] })).toBe('unsupported-dimension');
    expect(refusal({ view: 'attempt-detail', groupBy: ['workflowId'] })).toBe('unsupported-dimension');
    expect(refusal({ view: 'time-series', groupBy: ['frozenDefinitionId'] })).toBe('unsupported-dimension');
    expect(refusal({ view: 'failure-cause', groupBy: ['failureCause'] })).toBe('unsupported-dimension');
  });

  it('refuses more than three grouping dimensions, a duplicate and an unknown dimension', () => {
    expect(refusal({ view: 'usage', groupBy: ['backend', 'model', 'utcDay', 'backend'] })).toBe('invalid-query');
    expect(refusal({ view: 'usage', groupBy: ['backend', 'backend'] })).toBe('invalid-query');
    expect(refusal({ view: 'usage', groupBy: ['tenant'] })).toBe('invalid-query');
    expect(refusal({ view: 'usage', groupBy: 'backend' })).toBe('invalid-query');
    expect(accepted({ view: 'usage', groupBy: ['utcDay', 'backend', 'model'] }).groupBy).toEqual(['utcDay', 'backend', 'model']);
  });

  it('allows 64 filter values in total and refuses 65', () => {
    const at = { rootId: ids('r', 32), workflowId: ids('wf', 32) };
    expect(accepted({ view: 'execution-summary', filters: at }).filters.rootId).toHaveLength(32);
    const over = { rootId: ids('r', 33), workflowId: ids('wf', 32) };
    expect(refusal({ view: 'execution-summary', filters: over })).toBe('invalid-query');
  });

  it('refuses an empty, duplicated or malformed filter value list', () => {
    expect(refusal({ view: 'execution-summary', filters: { rootId: [] } })).toBe('invalid-query');
    expect(refusal({ view: 'execution-summary', filters: { rootId: ['r-1', 'r-1'] } })).toBe('invalid-query');
    expect(refusal({ view: 'execution-summary', filters: { rootId: ['../etc'] } })).toBe('invalid-query');
    expect(refusal({ view: 'execution-summary', filters: { rootId: 'r-1' } })).toBe('invalid-query');
    expect(refusal({ view: 'execution-summary', filters: { outcome: ['exploded'] } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', filters: { backend: ['Claude'] } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', filters: { model: ['m 1'] } })).toBe('invalid-query');
  });

  it('takes one value each for backend and model', () => {
    expect(accepted({ view: 'usage', filters: { backend: ['claude'], model: ['m-1'] } }).filters).toEqual({
      backend: ['claude'],
      model: ['m-1']
    });
    expect(refusal({ view: 'usage', filters: { backend: ['claude', 'codex'] } })).toBe('invalid-query');
    expect(refusal({ view: 'usage', filters: { model: ['m-1', 'm-2'] } })).toBe('invalid-query');
  });

  it('bounds the page size', () => {
    expect(accepted({ view: 'usage', pageSize: 200 }).pageSize).toBe(200);
    expect(accepted({ view: 'usage', pageSize: 1 }).pageSize).toBe(1);
    expect(refusal({ view: 'usage', pageSize: 0 })).toBe('invalid-query');
    expect(refusal({ view: 'usage', pageSize: 201 })).toBe('invalid-query');
    expect(refusal({ view: 'usage', pageSize: 1.5 })).toBe('invalid-query');
  });

  it('gives one canonical form and digest whatever the filter order', () => {
    const first = accepted({
      view: 'execution-summary',
      filters: { workflowId: ['wf-b', 'wf-a'], rootId: ['r-2', 'r-1'] }
    });
    const second = accepted({
      view: 'execution-summary',
      filters: { rootId: ['r-1', 'r-2'], workflowId: ['wf-a', 'wf-b'] }
    });
    expect(canonicalQueryJson(first)).toBe(canonicalQueryJson(second));
    expect(canonicalQueryJson(first)).toBe(
      `{"view":"execution-summary","range":{"startMs":${String(NOW - 30 * DAY_MS)},"endMs":${String(NOW)}},` +
        '"timezone":"America/New_York","filters":{"rootId":["r-1","r-2"],"workflowId":["wf-a","wf-b"]},' +
        '"groupBy":[],"sort":"root-created-desc","pageSize":50}'
    );
    expect(queryDigest(first)).toBe(queryDigest(second));
    expect(queryDigest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(queryDigest(accepted({ view: 'execution-summary', pageSize: 10 }))).not.toBe(
      queryDigest(accepted({ view: 'execution-summary' }))
    );
  });

  it('returns a frozen query', () => {
    const query = accepted({ view: 'usage', filters: { rootId: ['r-1'] } });
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.filters)).toBe(true);
    expect(Object.isFrozen(query.filters.rootId)).toBe(true);
  });
});
