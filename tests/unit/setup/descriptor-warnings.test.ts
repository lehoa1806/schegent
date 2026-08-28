import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  descriptorWarnings,
  expectNoDescriptorWarnings,
  matchesDescriptorWarning,
  resetDescriptorWarnings
} from '../../setup/descriptor-warnings';

/**
 * FR-R3-137 (T1531d, FR-014, C4 level 1) — the synthetic control for the
 * descriptor-leak detector.
 *
 * A detector that never fires is indistinguishable from a clean tree, and every
 * opt-in file added by T1531c asserts the ABSENCE of something. This file emits
 * the warning on purpose and watches the detector notice, so the twelve files
 * asserting zero are asserting against an instrument that is known to move.
 *
 * LEVEL 1, and the level matters. C4 splits the control in two: the handler's
 * match and its failure path are asserted here with `process.emitWarning`, which
 * depends on nothing but Node's event emitter; the claim that a real collected
 * `FileHandle` produces text this predicate matches needs an actual collection
 * and lives in `descriptor-leak-control.test.ts`. Merging the two would make the
 * cheap, deterministic half hostage to `--expose-gc` and GC timing.
 *
 * THIS FILE PRINTS DESCRIPTOR WARNINGS TO STDERR. They are Node's own text,
 * emitted deliberately, and they are the exact lines FR-R3-137 exists to remove
 * from the run's output — so a reader scanning stderr will find them here and
 * should not go looking for a leak. Nothing else in the suite emits them; that
 * is what T1531c established.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

/** Node's plain warning, verbatim, as an un-coded `Warning`. */
const PLAIN = 'Closing file descriptor 11 on garbage collection';
/** The deprecation that follows it, verbatim, carrying the code. */
const DEPRECATION =
  'Closing a FileHandle object on garbage collection is deprecated. ' +
  'Please close FileHandle objects explicitly using FileHandle.prototype.close().';

/**
 * `process.emitWarning` defers by one `process.nextTick`, so the listener has not
 * run yet when it returns. Two turns, no polling and no elapsed-time bound: this
 * is a fixed amount of yielding, not a wait that can give up early.
 */
async function flushWarnings(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  resetDescriptorWarnings();
});

afterAll(() => {
  // The reset is load-bearing, not tidiness: the listener and its buffer are one
  // per worker, so a warning this file emitted and left behind would surface as
  // a failure in whichever opt-in file the worker runs next. This is also the one
  // file that cannot call `expectNoDescriptorWarnings()` on itself — it emits on
  // purpose, so the assertion would either fail or be run after a reset that
  // makes it vacuous.
  resetDescriptorWarnings();
});

describe('FR-R3-137 — the detector fires (T1531d, FR-014, C4 level 1)', () => {
  it('captures both warnings Node emits for a collected FileHandle', async () => {
    // Both arms of the predicate, because Node uses both: the first line arrives
    // as an un-named `Warning` with no code and is caught by the message match;
    // the second carries `DEP0137` and is caught by the code.
    process.emitWarning(PLAIN);
    process.emitWarning(DEPRECATION, { type: 'DeprecationWarning', code: 'DEP0137' });
    await flushWarnings();

    const seen = descriptorWarnings();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('Closing file descriptor 11');
    expect(seen[1]).toContain('DeprecationWarning');
    expect(seen[1]).toContain('Closing a FileHandle object');
  });

  it('matches the message even when the code is absent', () => {
    // The code arm alone is not enough. Node emits the plain line once per
    // descriptor and the deprecation only ONCE per process, so on a run that
    // leaks fifteen handles fourteen of them are visible only through the text.
    expect(matchesDescriptorWarning(`Warning: ${PLAIN}`)).toBe(true);
    expect(matchesDescriptorWarning(`DeprecationWarning: ${DEPRECATION}`)).toBe(true);
  });

  it('ignores warnings that are not about descriptors', async () => {
    process.emitWarning('possible EventEmitter memory leak detected', {
      type: 'MaxListenersExceededWarning'
    });
    await flushWarnings();

    // A detector that fired on any warning would be a detector every file has to
    // opt out of, which is the opposite of what T1531b built.
    expect(descriptorWarnings()).toHaveLength(0);
    expect(() => expectNoDescriptorWarnings()).not.toThrow();
  });

  it('fails the calling file, naming what Node closed', async () => {
    process.emitWarning(PLAIN);
    await flushWarnings();

    expect(() => expectNoDescriptorWarnings()).toThrow(/GC is not a lifecycle/);
  });

  it('clears itself when it throws, so one leaking file does not fail the next', async () => {
    process.emitWarning(PLAIN);
    await flushWarnings();

    expect(() => expectNoDescriptorWarnings()).toThrow();
    // The second call is the assertion. Files share a worker, and a detector that
    // stayed dirty after firing would attribute the first file's leak to every
    // file after it — which is how a real defect gets fixed in the wrong place.
    expect(() => expectNoDescriptorWarnings()).not.toThrow();
  });

  it('is installed by the config, before any module under test loads', () => {
    // Not a style check. Every opt-in file also imports this module, so the
    // listener would exist even without the config entry — but only from the
    // moment that import is evaluated, which is after the file's other imports
    // have run their module-level side effects. Registering through `setupFiles`
    // is what makes the coverage start earlier than the code being measured.
    const config = readFileSync(resolve(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("setupFiles: ['./tests/setup/descriptor-warnings.ts']");
  });
});
