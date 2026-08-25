import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { signalProcessTree, processTreeIsGone } from '../../../src/runner/process-tree';

/**
 * FR-R3-083 (T1137) / FR-R3-054 §5 — the Windows half of the sentinel fixture.
 *
 * `FR-R3-054` demonstrated the defect and the fix on POSIX and recorded the
 * Windows half as **unrun**, because the development machine is macOS. Reporting
 * an untested platform as supported is the thing both items were careful not to
 * do, so this fixture exists, runs unedited on a Windows checkout, and skips
 * everywhere else with the platform named.
 *
 * It lives under `tests/unit/` and not `tests/platform/` for a reason worth
 * recording: `vitest.config.ts`'s `include` list names `tests/unit`,
 * `tests/integration`, `tests/parity`, `tests/lint` and `tests/contract`, and no
 * npm script invokes anything else. A fixture in a directory outside that list
 * would never run on ANY platform -- including the Windows checkout this exists
 * for -- while looking, in the tree, exactly like a fixture that does.
 *
 * WHAT IT ESTABLISHES ON WINDOWS
 *
 * `taskkill /T` walks the child tree by parent pid. A grandchild that keeps
 * appending to a sentinel must stop after the tree is signalled. It is NOT
 * asserted that a re-parenting descendant stops -- that is the escape
 * `docs/architecture/native-binding-decision.md` records as a permanent limit,
 * and a fixture claiming otherwise would be claiming a Job Object this product
 * does not have.
 *
 * STATUS: unrun on this cycle's platform.
 * See `docs/operations/platform-observation-record.md`.
 */
const IS_WINDOWS = process.platform === 'win32';

describe.skipIf(!IS_WINDOWS)(
  `process tree cancellation on Windows (skipped: this run is on ${process.platform}, not win32)`,
  () => {
    it('stops a grandchild that is appending to a sentinel', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'win-sentinel-'));
      const sentinel = path.join(dir, 'sentinel.txt');
      try {
        // The child spawns a grandchild that appends every 25 ms. Killing only the
        // direct child leaves the grandchild appending -- that is the defect
        // FR-R3-054 demonstrated, and what the tree signal must prevent.
        const grandchildSource =
          `const fs=require('fs');setInterval(()=>{try{fs.appendFileSync(${JSON.stringify(sentinel)},'x')}catch{}},25);`;
        const childSource =
          `const {spawn}=require('child_process');` +
          `spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:'ignore'});` +
          `setInterval(()=>{},1000);`;
        const child = spawn(process.execPath, ['-e', childSource], { stdio: 'ignore' });

        await new Promise((r) => setTimeout(r, 500));
        const before = (await fs.readFile(sentinel, 'utf8')).length;
        expect(before).toBeGreaterThan(0);

        await signalProcessTree(child, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 750));

        const settled = (await fs.readFile(sentinel, 'utf8')).length;
        await new Promise((r) => setTimeout(r, 500));
        const after = (await fs.readFile(sentinel, 'utf8')).length;

        // The sentinel stopped advancing. Recorded whether it passes or fails: a
        // failure here is the honest finding that `taskkill /T` did not reach the
        // grandchild on this Windows build, and belongs in the platform record.
        expect(after).toBe(settled);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it('distinguishes a live child from a dead one', async () => {
      // `processTreeIsGone` on Windows answers only for the DIRECT CHILD -- there is
      // no group to probe -- so this records what the probe means there rather than
      // leaving a reader to assume it means what it means on POSIX.
      //
      // Asserted behaviourally, both directions. The first version of this test
      // asserted `typeof ... === 'boolean'`, which holds for every possible
      // implementation including `return false` unconditionally -- it would have
      // let the platform record list a Windows acceptance half as covered by a
      // fixture that exercised nothing.
      //
      // It cannot be dry-run on POSIX to check the assertions are sound, and the
      // reason IS the fact under test: `processTreeIsGone` probes `-pid` (the
      // group) on POSIX and `pid` (the child) on Windows, so a non-detached child
      // reports `true` on POSIX while alive. Unrun here, like the rest of this
      // file -- see docs/operations/platform-observation-record.md.
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
        stdio: 'ignore'
      });
      try {
        expect(processTreeIsGone(child)).toBe(false);
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
        expect(processTreeIsGone(child)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    }, 15_000);
  }
);
