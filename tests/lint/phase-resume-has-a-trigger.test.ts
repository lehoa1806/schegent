// Lifecycle round-check of 2026-08-30 (T1614) — finding A's shape, one level down.
//
// T1614 asked for a dedicated pass over phase-level lifecycle: breakpoints,
// phase overrides, and the phase status vocabulary. The pass found no defect.
// This gate is what that result is worth keeping as, because the property it
// found holding is the exact property finding A found broken at the queue level:
//
//   a control that puts work back into motion must also arm the thing that
//   moves it.
//
// WHY IT COULD REGRESS THE SAME WAY. `PhaseControlService` writes
// `status: 'running'` and returns. Nothing polls a Run back to life; the Run is
// driven because some call site asked — `scheduleResume`, `cancelActive` (which
// makes the drive loop take its next decision), or a nested `resumeActivePhase`.
// A method that writes the status and arms nothing leaves a Run that reads as
// running to every projection and to the operator, and never executes another
// Phase. That is finding A with `pending` swapped for `running`, and it would
// present the same way: no Run, no log, and no refusal to explain it.
//
// WHAT THE PASS ACTUALLY VERIFIED, recorded here because a gate cannot:
//
//   * The breakpoint round trip is closed. `setPhaseBreakpoint` refuses the
//     in-flight phase, so a breakpoint always marks a future one; the runner
//     returns `paused-at-breakpoint`; `run-driver.ts` pauses with
//     `manualPauseCause: 'breakpoint-paused'` and filters the fired entry out of
//     `phaseBreakpoints` (consumed-by-fire), so `resumeActivePhase` cannot
//     re-halt on the operator's own breakpoint.
//   * `resumeTargetPhaseId` is paired with `manualPauseCause` at every writer,
//     and `workspace-state.ts` enforces the iff on every write, so the
//     `breakpoint-fired` badge cannot outlive the pause it describes.
//   * Overriding a phase clears any breakpoint on it and audits the clear as
//     `cause: 'override-applied'`, so an override cannot strand an entry on a
//     phase that will never run.
//
// TWO DIRECTIONS, for the reason T1611's table has two: deriving either side
// from the other would make every assertion `X === X`.
//
//   1. Every method classified below arms a trigger. Catches a trigger deleted
//      in a refactor.
//   2. Every method that writes `status: 'running'` is classified. Catches the
//      failure that actually happened one level up — a *new* writer added with
//      no trigger, which direction (1) cannot see because an unlisted method is
//      absent from both sides at once.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PHASE_CONTROL = resolve(REPO_ROOT, 'src', 'controller', 'phase-control-service.ts');

/** The literal that puts a Run back into motion. */
const RUNNING_WRITE = "status: 'running'";

/**
 * The calls that constitute arming. All three hand the Run to something that
 * will drive it; none of them is a state write.
 *
 * `cancelActive` is here because aborting the in-flight phase is how a running
 * Run is made to take its next decision — `skipPhase` uses it rather than a
 * resume, since there is already a drive loop to return to. Reading it as "not
 * a trigger" would flag the one branch that is correct by construction.
 *
 * ALL THREE ARE CALL-FORM (`this.`), and the first probe of this gate is why.
 * Written as the bare names, `resumeActivePhase(` matched the text of its own
 * `public async resumeActivePhase(` declaration — which every body slice opens
 * with — so that method satisfied the trigger check no matter what its body did.
 * Deleting its `scheduleResume` call left the gate green. A pattern that matches
 * the declaration it is scanning inside cannot fail, which is the same
 * self-satisfying anchor `connected-workflow.test.ts` records about its own
 * source slice.
 */
const TRIGGERS = [
  'this.scheduleResume(',
  'this.deps.cancelActive(',
  'this.resumeActivePhase('
] as const;

interface ResumeWriter {
  /** Method name on `PhaseControlService`. */
  readonly method: string;
  readonly reason: string;
}

const RESUME_WRITERS: readonly ResumeWriter[] = [
  {
    method: 'resumeActivePhase',
    reason:
      'The continue for every pause cause, breakpoint-fired included. Clears the pause ' +
      'fields, cascades the queue resume, then arms `scheduleResume` — the one call that ' +
      'makes the cleared pause mean anything.'
  },
  {
    method: 'restartActivePhase',
    reason:
      'Re-runs the current phase from iteration 1. Arms `scheduleResume` only when ' +
      '`isDriving(queueId)` is false: a Run already being driven would otherwise get a ' +
      'second driver, and the guard is what keeps one Run to one drive loop.'
  },
  {
    method: 'skipPhase',
    reason:
      'The only control that must arm for four different run statuses, and it covers all ' +
      'four: running aborts the active phase so the loop takes its next decision, paused ' +
      'delegates to `resumeActivePhase`, and both failed branches clear the retry state ' +
      'and arm `scheduleResume`. A branch added here without a trigger is the regression ' +
      'this gate exists for.'
  }
];

const MIN_REASON_LENGTH = 40;

/**
 * Method bodies keyed by name, sliced from one member declaration to the next.
 *
 * Sliced to the next member rather than by brace matching for the reason
 * `connected-workflow.test.ts` records about its own source slice: an anchor
 * that over-reaches makes the check more permissive, and here it would let a
 * trigger in the *following* method satisfy this one. So the terminator is the
 * next `public`/`private` member at class indentation, which is unambiguous in
 * this file, and the classification direction below catches anything the slice
 * would have to miss.
 */
function methodBodies(source: string): ReadonlyMap<string, string> {
  const declaration = /^ {2}(?:public|private)(?: async)? (\w+)\(/gm;
  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(declaration)) {
    starts.push({ name: match[1]!, index: match.index! });
  }
  const bodies = new Map<string, string>();
  starts.forEach((start, position) => {
    const end = starts[position + 1]?.index ?? source.length;
    bodies.set(start.name, source.slice(start.index, end));
  });
  return bodies;
}

describe('a phase control that resumes a Run must arm a trigger (T1614)', () => {
  const source = readFileSync(PHASE_CONTROL, 'utf8');
  const bodies = methodBodies(source);
  const writers = [...bodies.entries()]
    .filter(([, body]) => body.includes(RUNNING_WRITE))
    .map(([method]) => method)
    .sort();

  it('finds the running-write literal in source (the scan is not broken)', () => {
    // Without this, a renamed literal or a changed method signature would empty
    // both directions at once and report a clean gate over a file it never read.
    expect(
      bodies.size,
      'no methods were parsed out of phase-control-service.ts — the declaration pattern no ' +
        'longer matches how this class declares members, so every check below is comparing ' +
        'nothing to nothing'
    ).toBeGreaterThan(5);
    expect(writers.length).toBeGreaterThan(0);
  });

  it('classifies every method that writes a Run back to running', () => {
    const classified = new Set(RESUME_WRITERS.map((w) => w.method));
    const unclassified = writers.filter((method) => !classified.has(method));
    expect(
      unclassified,
      `These methods write \`${RUNNING_WRITE}\` and are not classified in RESUME_WRITERS. ` +
        `A Run put back into motion with nothing to move it reads as running to every ` +
        `projection and never executes another Phase — finding A with 'pending' swapped ` +
        `for 'running'. Add the method with the reason its trigger is where it is, and ` +
        `arm one of ${TRIGGERS.join(', ')}:\n${unclassified.join('\n')}`
    ).toEqual([]);
  });

  it('classifies nothing that no longer resumes a Run', () => {
    // The mirror direction: a method that stopped writing the transition has to
    // leave this table deliberately, rather than sit here making it look covered.
    const writerSet = new Set(writers);
    const stale = RESUME_WRITERS.map((w) => w.method).filter((method) => !writerSet.has(method));
    expect(stale).toEqual([]);
  });

  it('arms a trigger in every classified method', () => {
    const missing: string[] = [];
    for (const writer of RESUME_WRITERS) {
      const body = bodies.get(writer.method);
      if (body === undefined) {
        missing.push(`${writer.method} — no such method on PhaseControlService`);
        continue;
      }
      if (!TRIGGERS.some((trigger) => body.includes(trigger))) {
        missing.push(`${writer.method} — writes ${RUNNING_WRITE} and arms none of ${TRIGGERS.join(', ')}`);
      }
    }
    expect(
      missing,
      `A phase control that resumes a Run must hand it to something that drives it. ` +
        `Nothing polls a paused Run back to life:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('records a substantive reason for every classification', () => {
    expect(RESUME_WRITERS.length).toBeGreaterThan(0);
    for (const writer of RESUME_WRITERS) {
      expect(
        writer.reason.trim().length,
        `${writer.method} needs a reason saying which trigger it arms and why that one`
      ).toBeGreaterThan(MIN_REASON_LENGTH);
    }
  });
});
