import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openWithinRoot } from '../../../src/lib/safe-open';

/**
 * FR-R3-083 (T1138, T1140) — a real reparse point at the leaf, on Windows.
 *
 * The classification is covered on every platform by
 * `tests/unit/lib/safe-open-reparse.test.ts`. What only Windows can establish is
 * that a real junction -- created by the OS, reported by `lstat` the way libuv
 * reports it -- reaches that classification at all.
 *
 * THE DISTINCTION THIS FIXTURE IS CAREFUL ABOUT (T1140)
 *
 * "Could not create the arrangement" and "the arrangement was not refused" are
 * different results, and reporting the first as the second is precisely the
 * failure mode `FR-R3-054` and `FR-R3-083` both warned about. Creating a symlink
 * on Windows needs Developer Mode or elevation; a junction usually does not. If
 * neither can be made, this test says so and does not pass quietly.
 *
 * WHAT IT CANNOT ESTABLISH
 *
 * Only symlink and junction reparse kinds are reachable through `lstat`. A cloud
 * placeholder or a dedup reparse looks like an ordinary file to Node, and telling
 * tags apart needs a native call -- decided once, and against, in
 * `docs/architecture/native-binding-decision.md`. A passing run of this fixture
 * means the two redirecting kinds are refused, not that every reparse tag is.
 *
 * STATUS: unrun on this cycle's platform.
 * See `docs/operations/platform-observation-record.md`.
 */
const IS_WINDOWS = process.platform === 'win32';

describe.skipIf(!IS_WINDOWS)(
  `reparse-point leaf refusal on Windows (skipped: this run is on ${process.platform}, not win32)`,
  () => {
    it('refuses a leaf that is a junction', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-reparse-'));
      // Both roots in the SAME `finally`. The target directory used to be removed
      // on the success path only, so an `expect.fail` — which is the point of the
      // arrangement check below — leaked it. A fixture that litters `$TMPDIR` on
      // its failure path is the shape `tests/global-temp-root.ts` records.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'win-reparse-target-'));
      try {
        await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');

        let arrangementMade = true;
        try {
          // 'junction' is the Windows reparse type that does not require elevation.
          await fs.symlink(outside, path.join(root, 'leaf'), 'junction');
        } catch {
          arrangementMade = false;
        }

        if (!arrangementMade) {
          // NOT a pass. The check could not be exercised, and saying so is the
          // whole point of T1140: a silent skip here would read, later, exactly
          // like a refusal that was observed.
          expect.fail(
            'could not create a junction on this Windows host; the reparse refusal was NOT exercised. ' +
              'This is an unrun acceptance half, not a passing one.'
          );
        }

        const result = await openWithinRoot(root, ['leaf', 'secret.txt'], { flags: 'r' });
        expect(result.outcome).toBe('refused');
        if (result.outcome === 'refused') {
          // A junction at a DIRECTORY component is caught by the component walk's
          // own lstat, which reports it as a link. Either refusal is correct and
          // both are recorded; what must not happen is an `opened`.
          expect(['symlink-component', 'reparse-point-leaf']).toContain(result.reason);
        }
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 15_000);

    it('refuses a junction that IS the leaf', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-reparse-leaf-'));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'win-reparse-leaf-target-'));
      try {
        let arrangementMade = true;
        try {
          await fs.symlink(outside, path.join(root, 'leaf'), 'junction');
        } catch {
          arrangementMade = false;
        }
        if (!arrangementMade) {
          expect.fail(
            'could not create a junction on this Windows host; the leaf refusal was NOT exercised.'
          );
        }
        const result = await openWithinRoot(root, ['leaf'], { flags: 'r' });
        expect(result.outcome).toBe('refused');
        if (result.outcome === 'refused') {
          expect(result.reason).toBe('reparse-point-leaf');
        }
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
);
