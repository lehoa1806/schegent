// FR-R3-001 / CTO-003 — the envelope is the *whole* runtime contract, and it
// survives a reload.
//
// The four fixtures beside this one answer "does the request reach the
// backend". CTO-003 asks two further things of the same envelope, and neither
// is visible from those:
//
//   * **Every element of the runtime contract is in it.** The directive lists
//     pipeline snapshot, inputs, supplemental context, prior-output references,
//     output targets, *model/runner policy*, *mutation plan*, and *approval
//     receipt*. The first five are the sections the other fixtures assert. The
//     last three are the ones a reader would assume live somewhere else,
//     because they are reached through `WorkflowRun` rather than through a
//     prompt section — so this fixture pins where they actually come from.
//
//   * **It is stable across reload.** The envelope is persisted in
//     `workspaceState`, which is JSON. A member that does not survive
//     `JSON.stringify` — a `Map`, a `Date`, a key holding `undefined`, a
//     function — is not a compile error and not a test failure anywhere else:
//     it is a run that executes one contract before a window reload and a
//     quietly smaller one afterwards. That is the same silent-loss shape as the
//     defect this feature closed, displaced in time.
//
// The runner-policy claim is the load-bearing one and is easy to misread, so:
// the policy is not a *field beside* the envelope, it is *inside* it.
// `snapshotPhaseDef()` resolves each phase's effective `runner`, `sideEffects`,
// `evidencePolicy` and `promptVersion` at validation and freezes them into
// `envelope.pipeline.phases`. Nothing downstream re-resolves them. The mutation
// plan is then a pure projection of that frozen array, and the approval receipt
// is an approval *of that projection's fingerprint* — which is why the receipt
// is minted later than the envelope and still cannot drift from it.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { buildMutationPlan, mutationPlanIsApproved } from '../../../src/services/mutation-plan';
import type { ExecutionEnvelope } from '../../../src/contracts/run-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { driveEnvelopeRun, type EnvelopeHarness } from './envelope-harness';
import { removeTempRoot } from '../../temp-root-cleanup';

let workspaceRoot: string;
let harness: EnvelopeHarness;
let finished: WorkflowRun;

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-envelope-contract-'));
  harness = await driveEnvelopeRun(workspaceRoot);
  finished = harness.finishedRun();
}, 30_000);

afterAll(async () => {
  await removeTempRoot(workspaceRoot);
});

/** The envelope-derived tail of a prompt, from the first section header on. */
function envelopeTail(envelope: ExecutionEnvelope): string {
  const prompt = new PromptBuilder().build({
    phase: 'compose',
    iteration: 1,
    iterationCap: 5,
    featureDescription: 'irrelevant to the tail',
    featureDir: 'specs/000-fixed',
    envelope
  });
  const start = prompt.indexOf('REQUEST INPUTS:');
  expect(start, 'the prompt carries no envelope sections at all').toBeGreaterThan(-1);
  return prompt.slice(start);
}

/** What `workspaceState` does to a Run between one window and the next. */
function throughPersistence<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the envelope carries the runner policy, not a later resolution (CTO-003)', () => {
  it('froze an effective runner onto every executable phase', () => {
    const phases = harness.envelope.pipeline.phases;

    expect(phases.length).toBeGreaterThan(0);
    for (const phase of phases) {
      expect(phase.runner, `phase ${phase.id} has no pinned runner`).toBeDefined();
    }
  });

  it('froze the side-effect and evidence policy that gates execution', () => {
    // `run-driver.ts` refuses a git-capable phase whose id is not in the
    // approved plan. It reads `sideEffects` off this frozen array, so an
    // unresolved value here is a gate deciding on a default rather than on what
    // the operator approved.
    for (const phase of harness.envelope.pipeline.phases) {
      expect(phase.sideEffects, `phase ${phase.id} has no pinned sideEffects`).toBeDefined();
      expect(phase.evidencePolicy, `phase ${phase.id} has no evidence policy`).toBeDefined();
      expect(phase.promptVersion, `phase ${phase.id} has no prompt version`).toBeDefined();
    }
  });

  it('executes the envelope’s snapshot rather than a second copy of it', () => {
    // Asserted defined first: `toBe` on two `undefined`s passes, and this is a
    // test whose whole content is a comparison.
    expect(finished.pipeline).toBeDefined();
    expect(finished.envelope?.pipeline).toBeDefined();
    // Identity, not equality: two structurally equal snapshots is exactly the
    // state in which one of them can later be retargeted and the other not.
    expect(finished.pipeline).toBe(finished.envelope?.pipeline);
  });
});

describe('the mutation plan is a projection of the envelope (CTO-003)', () => {
  it('derives byte-for-byte from the envelope’s frozen phases', () => {
    const plan = finished.mutationPlan;
    expect(plan, 'the run recorded no mutation plan').toBeDefined();

    // `capturedAt` is the only non-derived member, so it is supplied rather
    // than compared — everything else must fall out of the envelope alone.
    expect(plan).toEqual(
      buildMutationPlan(harness.envelope.pipeline, plan?.capturedAt)
    );
  });

  it('names only phases the envelope itself marks git-capable', () => {
    const capable = harness.envelope.pipeline.phases
      .filter((phase) => phase.sideEffects === 'git' || phase.sideEffects === 'unrestricted')
      .map((phase) => phase.id);

    expect(finished.mutationPlan?.gitCapablePhaseIds).toEqual(capable);
  });

  it('tracks the envelope’s content rather than always naming none', () => {
    // The fixture's phases are all `workspace`, so the assertion above compares
    // two empty arrays and would survive a projection that returned `[]`
    // unconditionally. Re-project the same phases with one marked git-capable:
    // the plan must follow the envelope, and its fingerprint must move with it.
    const phases = harness.envelope.pipeline.phases;
    const gitCapable = {
      ...harness.envelope.pipeline,
      phases: phases.map((phase, index) =>
        index === 0 ? { ...phase, sideEffects: 'git' as const } : phase
      )
    };

    const projected = buildMutationPlan(gitCapable, 1);

    expect(projected.gitCapablePhaseIds).toEqual([phases[0]?.id]);
    expect(projected.fingerprint).not.toBe(
      buildMutationPlan(harness.envelope.pipeline, 1).fingerprint
    );
  });

  it('binds any approval receipt to that same projection', () => {
    // This fixture's phases are not git-capable, so no receipt is owed and none
    // is written. The relation is asserted rather than the presence: a receipt
    // that exists must match, and one that does not must not have been needed.
    const { mutationPlan, gitApprovalReceipt } = finished;

    if (gitApprovalReceipt) {
      expect(mutationPlanIsApproved(mutationPlan!, gitApprovalReceipt)).toBe(true);
    } else {
      expect(mutationPlan?.gitCapablePhaseIds).toEqual([]);
    }
  });
});

describe('the envelope is stable across a reload (CTO-003)', () => {
  it('survives persistence with every section intact', () => {
    // The assertion is on the *rendered* tail rather than on the object,
    // because that is the thing the backend receives. A member that vanished in
    // serialization shows up here as a missing section, not as a type error.
    const reloaded = throughPersistence(harness.envelope);

    expect(envelopeTail(reloaded)).toBe(envelopeTail(harness.envelope));
  });

  it('survives persistence as part of the Run record', () => {
    const reloaded = throughPersistence(finished);

    expect(reloaded.envelope).toBeDefined();
    expect(envelopeTail(reloaded.envelope!)).toBe(envelopeTail(harness.envelope));
  });

  it('keeps the frozen pipeline reachable through the reloaded envelope', () => {
    // Identity is necessarily lost across serialization; what must not be lost
    // is that the Run and its envelope still describe the same pipeline.
    const reloaded = throughPersistence(finished);

    expect(reloaded.envelope?.pipeline).toEqual(reloaded.pipeline);
  });

  it('adds no key and drops none in the round trip', () => {
    // A key holding `undefined` is dropped by `JSON.stringify`, so a shape that
    // depends on one is a shape that changes at the first reload.
    const before = Object.keys(harness.envelope).sort();
    const after = Object.keys(throughPersistence(harness.envelope)).sort();

    expect(after).toEqual(before);
  });

  it('re-derives the same mutation plan from the reloaded envelope', () => {
    // The approval an operator gave is a fingerprint over the frozen phases. If
    // serialization perturbed any member the fingerprint would move, and a
    // resumed run would ask for approval again — or, worse, match a plan the
    // operator did not approve.
    const reloaded = throughPersistence(harness.envelope);

    expect(buildMutationPlan(reloaded.pipeline, 1).fingerprint).toBe(
      buildMutationPlan(harness.envelope.pipeline, 1).fingerprint
    );
  });
});
