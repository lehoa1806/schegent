// Feature 091 (T009, US1) — the filesystem adapter behind `RunOutputProbe`.
//
// FR-006b: the system must not wait indefinitely on a single check. One
// unreachable location — a stalled network mount, a filesystem that has stopped
// answering — must not hold the completion transition open. R3 in
// contracts/run-output-recording.md places the bound here rather than in
// `resolveRunOutputs` for two reasons: the resolver stays a pure function of its
// injected probe, so its tests need no fake timers; and the bound then holds for
// every probe implementation the resolver is ever handed, present and future.
//
// The bound is 2 s **per check**, not 2 s shared across a Run's outputs. A
// shared deadline would make every check after a slow one fail for a reason that
// is not its own, which contradicts R2 (a check that errors must not stop those
// following).
//
// A timed-out check **rejects**; it does not answer `false`. "I looked and
// nothing is there" and "I could not look" are different claims, and only the
// first is an answer. The resolver's per-iteration catch is what turns the
// second into an unresolved record — answering `false` here would launder a
// non-answer into an answer one layer too early, and the two would then be
// indistinguishable to anything downstream.
//
// `lstat`, not `stat`: a broken symlink at a declared target is *something*
// occupying that location, and the operator should see it recorded rather than
// silently reported absent. Following the link would also be a filesystem walk
// out of the workspace on a path the containment check already cleared as a
// lexical path only.

import * as fs from 'node:fs/promises';
import type { RunOutputProbe } from './run-output-resolver';

/** Per-check bound. Operational value; FR-006b requires that there be one. */
export const OUTPUT_PROBE_TIMEOUT_MS = 2_000;

/**
 * The one rejection this adapter raises itself, distinguished by type rather
 * than by its message. Classifying by message substring would misread any
 * filesystem error whose text happened to match, and it couples the branch to
 * wording that is otherwise free to change.
 */
class ProbeTimeoutError extends Error {
  constructor() {
    super(`output probe timed out after ${OUTPUT_PROBE_TIMEOUT_MS}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

/**
 * A `RunOutputProbe` backed by the real filesystem, bounded per invocation.
 *
 * Resolves `true` when something occupies the path, `false` when nothing does or
 * when the location could not be examined. Rejects only on timeout.
 */
export function createBoundedOutputProbe(): RunOutputProbe {
  return {
    async exists(absolutePath: string): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          fs.lstat(absolutePath),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ProbeTimeoutError()), OUTPUT_PROBE_TIMEOUT_MS);
          })
        ]);
        return true;
      } catch (error) {
        // A timeout is the one failure that is not an answer, so it propagates
        // and the resolver records it unresolved for the same reason it records
        // any other failed look — but by the path that says "could not look".
        if (error instanceof ProbeTimeoutError) throw error;
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };
}
