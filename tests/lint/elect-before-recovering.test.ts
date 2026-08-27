// FR-R3-070 (feature 152) — a window elects before it recovers.
//
// Activation used to perform recovery, then elect: the scheduled-start re-arm,
// the credit-watchdog reattach, and the delayed-retry resume all ran before
// `lock.tryAcquire()`, so a window that was about to lose the election could
// resume and drive a Run the primary already owned — two backend processes on
// one shared checkout. The fix is an ordering plus a set of gates, and both
// halves are shape rules on the source, because the failure needs two windows
// on one workspace and cannot be reproduced from inside a vitest worker.
//
// Four rules:
//
//   1. In `extension.ts`, the election (`lock.tryAcquire()`) textually precedes
//      every recovery entry point named in RECOVERY_LANDMARKS. A new recovery
//      installer must be added to that list to be reachable from activation at
//      all — an unlisted one fails rule 2's floor.
//   2. Each recovery landmark is gated: `lockResult.acquired` appears in the
//      code window immediately before it. (Comments are stripped first, so the
//      gate condition cannot be satisfied by prose.)
//   3. The watchdog's resume sweep — which fires long after activation — re-
//      checks primacy at fire time with the authoritative `hasPrimacy()`, not
//      the activation-era result, and does so before it claims elapsed retries.
//   4. Defence in depth exists beyond ordering: the controller's resume path
//      claims the per-queue execution lease before `markInFlight`, and the
//      scheduled-start coordinator's offline-elapsed branch consults the
//      foreign-lock probe the way `fire()` does.
//
// The pinned landmark list is deliberate: with it, adding a fourth recovery
// entry point without naming it here leaves it invisible to rule 1, and the
// count assertion below fails, forcing the author to decide how the new
// installer is gated.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

const EXTENSION = 'src/extension.ts';
const CONTROLLER = 'src/controller/workflow-controller.ts';
const COORDINATOR = 'src/services/scheduled-start-coordinator.ts';

/**
 * FR-R3-119 — the election moved, and rule 1's premise had to move with it.
 *
 * `lock.tryAcquire()` now runs inside `openWorkspaceSession()`
 * (`src/activation/workspace-session.ts`), so "the election textually precedes
 * every recovery landmark" is no longer a statement about one file. The PROPERTY
 * is unchanged — the session is awaited before any recovery installer runs — so
 * the check is split rather than dropped:
 *
 *   * the election lives in `workspace-session.ts` (asserted below, so it cannot
 *     quietly move somewhere unordered), and
 *   * the awaited call to it precedes every landmark in `extension.ts`.
 *
 * Weakening this to "the election exists somewhere" would have been the cheap
 * edit and would have retired the ordering guarantee the gate exists for.
 */
const ELECTION = 'const lockResult = await lock.tryAcquire()';
const SESSION = 'src/activation/workspace-session.ts';
const SESSION_CALL = 'await openWorkspaceSession(';

/**
 * Every recovery entry point reachable from activation stage 2. Adding a new
 * installer to `wireStage2` means adding it here and gating it, or rule 2's
 * per-landmark window check has nothing to hold it to.
 */
const RECOVERY_LANDMARKS = [
  'scheduledStartCoordinator.reArm()',
  'watchdog.reattachOnActivation()',
  'controller.resumeExistingFromActivation()'
] as const;

/** How far back a landmark's gate condition may sit, in stripped-source chars. */
const GATE_WINDOW = 400;

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/** Blank out comments, preserving offsets so windows still line up. */
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '//') {
      const newline = text.indexOf('\n', cursor);
      const stop = newline === -1 ? text.length : newline;
      blank(cursor, stop);
      cursor = stop;
    } else if (pair === '/*') {
      const close = text.indexOf('*/', cursor + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(cursor, stop);
      cursor = stop;
    } else {
      cursor += 1;
    }
  }
  return out.join('');
}

/**
 * The body of a method, from its signature to the next member at the same
 * indent. Crude on purpose, same as `ownership-registry-wiring.test.ts`: a
 * slice that ran long over-reports rather than under-reports.
 */
function methodBody(source: string, signature: string, file: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} must be present in ${file}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:public|private|protected|\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next);
}

const EXTENSION_SOURCE = stripComments(read(EXTENSION));
const CONTROLLER_SOURCE = stripComments(read(CONTROLLER));
const COORDINATOR_SOURCE = stripComments(read(COORDINATOR));

describe('FR-R3-070 — activation elects before it recovers', () => {
  it('finds the election and every pinned recovery landmark (non-vacuity)', () => {
    expect(
      read(SESSION).indexOf(ELECTION),
      `${SESSION} must elect via ${ELECTION}`
    ).toBeGreaterThanOrEqual(0);
    for (const landmark of RECOVERY_LANDMARKS) {
      expect(
        EXTENSION_SOURCE.indexOf(landmark),
        `${EXTENSION} must still contain recovery landmark ${landmark}; if it was ` +
          'renamed or removed, update RECOVERY_LANDMARKS so the ordering rule keeps holding it'
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('performs the election before every recovery entry point', () => {
    // The awaited session call stands for the election it contains.
    const election = EXTENSION_SOURCE.indexOf(SESSION_CALL);
    for (const landmark of RECOVERY_LANDMARKS) {
      const at = EXTENSION_SOURCE.indexOf(landmark);
      expect(
        at,
        `${landmark} must appear after the election; recovery before primacy is the ` +
          'two-spawn defect FR-R3-070 removed'
      ).toBeGreaterThan(election);
    }
  });

  it('gates each recovery landmark on the election result', () => {
    for (const landmark of RECOVERY_LANDMARKS) {
      const at = EXTENSION_SOURCE.indexOf(landmark);
      const window = EXTENSION_SOURCE.slice(Math.max(0, at - GATE_WINDOW), at);
      expect(
        window.includes('lockResult.acquired'),
        `${landmark} must sit behind an if (lockResult.acquired) gate within ` +
          `${GATE_WINDOW} chars; an ungated installer runs in a non-primary window`
      ).toBe(true);
    }
  });

  it('re-checks primacy at fire time inside the watchdog resume sweep', () => {
    // FR-R3-119 — the resume sweep moved with the watchdog into
    // `src/activation/scheduled-work-wiring.ts`. The ORDER this asserts is the
    // whole rule and is unchanged: the sweep fires long after activation, so it
    // must re-read `hasPrimacy()` before claiming anything, rather than trusting
    // the activation-era `lockResult`. Only the file holding the sweep differs.
    const SWEEP = 'src/activation/scheduled-work-wiring.ts';
    const sweepSource = read(SWEEP);
    const primacy = sweepSource.indexOf('await lock.hasPrimacy()');
    const claim = sweepSource.indexOf('controller.claimElapsedDelayedRetries()');
    expect(primacy, `${SWEEP} must re-check hasPrimacy() in the resume sweep`).toBeGreaterThanOrEqual(0);
    expect(claim, `${SWEEP} must still claim elapsed retries in the sweep`).toBeGreaterThanOrEqual(0);
    expect(
      primacy,
      'the sweep must check primacy before claiming elapsed retries — the sweep fires ' +
        'long after activation, so the activation-era lockResult cannot answer for it'
    ).toBeLessThan(claim);
  });

  it('claims the per-queue execution lease on the resume path, before markInFlight', () => {
    const body = methodBody(
      CONTROLLER_SOURCE,
      'private async resumeExistingOnQueue(',
      CONTROLLER
    );
    const claim = body.indexOf('this.executionLease.tryAcquire(queueId)');
    const inFlight = body.indexOf('markInFlight');
    expect(claim, `${CONTROLLER} resume path must claim the execution lease`).toBeGreaterThanOrEqual(0);
    expect(inFlight, `${CONTROLLER} resume path must still markInFlight`).toBeGreaterThanOrEqual(0);
    expect(
      claim,
      'the lease claim must precede markInFlight so ordering is defence in depth, ' +
        'not the only defence'
    ).toBeLessThan(inFlight);
  });

  it('consults the foreign-lock probe in the offline-elapsed re-arm branch', () => {
    const body = methodBody(COORDINATOR_SOURCE, 'public async reArm()', COORDINATOR);
    expect(
      body.includes('isForeignLockHeldFn?.()'),
      `${COORDINATOR} reArm()'s offline-elapsed branch must consult the foreign-lock ` +
        "probe the way fire() does; without it a restart promotes under a competing window"
    ).toBe(true);
  });
});
