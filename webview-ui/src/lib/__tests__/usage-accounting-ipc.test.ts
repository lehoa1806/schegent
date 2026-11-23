// FR-R6-F06 (T030) — the usage accounting IPC helper.
//
// `requestUsageAccounting` is the single call site for `CMD_READ_USAGE_ACCOUNTING`. A refusal acks
// `rejected` and still carries the host's `AccountingResult`, so the helper must project by the
// result's validity, not the ack status: a well-formed refusal reaches the caller with its own code,
// and only a missing or malformed result, or a timeout, becomes `store-unavailable`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_READ_USAGE_ACCOUNTING } from '../messages';

type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string; result?: unknown }) => void;

const ackListeners = new Map<string, AckListener>();
const pendingIds: string[] = [];
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingIds.push(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

import { requestUsageAccounting } from '../usage-accounting-ipc';

const STORE_UNAVAILABLE = { ok: false, refusal: { code: 'store-unavailable' } };
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };

function page(nextCursor?: string) {
  return {
    ok: true,
    value: {
      revision: 3,
      cutoffIngestSeq: 7,
      policyVersion: 1,
      calculationVersion: 1,
      rows: [],
      gaps: [],
      unattributedCount: 0,
      ...(nextCursor === undefined ? {} : { nextCursor })
    }
  };
}

function populatedPage() {
  return {
    ok: true,
    value: {
      revision: 9,
      cutoffIngestSeq: 12,
      policyVersion: 1,
      calculationVersion: 1,
      rows: [
        {
          key: { backend: 'claude', utcDay: '2026-11-10' },
          attempts: 2,
          roots: 1,
          measures: [
            {
              measure: 'input_tokens',
              unit: 'count',
              total: '150',
              completeness: 'known',
              coverage: { known: 2, denominator: 2 }
            },
            {
              measure: 'cost',
              unit: 'USD',
              total: '0.250000',
              reportedTotal: '0.250000',
              estimatedTotal: '0.000000',
              completeness: 'partial',
              coverage: { known: 1, denominator: 2 }
            }
          ],
          omittedUnitCount: 2
        }
      ],
      legacy: {
        runCount: 4,
        costMicros: '1250000',
        boundaryRunId: 'legacy-run-4',
        boundaryTerminalUtc: '2026-11-09T23:59:59.000Z',
        reconciliation: 'matched',
        detail: 'unavailable'
      },
      gaps: [{ kind: 'ingest-failed', count: 1 }],
      unattributedCount: 0
    }
  };
}

function deliver(id: string, ack: Parameters<AckListener>[0]): void {
  const listener = ackListeners.get(id);
  if (listener === undefined) throw new Error(`no listener for ${id}`);
  listener(ack);
}

beforeEach(() => {
  ackListeners.clear();
  pendingIds.length = 0;
  posted.length = 0;
  nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestUsageAccounting', () => {
  it('posts the query and marks the id pending', async () => {
    const promise = requestUsageAccounting(QUERY);
    expect(posted).toEqual([{ type: CMD_READ_USAGE_ACCOUNTING, payload: { query: QUERY }, correlationId: 'c1' }]);
    expect(pendingIds).toEqual(['c1']);
    deliver('c1', { status: 'accepted', result: page('cur_2') });
    await expect(promise).resolves.toEqual(page('cur_2'));
  });

  it('keeps a well-formed refusal from a rejected ack', async () => {
    const refusal = { ok: false, refusal: { code: 'invalid-query', detail: 'limit' } };
    const promise = requestUsageAccounting({ ...QUERY, limit: 0 });
    deliver('c1', { status: 'rejected', reason: 'invalid-query', result: refusal });
    await expect(promise).resolves.toEqual(refusal);
  });

  it('accepts a richly populated page with rows, measures, omittedUnitCount, gaps, and legacy summary (16-06)', async () => {
    const valid = populatedPage();
    const promise = requestUsageAccounting(QUERY);
    deliver('c1', { status: 'accepted', result: valid });
    await expect(promise).resolves.toEqual(valid);
  });

  it.each([
    ['no result', undefined],
    ['an unknown refusal code', { ok: false, refusal: { code: 'boom' } }],
    ['a refusal with an unexpected key', { ok: false, refusal: { code: 'invalid-query', extra: true } }],
    ['a refusal with an empty detail', { ok: false, refusal: { code: 'invalid-query', detail: '' } }],
    ['a refusal with an oversized detail (>64 chars)', { ok: false, refusal: { code: 'invalid-query', detail: 'd'.repeat(65) } }],
    ['a refusal with a control-bearing detail', { ok: false, refusal: { code: 'invalid-query', detail: 'limit\n' } }],
    ['a refusal with a space/markup detail', { ok: false, refusal: { code: 'invalid-query', detail: 'bad detail' } }],
    ['missing policyVersion', { ok: true, value: { ...page().value, policyVersion: undefined } }],
    ['wrong calculationVersion', { ok: true, value: { ...page().value, calculationVersion: 2 } }],
    ['a page with no rows array', { ok: true, value: { ...page().value, rows: undefined } }],
    ['a negative revision', { ok: true, value: { ...page().value, revision: -1 } }],
    ['a numeric cursor', { ok: true, value: { ...page().value, nextCursor: 4 } }],
    ['an empty cursor', { ok: true, value: { ...page().value, nextCursor: '' } }],
    ['an oversized cursor (>512 chars)', { ok: true, value: { ...page().value, nextCursor: 'x'.repeat(513) } }],
    ['a control-bearing cursor (C0)', { ok: true, value: { ...page().value, nextCursor: 'cur\n2' } }],
    ['a control-bearing cursor (DEL)', { ok: true, value: { ...page().value, nextCursor: 'cur\u007f2' } }],
    [
      'an oversized rows array (>200 rows)',
      {
        ok: true,
        value: {
          ...page().value,
          rows: Array.from({ length: 201 }, () => ({ key: {}, attempts: 1, roots: 1, measures: [] }))
        }
      }
    ],
    [
      'an oversized gaps array (>20 gaps)',
      {
        ok: true,
        value: {
          ...page().value,
          gaps: Array.from({ length: 21 }, () => ({ kind: 'ingest-failed', count: 1 }))
        }
      }
    ],
    [
      'an oversized measures array (>256 measures)',
      {
        ok: true,
        value: {
          ...page().value,
          rows: [
            {
              key: {},
              attempts: 1,
              roots: 1,
              measures: Array.from({ length: 257 }, () => ({
                measure: 'input_tokens',
                unit: 'count',
                total: '1',
                completeness: 'known',
                coverage: { known: 1, denominator: 1 }
              }))
            }
          ]
        }
      }
    ],
    ['an unexpected page key', { ok: true, value: { ...page().value, surprise: 1 } }],
    [
      'a row with an unexpected key',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          rows: [{ ...populatedPage().value.rows[0], extra: true }]
        }
      }
    ],
    [
      'a row with non-positive omittedUnitCount',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          rows: [{ ...populatedPage().value.rows[0], omittedUnitCount: 0 }]
        }
      }
    ],
    [
      'a row with an invalid dimension key',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          rows: [{ ...populatedPage().value.rows[0], key: { prompt: 'bad' } }]
        }
      }
    ],
    [
      'a measure with known > denominator coverage',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          rows: [
            {
              ...populatedPage().value.rows[0],
              measures: [
                {
                  measure: 'input_tokens',
                  unit: 'count',
                  total: '10',
                  completeness: 'known',
                  coverage: { known: 3, denominator: 2 }
                }
              ]
            }
          ]
        }
      }
    ],
    [
      'a measure with invalid unit for measure',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          rows: [
            {
              ...populatedPage().value.rows[0],
              measures: [
                {
                  measure: 'input_tokens',
                  unit: 'USD',
                  total: '10',
                  completeness: 'known',
                  coverage: { known: 1, denominator: 1 }
                }
              ]
            }
          ]
        }
      }
    ],
    [
      'a gap with an unknown gap kind',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          gaps: [{ kind: 'not-a-gap', count: 1 }]
        }
      }
    ],
    [
      'a legacy summary with non-numeric costMicros',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          legacy: { ...populatedPage().value.legacy, costMicros: '12.34' }
        }
      }
    ],
    [
      'a legacy summary with wrong detail literal',
      {
        ok: true,
        value: {
          ...populatedPage().value,
          legacy: { ...populatedPage().value.legacy, detail: 'available' }
        }
      }
    ]
  ])('projects %s to store-unavailable', async (_label, result) => {
    const promise = requestUsageAccounting(QUERY);
    deliver('c1', { status: 'rejected', reason: 'store-error', result });
    await expect(promise).resolves.toEqual(STORE_UNAVAILABLE);
  });

  it('resolves to store-unavailable when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    const promise = requestUsageAccounting(QUERY);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual(STORE_UNAVAILABLE);
    expect(ackListeners.size).toBe(0);
  });

  it('does not cross-resolve concurrent requests', async () => {
    const first = requestUsageAccounting(QUERY);
    const second = requestUsageAccounting({ ...QUERY, limit: 5 });
    deliver('c2', { status: 'accepted', result: page('two') });
    deliver('c1', { status: 'accepted', result: page('one') });
    await expect(first).resolves.toEqual(page('one'));
    await expect(second).resolves.toEqual(page('two'));
  });
});
