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
//   1. In `stage2-producers.ts`, the election (`lock.tryAcquire()`) textually
//      precedes every recovery entry point named in RECOVERY_LANDMARKS.
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
// FR-R3-136 — TWO CORRECTIONS TO THIS FILE, both found while moving the election
// behind Workspace Trust.
//
// First, the paragraph that used to stand here claimed "adding a fourth recovery
// entry point without naming it here ... the count assertion below fails". There
// was no count assertion, and there WAS an unlisted fourth landmark:
// `resumePersistedRuns`, gated on `lockResult.acquired` and never held to rule 1
// or rule 2. A gate that describes a check it does not perform is worse than one
// that admits the gap, because the description is what the next author reads. Both
// are fixed: the landmark is listed, and `GATE_COUNT` is the assertion — every
// `lockResult.acquired` gate in the module must belong to a listed landmark, so a
// fifth installer cannot arrive unlisted.
//
// Second, the chain now has a link above the election. `stage2-producers.ts` reads
// Workspace Trust and returns before electing, because `store.ownership.acquire`
// is an exclusive-create under `.schegent/` and an untrusted window must not
// perform it. The ordered claim is therefore "trust, then elect, then recover",
// and it is asserted whole here rather than split, because it is one chain in one
// file. What FR-R3-136 gates separately is a different question — whether any
// producer act exists OUTSIDE this module — and that belongs with the requirement
// that introduced it, not here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CONTROLLER = 'src/controller/workflow-controller.ts';
const COORDINATOR = 'src/services/scheduled-start-coordinator.ts';

/**
 * FR-R3-136 — the election moved again, and rule 1 got its single file back.
 *
 * FR-R3-119 had split this check in two: the election lived in
 * `openWorkspaceSession()` and the landmarks in `extension.ts`, so "the election
 * precedes every landmark" had to be argued through an awaited call standing in
 * for the election it contained. The election and all four landmarks are now in
 * `stage2-producers.ts`, so the ordering is once more a direct statement about one
 * file — a stronger check than the one it replaces, not a weaker one.
 *
 * The reason they moved is trust, not tidiness: `tryAcquire()` writes a
 * generation-numbered file under `.schegent/`, and every landmark is already gated
 * on its result, so putting the election behind the trust check suppresses all four
 * by construction. A landmark left behind in the composition root would have been
 * gated only by primacy, and the primacy-implies-trust coupling would have been
 * invisible. `TRUST_CHECK` below is what keeps that from silently regressing.
 */
const PRODUCERS = 'src/activation/stage2-producers.ts';
const ELECTION = 'const lockResult = await lock.tryAcquire()';
const TRUST_CHECK = 'if (!isWorkspaceTrusted())';

/**
 * Every recovery entry point reachable from activation stage 2. Adding a new
 * installer means adding it here and gating it, or rule 2's per-landmark window
 * check has nothing to hold it to — and `GATE_COUNT` fails until it is listed.
 */
const RECOVERY_LANDMARKS = [
  'scheduledStartCoordinator.reArm()',
  'watchdog.reattachOnActivation()',
  'controller.resumeExistingFromActivation()',
  // FR-R3-136 — the fourth, present and gated since feature 093 but unlisted
  // until now, which is what made the missing count assertion consequential
  // rather than merely untidy.
  'resumePersistedRuns({'
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

const PRODUCERS_SOURCE = stripComments(read(PRODUCERS));
const CONTROLLER_SOURCE = stripComments(read(CONTROLLER));
const COORDINATOR_SOURCE = stripComments(read(COORDINATOR));

describe('FR-R3-070 — activation elects before it recovers', () => {
  it('finds the election and every pinned recovery landmark (non-vacuity)', () => {
    expect(
      PRODUCERS_SOURCE.indexOf(ELECTION),
      `${PRODUCERS} must elect via ${ELECTION}`
    ).toBeGreaterThanOrEqual(0);
    for (const landmark of RECOVERY_LANDMARKS) {
      expect(
        PRODUCERS_SOURCE.indexOf(landmark),
        `${PRODUCERS} must still contain recovery landmark ${landmark}; if it was ` +
          'renamed or removed, update RECOVERY_LANDMARKS so the ordering rule keeps holding it'
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('performs the election before every recovery entry point', () => {
    const election = PRODUCERS_SOURCE.indexOf(ELECTION);
    for (const landmark of RECOVERY_LANDMARKS) {
      const at = PRODUCERS_SOURCE.indexOf(landmark);
      expect(
        at,
        `${landmark} must appear after the election; recovery before primacy is the ` +
          'two-spawn defect FR-R3-070 removed'
      ).toBeGreaterThan(election);
    }
  });

  it('gates each recovery landmark on the election result', () => {
    for (const landmark of RECOVERY_LANDMARKS) {
      const at = PRODUCERS_SOURCE.indexOf(landmark);
      const window = PRODUCERS_SOURCE.slice(Math.max(0, at - GATE_WINDOW), at);
      expect(
        window.includes('lockResult.acquired'),
        `${landmark} must sit behind an if (lockResult.acquired) gate within ` +
          `${GATE_WINDOW} chars; an ungated installer runs in a non-primary window`
      ).toBe(true);
    }
  });

  // FR-R3-136 — THE COUNT ASSERTION the header used to promise and not perform.
  //
  // The three checks above are per-landmark: they hold each listed installer to
  // the ordering and the gate. None of them can see an installer that was never
  // listed, which is exactly how `resumePersistedRuns` sat gated-but-unwatched
  // through two features. This one closes that from the other direction — it
  // counts the gates rather than the landmarks, so an unlisted installer shows up
  // as a gate with no owner and fails here.
  //
  // It is a `toBe`, not a `>=`: an installer REMOVED without being delisted also
  // has to be noticed, or the list decays into a description of the past.
  it('has exactly one election gate per pinned landmark, and no unlisted installer', () => {
    const gates = PRODUCERS_SOURCE.match(/if \(lockResult\.acquired\)/g) ?? [];
    expect(
      gates.length,
      `${PRODUCERS} has ${gates.length} if (lockResult.acquired) gates against ` +
        `${RECOVERY_LANDMARKS.length} pinned landmarks. A gate with no landmark is a ` +
        'recovery installer this file does not hold to rule 1 or rule 2 — add it to ' +
        'RECOVERY_LANDMARKS. A landmark with no gate means one was removed; delist it.'
    ).toBe(RECOVERY_LANDMARKS.length);
  });

  // FR-R3-136 — the link above the election. Ordering is the whole content of
  // this gate, and trust is now the first step of the order.
  it('reads Workspace Trust before it elects', () => {
    const trust = PRODUCERS_SOURCE.indexOf(TRUST_CHECK);
    const election = PRODUCERS_SOURCE.indexOf(ELECTION);
    expect(
      trust,
      `${PRODUCERS} must refuse to produce in an untrusted workspace via ${TRUST_CHECK}`
    ).toBeGreaterThanOrEqual(0);
    expect(
      trust,
      'the trust check must precede the election: acquiring ownership writes a ' +
        'generation-numbered file under .schegent/, which is the workspace write ' +
        'trust is being withheld over'
    ).toBeLessThan(election);
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
