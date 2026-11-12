import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { outputTargetIdentity } from '../../../src/lib/output-target-identity';

/**
 * Row 3 of the platform observation record (review gap GC-18) — Linux path
 * case-sensitivity in `src/lib/output-target-identity.ts`.
 *
 * On Linux the identity key is not case-folded, because two names that differ
 * only by case are two files there. Folding would merge them, and an output
 * declared as `Report.md` would be judged to collide with an unrelated
 * `report.md`, or, worse, not to collide with itself. What only a case-sensitive
 * filesystem can establish is that two real files of that kind keep two keys.
 *
 * The local Linux leg (`npm run verify:linux`) runs this on the container's own
 * filesystem. A filesystem mounted case-insensitively on Linux is out of scope:
 * the fixture then says it could not make the arrangement and does not pass
 * quietly.
 *
 * STATUS: skipped on macOS and Windows, where the key is folded by design.
 * See `docs/operations/platform-observation-record.md`.
 */
const IS_LINUX = process.platform === 'linux';
const SUITE_TITLE = IS_LINUX
  ? 'case-sensitive output identity on Linux'
  : `case-sensitive output identity on Linux (skipped: this run is on ${process.platform}, not linux)`;

describe.skipIf(!IS_LINUX)(SUITE_TITLE, () => {
  it('keeps two real files that differ only by case as two identities', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'linux-case-')));
    try {
      await fs.writeFile(path.join(root, 'Report.md'), 'upper\n');
      await fs.writeFile(path.join(root, 'report.md'), 'lower\n');
      const names = (await fs.readdir(root)).sort();
      // The arrangement itself: a case-insensitive mount would leave one file here.
      expect(names, 'this filesystem cannot hold two names differing only by case').toStrictEqual([
        'Report.md',
        'report.md'
      ]);

      const upper = await outputTargetIdentity(root, 'Report.md');
      const lower = await outputTargetIdentity(root, 'report.md');

      expect(upper.key).not.toBe(lower.key);
      expect(upper.key).toBe(path.join(root, 'Report.md'));
      expect(lower.key).toBe(path.join(root, 'report.md'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not fold a target that does not exist yet onto an existing file of another case', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'linux-case-')));
    try {
      await fs.writeFile(path.join(root, 'Report.md'), 'upper\n');

      const existing = await outputTargetIdentity(root, 'Report.md');
      const planned = await outputTargetIdentity(root, 'report.md');

      expect(planned.rest).toStrictEqual(['report.md']);
      expect(planned.key).not.toBe(existing.key);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
