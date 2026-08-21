// Feature 103 (T070, T071 — US6) — the second pin set: versions held open by a
// run that has finished but is still in history.
//
// Feature 102 pinned versions for runs that had not finished yet, and said so in
// this module's own comment: completed history was out of scope because there was
// no durable history to read. There is now, and the gap it left is the one this
// story names — a history row the operator can still see, pointing at a
// definition version retention has already pruned. FR-040 closes it by making a
// retained row a pin, and FR-043 bounds it by making eviction the release.
//
// The two halves are asserted apart. `retainedHistoryPlans` decides which rows
// contribute; `createQueueRunProvenance` decides whether a contribution matches.
// Composing them here rather than in `extension.ts`-shaped scaffolding is what
// makes the exemption reason (`'history-referenced'` rather than
// `'run-referenced'`) assertable at all — it is the composition that names it.

import { describe, expect, it } from 'vitest';
import {
  liveRunPlans,
  retainedHistoryPlans
} from '../../../src/activation/run-provenance-enumeration';
import { createQueueRunProvenance } from '../../../src/catalog';
import type { CatalogVersionRef } from '../../../src/contracts/catalog-version';

/** One history row, reduced to the only field the pin set reads. */
function historyRow(catalogVersion?: CatalogVersionRef): { catalogVersion?: CatalogVersionRef } {
  return catalogVersion === undefined ? {} : { catalogVersion };
}

const ANALYSIS_V4: CatalogVersionRef = { kind: 'pipeline', id: 'analysis', versionId: 'v4' };

/**
 * The reader as activation composes it, with the live half empty.
 *
 * Empty on purpose in most cases below: a version that is also frozen by a live
 * run would be exempt either way, so a test that left a queue item in place could
 * not tell whether the history source did anything.
 */
function provenanceOverHistory(rows: ReadonlyArray<{ catalogVersion?: CatalogVersionRef }>) {
  return createQueueRunProvenance(
    () => [],
    () => retainedHistoryPlans(rows)
  );
}

describe('retainedHistoryPlans: which rows pin a version (FR-040)', () => {
  it('collects the version a retained row recorded', () => {
    expect(retainedHistoryPlans([historyRow(ANALYSIS_V4)])).toEqual([
      { catalogVersion: ANALYSIS_V4 }
    ]);
  });

  it('contributes nothing for a row that recorded no version', () => {
    // FR-027's rule, restated for the second source: absence is "not recorded",
    // never a wildcard. A row written before provenance existed must not exempt
    // the catalog it says nothing about.
    expect(retainedHistoryPlans([historyRow()])).toEqual([]);
  });

  it('reads the rows it is handed, every call, and remembers none of them', () => {
    // FR-042 in the smallest form it has. The mutable array stands in for the
    // history store, and the thunk is what activation passes: a second call that
    // returned the first call's answer would be a cache, and a cache is the only
    // way a version can outlive the row that pinned it.
    const rows: { catalogVersion?: CatalogVersionRef }[] = [historyRow(ANALYSIS_V4)];
    const enumerate = () => retainedHistoryPlans(rows);

    expect(enumerate()).toHaveLength(1);
    rows.length = 0;
    expect(enumerate()).toHaveLength(0);
  });
});

describe('the history pin set, through the reader retention consults (FR-040)', () => {
  it('reports a version referenced only by a retained row, and names why', async () => {
    const provenance = provenanceOverHistory([historyRow(ANALYSIS_V4)]);

    // `'history-referenced'` and not `true`: the two sources hold a version open
    // for different lengths of time — one until the run ends, the other until the
    // row is evicted — and an operator told only "referenced" cannot tell which
    // event releases it.
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('history-referenced');
  });

  it('reports nothing for a version no retained row recorded', async () => {
    const provenance = provenanceOverHistory([
      historyRow({ kind: 'pipeline', id: 'analysis', versionId: 'v3' })
    ]);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });

  it('reports nothing when every retained row recorded no version', async () => {
    const provenance = provenanceOverHistory([historyRow(), historyRow()]);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    // Nor does it become a wildcard for some other definition.
    expect(await provenance.isReferenced('workflow', 'anything', 'v1')).toBe(false);
  });

  it('does not let a Pipeline row exempt the Workflow that shares its id', async () => {
    // The store permits a Pipeline and a Workflow to hold the same id, so
    // `(pipeline, X, v4)` and `(workflow, X, v4)` are two different versions.
    // Matching on the id alone would prune neither, which looks like caution and
    // is actually a retention bound that silently stops applying.
    const provenance = provenanceOverHistory([historyRow(ANALYSIS_V4)]);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('history-referenced');
    expect(await provenance.isReferenced('workflow', 'analysis', 'v4')).toBe(false);
  });

  it('does not let one version of a definition exempt another', async () => {
    const provenance = provenanceOverHistory([historyRow(ANALYSIS_V4)]);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v5')).toBe(false);
  });
});

describe('the two sources together (FR-040)', () => {
  it('names the live run when a version is both running and in history', async () => {
    // Both are true, and one of them is more useful: a live run releases the
    // version when it finishes, at which point the history row takes over. Naming
    // the shorter-lived cause first is what makes the reported reason match the
    // event the operator would wait for.
    const provenance = createQueueRunProvenance(
      () => liveRunPlans([{ status: 'in_progress', runPlan: { catalogVersion: ANALYSIS_V4 } }], []),
      () => retainedHistoryPlans([historyRow(ANALYSIS_V4)])
    );

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
  });

  it('falls through to history when the live run has gone terminal', async () => {
    const provenance = createQueueRunProvenance(
      () => liveRunPlans([{ status: 'completed', runPlan: { catalogVersion: ANALYSIS_V4 } }], []),
      () => retainedHistoryPlans([historyRow(ANALYSIS_V4)])
    );

    // The same version, the same instant, a different reason — which is exactly
    // the handover FR-040 describes: the queue stops holding it and the record
    // starts.
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('history-referenced');
  });

  it('reports nothing once neither source holds the version', async () => {
    const provenance = createQueueRunProvenance(
      () => liveRunPlans([{ status: 'completed', runPlan: { catalogVersion: ANALYSIS_V4 } }], []),
      () => retainedHistoryPlans([])
    );

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });

  it('still answers with no history source at all', async () => {
    // The second enumeration is optional because the store is built before the
    // history store exists, same as the first. A caller that supplies neither gets
    // a reader that exempts nothing, which is the right answer for a host that has
    // run nothing.
    const provenance = createQueueRunProvenance(() => []);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });
});
