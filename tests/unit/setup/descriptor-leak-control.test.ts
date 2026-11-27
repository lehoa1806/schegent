import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { matchesDescriptorWarning } from '../../setup/descriptor-warnings';

/**
 * FR-R3-137 (T1531e, FR-014, C4 level 2, C10) — the real-leak control.
 *
 * The synthetic control next door proves the detector's match and its failure
 * path against text this repository wrote down. This one proves the text: a
 * `FileHandle` is opened, its last reference dropped, and the collector left to
 * do what it did to the transport sink for the whole life of that file. If Node
 * ever changes the wording, this fails and the predicate gets updated — the
 * alternative is a detector that quietly stops matching and a suite that goes on
 * reporting zero.
 *
 * ITS OWN FILE, per T1531e, so a deliberate leak cannot be mistaken for a
 * neighbour's. The isolation is stronger than the task asked for: the leak
 * happens in a CHILD process, so the parent worker's listener never sees it and
 * the file needs no reset.
 *
 * NO NEW NPM SCRIPT, AND NO FLAG THE RUN CAN BE MISSING (C10). `--expose-gc` is
 * supplied here, as an argument to the child. Requiring it on the suite's own
 * command would put this control one forgotten flag away from silently passing,
 * and a control that can be disabled by the thing it is controlling is not one.
 */

/**
 * Leak one descriptor, on purpose, and give the warning a chance to print.
 *
 * `open` inside a function whose frame is discarded is the part that matters:
 * awaiting the handle at top level keeps it reachable through the completion
 * record, and the collector then has nothing to collect. Two collections and a
 * short-lived timer follow because `ProcessEmitWarning` defers to a tick — a
 * child that exits the instant it drops the handle leaks silently, which is a
 * fair description of how this went unnoticed in the first place.
 */
const LEAK_SCRIPT = `
const { open } = require('node:fs/promises');
async function leak() {
  const handle = await open(process.execPath, 'r');
  void handle.fd;
}
(async () => {
  await leak();
  global.gc();
  global.gc();
  await new Promise((r) => setTimeout(r, 50));
  global.gc();
  await new Promise((r) => setTimeout(r, 100));
})();
`;

describe('FR-R3-137 — a real collected FileHandle (T1531e, FR-014, C4 level 2)', () => {
  it("produces text the detector's predicate matches", () => {
    const run = spawnSync(process.execPath, ['--expose-gc', '-e', LEAK_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    });

    expect(run.error, 'the child must have run to completion').toBeUndefined();
    // The exit code is the whole reason this item existed. A leaked descriptor is
    // a warning on stderr in a run that reports success, so nothing downstream of
    // an exit code ever had a reason to look.
    expect(run.status).toBe(0);

    expect(run.stderr).toContain('Closing file descriptor');
    expect(run.stderr).toContain('DEP0137');

    // The assertion the two above cannot make. `toContain` checks that Node said
    // what this file claims; this checks that the shipped predicate agrees, which
    // is the only version of the question the detector answers.
    const matched = run.stderr
      .split('\n')
      .filter((line) => matchesDescriptorWarning(line));
    expect(matched.length, `predicate matched nothing in:\n${run.stderr}`).toBeGreaterThan(0);
  });
});
