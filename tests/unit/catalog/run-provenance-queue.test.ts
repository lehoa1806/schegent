// Feature 102 (T048, US6 — FR-033, FR-034, FR-037) — the run-provenance reader
// retention actually asks.
//
// Feature 099 shipped the exemption against a reader that answered `false` for
// everything, because nothing recorded a version yet. T035 and T037
// made runs record one, so the exemption now has data behind it and this is the
// reader over that data.
//
// Two things are under test here, and they are two halves of one rule:
//
//   * `createQueueRunProvenance` answers the store's question about whatever it
//     is handed. It reads one field and compares three, and it holds no opinion
//     about which runs are live — that opinion is not the catalog's to have.
//   * `liveRunPlans` is that opinion, and it lives on the activation side where
//     the queue and the run map already do. It is tested beside the reader
//     rather than in its own file because "is this version referenced" is one
//     question whose answer is split across the two, and a split answer is
//     exactly the kind of thing that goes wrong in the seam between two files
//     that are never read together.
//
// The clause most easily got wrong is FR-033's, so it is stated as a defect: a
// run that is **accepted but not draining** — held, paused, or simply waiting to
// be picked up — will still execute the body its frozen version names. An
// implementation that enumerates "the currently running one" passes every test
// where the queue happens to be draining, and prunes the version out from under
// every task that was merely waiting. The predicate is *not terminal*, never
// *currently running*, and the cases below assert both directions of it.

import { describe, expect, it } from 'vitest';

import { liveRunPlans } from '../../../src/activation/run-provenance-enumeration';
import { createQueueRunProvenance } from '../../../src/catalog/run-provenance-queue';
import type { RunVersionCarrier } from '../../../src/catalog/run-provenance-queue';
import type { CatalogVersionRef } from '../../../src/contracts/catalog-version';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const PIPELINE_V4: CatalogVersionRef = { kind: 'pipeline', id: 'analysis', versionId: 'v4' };
const PIPELINE_V5: CatalogVersionRef = { kind: 'pipeline', id: 'analysis', versionId: 'v5' };
/** The store permits a Pipeline and a Workflow to share an id (FR-033). */
const WORKFLOW_V4: CatalogVersionRef = { kind: 'workflow', id: 'analysis', versionId: 'v4' };

/** One enumerated run, reduced to the only field the reader reads. */
function frozen(catalogVersion: CatalogVersionRef): RunVersionCarrier {
  return { catalogVersion };
}

/** A plan frozen before the field existed, or from a caller-supplied snapshot. */
const UNRECORDED: RunVersionCarrier = {};

function asks(...plans: readonly RunVersionCarrier[]) {
  return createQueueRunProvenance(() => plans);
}

describe('createQueueRunProvenance — a live run holds its frozen version open (T048, FR-037)', () => {
  it('exempts the version a queued run froze', async () => {
    const provenance = asks(frozen(PIPELINE_V4));
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
  });

  it('exempts the version an executing run froze', async () => {
    // Same answer through a different carrier: a Run records its version on the
    // pipeline snapshot it is executing, not on a plan. The reader cannot tell
    // the two apart and must not need to.
    const provenance = createQueueRunProvenance(() =>
      liveRunPlans([], [{ status: 'running', pipeline: { catalogVersion: PIPELINE_V4 } }])
    );
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
  });

  it('exempts nothing once no live run records it (FR-034)', async () => {
    // The other direction of the exemption, and the one that makes retention a
    // bound rather than a suggestion: a version an exemption once covered becomes
    // ordinary the moment the run that covered it is gone.
    const provenance = asks(frozen(PIPELINE_V5));
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });

  it('reads the enumeration afresh on every question', async () => {
    // Housekeeping asks once per candidate version and the queue drains while it
    // walks. A reader that snapshotted the plans at construction would answer
    // from a world that has moved, in both directions — holding a drained run's
    // version open, and pruning one a newly accepted run had just frozen.
    const plans: RunVersionCarrier[] = [];
    const provenance = createQueueRunProvenance(() => plans);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    plans.push(frozen(PIPELINE_V4));
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
    plans.length = 0;
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });
});

describe('createQueueRunProvenance — what an exemption does not stretch to (T048, FR-033)', () => {
  it('treats an absent catalogVersion as "not recorded", never as a wildcard', async () => {
    // FR-027. A plan frozen before this feature records nothing, and nothing is
    // not everything: a reader that let absence match would exempt the entire
    // catalog for as long as one legacy plan sat in the queue, which is retention
    // switched off by an old record.
    const provenance = asks(UNRECORDED, UNRECORDED);

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    expect(await provenance.isReferenced('workflow', 'anything', 'v1')).toBe(false);
  });

  it('does not let a Pipeline exemption cover a Workflow of the same id and version', async () => {
    const provenance = asks(frozen(PIPELINE_V4));

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
    expect(await provenance.isReferenced('workflow', 'analysis', 'v4')).toBe(false);
  });

  it('does not let a Workflow exemption cover a Pipeline of the same id and version', async () => {
    const provenance = asks(frozen(WORKFLOW_V4));

    expect(await provenance.isReferenced('workflow', 'analysis', 'v4')).toBe('run-referenced');
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });

  it('does not let one version of a definition cover another', async () => {
    const provenance = asks(frozen(PIPELINE_V4));

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v5')).toBe(false);
  });
});

describe('liveRunPlans — "live" is not terminal, not currently draining (T048, FR-033)', () => {
  it('exempts a run the system has accepted but has not started draining', async () => {
    // The widened FR-033 case. `pending` and `paused` are accepted work: the
    // operator submitted it, the host froze a version for it, and it will execute
    // that version when its turn comes. Narrowing the enumeration to `in-flight`
    // would prune the body out from under everything still waiting.
    const provenance = createQueueRunProvenance(() =>
      liveRunPlans(
        [
          { status: 'pending', runPlan: { catalogVersion: PIPELINE_V4 } },
          { status: 'paused', runPlan: { catalogVersion: PIPELINE_V5 } }
        ],
        []
      )
    );

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v5')).toBe('run-referenced');
  });

  it('exempts the in-flight item too', async () => {
    const provenance = createQueueRunProvenance(() =>
      liveRunPlans([{ status: 'in-flight', runPlan: { catalogVersion: PIPELINE_V4 } }], [])
    );

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
  });

  it('stops exempting once the item reaches a terminal status', async () => {
    // Completed history is out of scope until the run-history surface adds
    // durable history (FR-034): a finished task's version becomes an ordinary
    // retention candidate, and a reader that kept exempting it would make the
    // bound unreachable on any workspace that has ever run anything.
    for (const status of ['completed', 'canceled', 'failed'] as const) {
      const provenance = createQueueRunProvenance(() =>
        liveRunPlans([{ status, runPlan: { catalogVersion: PIPELINE_V4 } }], [])
      );
      expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    }
  });

  it('stops exempting once the Run itself is terminal', async () => {
    for (const status of ['completed', 'canceled', 'failed'] as const) {
      const provenance = createQueueRunProvenance(() =>
        liveRunPlans([], [{ status, pipeline: { catalogVersion: PIPELINE_V4 } }])
      );
      expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    }
  });

  it('keeps exempting a paused Run, which is not over', async () => {
    // `paused` is deliberately absent from `TERMINAL_RUN_STATUSES` — a paused Run
    // still owns its queue, its lease, and its session, and a resume continues on
    // all three. Its body must still be there when it does.
    const provenance = createQueueRunProvenance(() =>
      liveRunPlans([], [{ status: 'paused', pipeline: { catalogVersion: PIPELINE_V4 } }])
    );

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('run-referenced');
  });

  it('skips a queue item and a Run that recorded no version', async () => {
    const plans = liveRunPlans(
      [{ status: 'pending' }, { status: 'pending', runPlan: {} }],
      [{ status: 'running' }]
    );

    expect(plans.every((plan) => plan.catalogVersion === undefined)).toBe(true);
  });

  it('accepts the host types it is wired to, and not a reduced copy of them', () => {
    // A compile-time assertion with a runtime body. The enumerator's parameters
    // are stated as the two fields it reads rather than as the whole of
    // `FeatureRequest` and `WorkflowRun`, which is honest about what it touches
    // and would also silently accept a shape the host cannot supply. This line is
    // what makes the narrowing safe: it fails `typecheck` the moment the real
    // records stop fitting.
    const enumerate: (
      requests: readonly FeatureRequest[],
      runs: readonly WorkflowRun[]
    ) => readonly RunVersionCarrier[] = liveRunPlans;

    expect(enumerate([], [])).toEqual([]);
  });
});
