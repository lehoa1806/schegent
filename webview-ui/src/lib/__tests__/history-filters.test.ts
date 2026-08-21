// Feature 103 (T034-T038, US3 — FR-016 to FR-021, FR-054, FR-058, FR-060) —
// narrowing the list.
//
// Every case here is about a way a filter can be wrong while still looking
// right. A disjunction reads identically to a conjunction until a row matches
// two of three predicates (T034). A version filter offered across definitions
// reads identically to a scoped one until two definitions share a version label
// (T035). A time range keyed off `completedAt` alone reads identically to one
// keyed off the ordering key until an in-flight run is in range (T036). And a
// filter naming something that has since been pruned reads identically whether
// it was kept-and-empty or silently dropped — until the operator looks at the
// control and sees a value they never cleared, or worse, does not see the value
// they did set (T038).
//
// `applyFilters` takes `nowMs` rather than reading the clock, so the relative
// windows are assertable at all: a window resolved against a hidden `Date.now()`
// can only be tested by freezing time globally, which every other suite in this
// file's directory then inherits.

import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  buildFilterOptions,
  EMPTY_HISTORY_FILTERS,
  HISTORY_RELATIVE_WINDOWS,
  isFiltered,
  type HistoryFilterSet
} from '../history-filters';
import { NO_CATALOG_NAMES, type CatalogNames, type HistoryRow } from '../history-rows';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  const completedAt = overrides.completedAt ?? '2026-08-20T11:00:00.000Z';
  return Object.freeze({
    runId: 'run-1',
    queueId: 'queue-alpha',
    queueName: 'Alpha',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-deploy',
    catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'Deploy the thing',
    orderingKey: completedAt,
    startedAt: '2026-08-20T10:55:00.000Z',
    completedAt,
    durationMs: 300_000,
    ...overrides
  }) as HistoryRow;
}

function filters(overrides: Partial<HistoryFilterSet> = {}): HistoryFilterSet {
  return { ...EMPTY_HISTORY_FILTERS, ...overrides };
}

const ids = (rows: readonly HistoryRow[]): readonly string[] => rows.map((r) => r.runId);

// ---------------------------------------------------------------------------
// T034 — conjunction
// ---------------------------------------------------------------------------

describe('applyFilters — filters compose as a conjunction (T034, FR-017)', () => {
  const THREE = filters({
    origin: 'standalone',
    definitionId: 'pipe-deploy',
    status: 'failed'
  });

  it('excludes a row that matches two of three active filters', () => {
    // The whole difference between a conjunction and a disjunction, in one row:
    // it is a standalone run of the right definition, and it completed. Under
    // an "or" it is listed; under an "and" it is not, and "and" is what FR-017
    // requires.
    const twoOfThree = row({ runId: 'two-of-three', status: 'completed' });
    const allThree = row({ runId: 'all-three', status: 'failed' });

    expect(ids(applyFilters([twoOfThree, allThree], THREE, NOW))).toEqual(['all-three']);
  });

  it('never grows the result as filters are added (FR-017, SC-004)', () => {
    const rows = [
      row({ runId: 'a', status: 'failed', origin: { kind: 'standalone' } }),
      row({ runId: 'b', status: 'completed', origin: { kind: 'standalone' } }),
      row({ runId: 'c', status: 'failed', origin: { kind: 'workflow-member', workflowId: 'wf-1' } }),
      row({ runId: 'd', status: 'failed', definitionId: 'pipe-other' })
    ];

    const counts = [
      EMPTY_HISTORY_FILTERS,
      filters({ status: 'failed' }),
      filters({ status: 'failed', origin: 'standalone' }),
      THREE
    ].map((set) => applyFilters(rows, set, NOW).length);

    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts[0]).toBe(4);
    expect(counts[counts.length - 1]).toBe(1);
  });

  it('matches everything when nothing is set, and says it is unfiltered', () => {
    const rows = [row({ runId: 'a' }), row({ runId: 'b', status: 'canceled' })];

    expect(ids(applyFilters(rows, EMPTY_HISTORY_FILTERS, NOW))).toEqual(['a', 'b']);
    expect(isFiltered(EMPTY_HISTORY_FILTERS)).toBe(false);
    expect(isFiltered(filters({ status: 'failed' }))).toBe(true);
  });

  it("treats an absent origin as neither 'standalone' nor 'workflow-member' (FR-013)", () => {
    // A run recorded before provenance existed was never asked how it started.
    // Listing it under 'standalone' would answer for it.
    const unrecorded = row({ runId: 'unrecorded', origin: null });
    const standalone = row({ runId: 'standalone', origin: { kind: 'standalone' } });
    const member = row({ runId: 'member', origin: { kind: 'workflow-member', workflowId: 'wf-1' } });
    const all = [unrecorded, standalone, member];

    expect(ids(applyFilters(all, filters({ origin: 'standalone' }), NOW))).toEqual(['standalone']);
    expect(ids(applyFilters(all, filters({ origin: 'workflow-member' }), NOW))).toEqual(['member']);
    expect(ids(applyFilters(all, EMPTY_HISTORY_FILTERS, NOW))).toHaveLength(3);
  });

  it("filters on origin, not on the kind of definition a version identifies (FR-016)", () => {
    // R2 on the filter bar: a Workflow member's frozen body is a Pipeline, so
    // `catalogVersion.kind` reads 'pipeline' on the very row the kind filter
    // must match as a member. A predicate reading the version's kind returns
    // the empty set here and looks like "no members ran".
    const member = row({
      runId: 'member',
      origin: { kind: 'workflow-member', workflowId: 'wf-release' },
      catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' }
    });

    expect(ids(applyFilters([member], filters({ origin: 'workflow-member' }), NOW))).toEqual([
      'member'
    ]);
  });
});

// ---------------------------------------------------------------------------
// T035 — the version filter
// ---------------------------------------------------------------------------

describe('applyFilters — the version filter is scoped to one definition (T035)', () => {
  const rows = [
    row({
      runId: 'deploy-v3',
      definitionId: 'pipe-deploy',
      catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-3' }
    }),
    row({
      runId: 'deploy-v4',
      definitionId: 'pipe-deploy',
      catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-4' }
    }),
    row({
      runId: 'build-v3',
      definitionId: 'pipe-build',
      catalogVersion: { kind: 'pipeline', id: 'pipe-build', versionId: 'ver-3' }
    })
  ];

  it('offers no version until exactly one definition is selected (FR-018)', () => {
    // Version labels are unique within a definition and not across them, so an
    // unscoped list would offer 'ver-3' twice over and mean two different
    // things by it.
    expect(buildFilterOptions(rows, EMPTY_HISTORY_FILTERS, NO_CATALOG_NAMES).versions).toEqual([]);

    const scoped = buildFilterOptions(
      rows,
      filters({ definitionId: 'pipe-deploy' }),
      NO_CATALOG_NAMES
    );
    expect(scoped.versions.map((o) => o.value)).toEqual(['ver-3', 'ver-4']);
  });

  it('lists zero runs of the other version (SC-003)', () => {
    const narrowed = applyFilters(
      rows,
      filters({ definitionId: 'pipe-deploy', versionId: 'ver-3' }),
      NOW
    );

    expect(ids(narrowed)).toEqual(['deploy-v3']);
    expect(narrowed.some((r) => r.catalogVersion?.versionId === 'ver-4')).toBe(false);
  });

  it('never matches a row that recorded no version at all (FR-012)', () => {
    const unversioned = row({ runId: 'older', catalogVersion: null, definitionId: null });

    expect(
      applyFilters([unversioned], filters({ definitionId: 'pipe-deploy', versionId: 'ver-3' }), NOW)
    ).toEqual([]);
    // And it is not offered as a definition either — there is no id to offer.
    const options = buildFilterOptions([unversioned], EMPTY_HISTORY_FILTERS, NO_CATALOG_NAMES);
    expect(options.definitions).toEqual([]);
  });

  it('labels a definition by its catalog name, falling back to the id (FR-021)', () => {
    const names: CatalogNames = {
      pipelines: new Map([['pipe-deploy', 'Deploy service']]),
      workflows: new Map()
    };
    const options = buildFilterOptions(rows, EMPTY_HISTORY_FILTERS, names);

    // Ordered by what the operator reads, not by the id underneath it.
    expect(options.definitions.map((o) => [o.value, o.label])).toEqual([
      ['pipe-deploy', 'Deploy service'],
      ['pipe-build', 'pipe-build']
    ]);
  });
});

// ---------------------------------------------------------------------------
// T036 — the time range
// ---------------------------------------------------------------------------

describe('applyFilters — the time range (T036, FR-019, FR-060)', () => {
  const finished = row({
    runId: 'finished',
    source: 'recorded',
    completedAt: '2026-08-20T11:30:00.000Z',
    orderingKey: '2026-08-20T11:30:00.000Z'
  });
  const live = row({
    runId: 'live',
    source: 'in-flight',
    status: 'running',
    startedAt: '2026-08-20T11:45:00.000Z',
    completedAt: null,
    orderingKey: '2026-08-20T11:45:00.000Z',
    durationMs: null
  });
  const older = row({
    runId: 'older',
    completedAt: '2026-08-13T09:00:00.000Z',
    orderingKey: '2026-08-13T09:00:00.000Z'
  });

  it('matches a finished run by its end time and a running one by its start (FR-019)', () => {
    // The live row has no `completedAt` at all. A predicate reading that field
    // drops every in-flight run the moment any range is set, which reads as
    // "nothing is running" rather than as a filter artefact.
    const within = applyFilters(
      [finished, live, older],
      filters({ range: { kind: 'relative', window: '1h' } }),
      NOW
    );

    // Input order is preserved: the list arrives already ordered by
    // `composeHistoryRows`, and a filter that re-sorts would silently take that
    // decision away from the one function that owns it.
    expect(ids(within)).toEqual(['finished', 'live']);
  });

  it('offers relative windows, each resolving against the supplied clock (FR-060)', () => {
    const rows = [finished, live, older];

    expect(ids(applyFilters(rows, filters({ range: { kind: 'relative', window: '24h' } }), NOW)))
      .toEqual(['finished', 'live']);
    // `older` finished at 09:00 on the 13th — three hours the far side of the
    // 7d boundary, and still in at 30d. Asserted across the boundary rather
    // than well inside it, so a window resolved to the wrong unit fails here.
    expect(ids(applyFilters(rows, filters({ range: { kind: 'relative', window: '7d' } }), NOW)))
      .toEqual(['finished', 'live']);
    expect(ids(applyFilters(rows, filters({ range: { kind: 'relative', window: '30d' } }), NOW)))
      .toEqual(['finished', 'live', 'older']);
    // Every offered window is a real member of the union the range carries.
    expect(HISTORY_RELATIVE_WINDOWS.map((w) => w.value)).toEqual(['1h', '24h', '7d', '30d']);
  });

  it('offers an explicit absolute range with inclusive bounds (FR-019, FR-060)', () => {
    const onTheBound = row({
      runId: 'exactly-at-from',
      completedAt: '2026-08-20T11:30:00.000Z',
      orderingKey: '2026-08-20T11:30:00.000Z'
    });
    const rows = [onTheBound, live, older];

    const inclusive = applyFilters(
      rows,
      filters({
        range: {
          kind: 'absolute',
          from: '2026-08-20T11:30:00.000Z',
          to: '2026-08-20T11:45:00.000Z'
        }
      }),
      NOW
    );

    // Both endpoints are in: "did anything change when I published this
    // version" means at that moment, not strictly after it.
    expect(ids(inclusive)).toEqual(['exactly-at-from', 'live']);
  });

  it('expands a bare calendar date to that whole local day', () => {
    // What a date picker hands back is `YYYY-MM-DD`, and an operator asking for
    // "the 19th" means all of it. Constructed through `Date` so the expectation
    // is the same local day the expansion uses, in any timezone.
    const localNoon = new Date(2026, 7, 19, 12, 0, 0).toISOString();
    const theDay = row({ runId: 'that-day', completedAt: localNoon, orderingKey: localNoon });

    const matched = applyFilters(
      [theDay, older],
      filters({ range: { kind: 'absolute', from: '2026-08-19', to: '2026-08-19' } }),
      NOW
    );

    expect(ids(matched)).toEqual(['that-day']);
  });

  it('treats a half-entered absolute bound as unbounded, not as matching nothing', () => {
    // A date input reports every keystroke. Reading an unparseable bound as an
    // empty range blanks the list mid-typing and looks like the runs vanished.
    const rows = [finished, older];

    expect(ids(applyFilters(rows, filters({ range: { kind: 'absolute', from: '2026-0', to: null } }), NOW)))
      .toEqual(['finished', 'older']);
    expect(ids(applyFilters(rows, filters({ range: { kind: 'absolute', from: null, to: null } }), NOW)))
      .toEqual(['finished', 'older']);
  });

  it('excludes a row with no ordering key from any bounded range, and keeps it unfiltered', () => {
    const keyless = row({ runId: 'keyless', completedAt: null, orderingKey: null });

    expect(applyFilters([keyless], filters({ range: { kind: 'relative', window: '30d' } }), NOW))
      .toEqual([]);
    expect(ids(applyFilters([keyless], EMPTY_HISTORY_FILTERS, NOW))).toEqual(['keyless']);
  });
});

// ---------------------------------------------------------------------------
// T037 — the status filter
// ---------------------------------------------------------------------------

describe('applyFilters — one flat status set (T037, FR-054)', () => {
  it('matches a non-terminal status as directly as a terminal one', () => {
    const rows = [
      row({ runId: 'completed', status: 'completed' }),
      row({ runId: 'failed', status: 'failed' }),
      row({ runId: 'canceled', status: 'canceled' }),
      row({ runId: 'running', status: 'running', source: 'in-flight' }),
      row({ runId: 'paused', status: 'paused', source: 'in-flight' })
    ];

    for (const status of ['completed', 'failed', 'canceled', 'running', 'paused'] as const) {
      expect(ids(applyFilters(rows, filters({ status }), NOW))).toEqual([status]);
    }
  });

  it('has no separate terminal/non-terminal control to set', () => {
    // Structural, and the point of the story: an operator looking for "the
    // paused one" is asking the same question as one looking for "the failed
    // one". A second control would make them two questions, and the filter set
    // is where a second control would have to live.
    expect(Object.keys(EMPTY_HISTORY_FILTERS).sort()).toEqual([
      'definitionId',
      'origin',
      'queueId',
      'range',
      'status',
      'versionId'
    ]);
  });

  it('matches a non-terminal value only against the display-only projection (FR-054)', () => {
    // A recorded row can only hold one of three terminal outcomes, so 'running'
    // can only ever select in-flight rows. Asserted so that a future writer
    // stamping a provisional 'running' record fails here rather than in FR-004.
    const rows = [
      row({ runId: 'live', status: 'running', source: 'in-flight' }),
      row({ runId: 'done', status: 'completed', source: 'recorded' })
    ];

    const running = applyFilters(rows, filters({ status: 'running' }), NOW);
    expect(running.every((r) => r.source === 'in-flight')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T038 — the queue filter and stale values
// ---------------------------------------------------------------------------

describe('buildFilterOptions — the unattributed partition is selectable (T038, FR-058)', () => {
  const rows = [
    row({ runId: 'attributed', queueId: 'queue-alpha', queueName: 'Alpha' }),
    row({ runId: 'orphan', queueId: '__unattributed__', queueName: 'Unattributed' })
  ];

  it('offers the partition as an ordinary queue value', () => {
    const options = buildFilterOptions(rows, EMPTY_HISTORY_FILTERS, NO_CATALOG_NAMES);

    expect(options.queues.map((o) => o.value)).toContain('__unattributed__');
    // Named as the row names it. `__unattributed__` is an internal key and an
    // operator reading it in a dropdown would take it for a bug.
    expect(options.queues.find((o) => o.value === '__unattributed__')?.label).toBe('Unattributed');
  });

  it('selects exactly those runs (FR-006, FR-058)', () => {
    expect(ids(applyFilters(rows, filters({ queueId: '__unattributed__' }), NOW))).toEqual([
      'orphan'
    ]);
  });
});

describe('a filter value that no longer corresponds to anything (T038, FR-021)', () => {
  const rows = [
    row({
      runId: 'current',
      definitionId: 'pipe-deploy',
      catalogVersion: { kind: 'pipeline', id: 'pipe-deploy', versionId: 'ver-4' },
      queueId: 'queue-alpha',
      queueName: 'Alpha'
    })
  ];

  it('is retained in the option list and reported as no longer present', () => {
    // Kept, not dropped. Dropping it changes what the operator is looking at
    // without telling them, and the next thing they do is trust the list.
    const pruned = filters({
      definitionId: 'pipe-deploy',
      versionId: 'ver-1',
      queueId: 'queue-deleted'
    });
    const options = buildFilterOptions(rows, pruned, NO_CATALOG_NAMES);

    expect(options.versions.find((o) => o.value === 'ver-1')).toMatchObject({ missing: true });
    expect(options.queues.find((o) => o.value === 'queue-deleted')).toMatchObject({
      missing: true
    });
    // The values that are still present are not flagged.
    expect(options.versions.find((o) => o.value === 'ver-4')).toMatchObject({ missing: false });
  });

  it('matches nothing, and does not throw', () => {
    const pruned = filters({ definitionId: 'pipe-deploy', versionId: 'ver-1' });

    expect(() => applyFilters(rows, pruned, NOW)).not.toThrow();
    expect(applyFilters(rows, pruned, NOW)).toEqual([]);
  });

  it('reports a removed definition the same way', () => {
    const options = buildFilterOptions(
      rows,
      filters({ definitionId: 'pipe-gone' }),
      NO_CATALOG_NAMES
    );

    expect(options.definitions.find((o) => o.value === 'pipe-gone')).toMatchObject({
      missing: true
    });
    expect(applyFilters(rows, filters({ definitionId: 'pipe-gone' }), NOW)).toEqual([]);
  });
});
