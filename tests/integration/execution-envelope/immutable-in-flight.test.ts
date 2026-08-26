// FR-R3-001 (T272) — the accepted request stays the executed request for the
// whole run, not just its first phase.
//
// The freeze is only worth anything if it survives the sources it was taken
// from changing underneath it, so this fixture changes both of them while the
// run is genuinely mid-flight — between phase one and phase two — and then asks
// what phase two executed:
//
//   * the **live catalog**, edited to drop `review` from the pipeline and to
//     give the `review` phase a different instruction; and
//   * the **queued row's plan**, rewritten to name different inputs,
//     supplemental context, outputs and instructions.
//
// A run that re-resolved anything — the phase sequence, the phase definition,
// the request — would visibly change course here. Nothing about this is
// enforced by `readonly`, which is erased before any of it runs; it holds
// because the pipeline snapshot and the envelope are read from the Run, and the
// Run is not what was edited.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PhaseDef, PipelineDef } from '../../../src/config/pipeline-config';
import type { ExecutionEnvelope } from '../../../src/contracts/run-request';
import type { InvocationRequest } from '../../../src/runner/invocation-result';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  BRIEF,
  ENVELOPE_FLOW,
  INSTRUCTIONS,
  REPORT_TARGET,
  driveEnvelopeRun,
  rewriteQueuedPlan,
  type MidFlightContext
} from './envelope-harness';
import { removeTempRoot } from '../../temp-root-cleanup';

const MUTATED_INSTRUCTION = 'MUTATED: do something else entirely.';
const DECOY_BRIEF = 'DECOY: summarise nothing.';
const DECOY_TARGET = 'out/decoy.md';

/** The pipeline as an in-flight edit would leave it: `review` gone, ports gone. */
const TRUNCATED: PipelineDef = {
  ...ENVELOPE_FLOW,
  phases: ['compose', 'done'],
  inputs: [],
  outputs: []
};

const MUTATED_REVIEW: PhaseDef = {
  id: 'review',
  name: 'Review',
  version: 2,
  instruction: MUTATED_INSTRUCTION,
};

function editCatalog(context: MidFlightContext): void {
  // Only the two lookup Maps, because they are the only part of a catalog that
  // *can* be edited: `buildCatalog` freezes the object and both arrays, so
  // reassigning `pipelines` throws rather than lands. The Maps are not frozen —
  // freezing an object does not freeze a Map it holds — and they are what a
  // resolver reaches for by id, so they are exactly the surface a mid-run
  // re-resolution would read.
  const catalog = context.catalog as unknown as {
    phasesById: Map<string, PhaseDef>;
    pipelinesById: Map<string, PipelineDef>;
  };

  catalog.pipelinesById.set(ENVELOPE_FLOW.id, TRUNCATED);
  catalog.phasesById.set('review', MUTATED_REVIEW);
}

let workspaceRoot: string;
let invocations: readonly InvocationRequest[];
let accepted: ExecutionEnvelope;
let finished: WorkflowRun;
let queuedBriefAfterRewrite: string | undefined;

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-envelope-frozen-'));

  const harness = await driveEnvelopeRun(workspaceRoot, {
    existingOutputs: [REPORT_TARGET, DECOY_TARGET],
    beforeInvocation: async (index, context) => {
      // Index 0 is *during* the first invocation: its request is already built,
      // so every edit here lands strictly between phase one and phase two.
      if (index !== 0) return;
      editCatalog(context);
      await rewriteQueuedPlan(context, (plan) => ({
        ...plan,
        inputs: [{ portId: 'brief', type: 'text', value: DECOY_BRIEF }],
        supplemental: [],
        outputs: [
          { portId: 'decoy', type: 'markdown', target: DECOY_TARGET, overwriteConfirmed: false }
        ],
        instructions: MUTATED_INSTRUCTION
      }));
      queuedBriefAfterRewrite = context.store
        .getQueue(DEFAULT_QUEUE_ID)
        .requests.find((request) => request.id === context.featureId)
        ?.runPlan?.inputs[0]?.value;
    }
  });

  invocations = harness.invocations;
  accepted = harness.envelope;
  finished = harness.finishedRun();
}, 30_000);

afterAll(async () => {
  await removeTempRoot(workspaceRoot);
});

function envelopeTail(prompt: string): string {
  const start = prompt.indexOf('REQUEST INPUTS:');
  expect(start).toBeGreaterThan(-1);
  return prompt.slice(start);
}

describe('the envelope is immutable in flight (FR-R3-001)', () => {
  it('made both edits for real, so nothing below passes by accident', () => {
    // Two fixture guards. An edit that silently missed — wrong id, a copy rather
    // than the live object, a row already gone — would leave every assertion
    // below comparing a value against its unchanged self.
    expect(queuedBriefAfterRewrite).toBe(DECOY_BRIEF);
    expect(invocations.length).toBeGreaterThan(1);
  });

  it('runs the phase sequence the snapshot froze, not the edited catalog', () => {
    // The edit removed `review` from the pipeline. It ran anyway, because the
    // sequence is `run.pipeline`'s and `run.pipeline` was frozen at acceptance.
    expect(invocations.map((request) => request.phase)).toEqual(['compose', 'review']);
    expect(finished.pipeline?.phases.map((phase) => phase.id)).toEqual([
      'compose',
      'review',
      'done'
    ]);
  });

  it('executes the phase definition the snapshot froze, not the edited one', () => {
    const second = invocations[1]!.prompt;

    expect(second).toContain('Review the report.');
    expect(second).not.toContain(MUTATED_INSTRUCTION);
  });

  it('sends the accepted request into the later phase, not the rewritten row', () => {
    const second = invocations[1]!.prompt;

    expect(second).toContain(BRIEF);
    expect(second).toContain(INSTRUCTIONS);
    expect(second).not.toContain(DECOY_BRIEF);
    expect(second).not.toContain(DECOY_TARGET);
  });

  it('derives byte-identical request sections before and after the edits', () => {
    expect(envelopeTail(invocations[1]!.prompt)).toBe(envelopeTail(invocations[0]!.prompt));
  });

  it('leaves the persisted envelope equal to what the validator accepted', () => {
    expect(finished.envelope).toEqual(accepted);
  });

  it('judges the run on the outputs it accepted, after the row said otherwise', () => {
    // `decoy` exists on disk, so a completion that re-read the row would record
    // it as resolved rather than recording the two declared targets.
    expect((finished.runOutputs ?? []).map((record) => record.name)).toEqual([
      'report',
      'summary'
    ]);
  });
});
