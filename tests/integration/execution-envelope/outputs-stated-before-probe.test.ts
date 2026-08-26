// FR-R3-001 (T271) — the targets the backend is told to write are the targets
// Schegent then looks for.
//
// Two claims, and they are separable, which is why one fixture holds both:
//
//   * **Stated before probed.** The declared targets appear in the prompt of the
//     first invocation, and no output record exists on the Run at that moment.
//     Feature 087 satisfied the second half and not the first — it probed
//     targets the backend was never told about, which is how a run could produce
//     nothing and be recorded as having failed to produce it.
//   * **Probed from the same envelope.** Not from a second read of the queue
//     row. The distinction is invisible while the two copies agree, so this
//     fixture makes them disagree: mid-flight it rewrites the queued plan to
//     name a decoy target that *does* exist on disk. A regression that re-reads
//     the row records `decoy` as resolved; reading the envelope records what the
//     operator actually declared.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  REPORT_TARGET,
  SUMMARY_TARGET,
  driveEnvelopeRun,
  rewriteQueuedPlan
} from './envelope-harness';
import { removeTempRoot } from '../../temp-root-cleanup';

const DECOY_TARGET = 'out/decoy.md';

let workspaceRoot: string;
/** The Run as persisted at the moment the first CLI invocation was about to go out. */
let atFirstInvocation: WorkflowRun | undefined;
/** The queued row's declared outputs, read back after the mid-flight rewrite. */
let queuedOutputsAfterRewrite: readonly { readonly portId: string }[] | undefined;
let finished: WorkflowRun;

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-envelope-outputs-'));

  const harness = await driveEnvelopeRun(workspaceRoot, {
    // `report` is written, `summary` is not: one resolved and one unresolved in
    // the same run, so "records everything" and "records what exists" are told
    // apart. `decoy` exists so that a regression reading the queue row would
    // resolve it rather than quietly recording nothing.
    existingOutputs: [REPORT_TARGET, DECOY_TARGET],
    beforeInvocation: async (index, context) => {
      if (index === 0) {
        atFirstInvocation = context.store.getRun(DEFAULT_QUEUE_ID) ?? undefined;
        return;
      }
      await rewriteQueuedPlan(context, (plan) => ({
        ...plan,
        outputs: [
          { portId: 'decoy', type: 'markdown', target: DECOY_TARGET, overwriteConfirmed: false }
        ]
      }));
      queuedOutputsAfterRewrite = context.store
        .getQueue(DEFAULT_QUEUE_ID)
        .requests.find((request) => request.id === context.featureId)?.runPlan?.outputs;
    }
  });

  finished = harness.finishedRun();
}, 30_000);

afterAll(async () => {
  await removeTempRoot(workspaceRoot);
});

describe('declared outputs are stated before they are probed (FR-R3-001)', () => {
  it('has a Run in flight at the first invocation, so the ordering below is observed', () => {
    expect(atFirstInvocation).toBeDefined();
    expect(atFirstInvocation?.status).toBe('running');
  });

  it('records no outputs while the backend is still being asked for them', () => {
    // The prompt named both targets (`inputs-reach-backend.test.ts`); this is the
    // other side of the same ordering. An implementation that probed first and
    // stated afterwards would fail here and nowhere else.
    expect(atFirstInvocation?.runOutputs).toBeUndefined();
  });

  it('records each declared output once the run completes', () => {
    expect(finished.runOutputs).toEqual([
      { name: 'report', status: 'resolved', reference: REPORT_TARGET },
      { name: 'summary', status: 'unresolved' }
    ]);
  });

  it('records an unresolved output with no location at all', async () => {
    // Nothing wrote `summary`, which is why it is unresolved. Asserted rather
    // than assumed: a fixture that accidentally created the file would turn this
    // into a test of the resolved branch under an unresolved name.
    await expect(fs.access(path.join(workspaceRoot, SUMMARY_TARGET))).rejects.toThrow();

    const summary = finished.runOutputs?.find((record) => record.name === 'summary');

    // Not `reference: undefined` — the key is absent, because an output that did
    // not resolve has no location to carry.
    expect(summary && 'reference' in summary).toBe(false);
  });

  it('never records an absolute path', () => {
    for (const record of finished.runOutputs ?? []) {
      if (record.reference === undefined) continue;
      expect(path.isAbsolute(record.reference)).toBe(false);
      expect(record.reference).not.toContain(workspaceRoot);
    }
  });

  it('probes the envelope, not a second read of the queue row', () => {
    const names = (finished.runOutputs ?? []).map((record) => record.name);

    expect(names).toEqual(['report', 'summary']);
    expect(names).not.toContain('decoy');
  });

  it('left the queue row genuinely disagreeing, so the test above bites', () => {
    // Guards the fixture itself. If the mid-flight rewrite silently did nothing
    // — wrong id, a copy rather than the live store, a row already gone — the
    // assertion above would pass against two agreeing sources and prove nothing.
    expect(queuedOutputsAfterRewrite?.map((output) => output.portId)).toEqual(['decoy']);
  });
});
