// Feature 020 T013 — `discoverIterations` numeric-descending sort and
// `iter-*` filtering. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §2.
//
// Feature 203 (D3, D4, FR-006, FR-036) — the answer stopped being a bare array.
// `[]` used to mean three different things: the directory is absent, the
// directory is empty, and access to it was refused. Three situations with three
// different operator responses, collapsed into one value no caller could take
// apart — so the caller re-`stat`ed the same directory to recover the first
// distinction, which is a second observation that can disagree with the first
// and a race window between them. These are the same cases as before; each now
// says which situation it is in, and refusal is neither of the other two.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverIterations } from '../../../../src/services/phase-log/phase-log-iteration-discovery';

// The refusal case needs a filesystem that will actually refuse. `chmod 000`
// does not refuse root, and a case that passes because the reader was let in
// proves nothing — so an environment that cannot refuse is recorded as
// unexercised rather than reported as met. Precedent and reasoning:
// tests/unit/audit/platform-permission-modes.test.ts:14-19.
const POSIX = process.platform !== 'win32';
const NON_ROOT = process.getuid === undefined || process.getuid() !== 0;
const CAN_REFUSE = POSIX && NON_ROOT;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-it-disc-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Feature 020 T013 — discoverIterations', () => {
  it('sorts iterations numerically descending (iter-10 before iter-2)', async () => {
    await fs.mkdir(path.join(tmpDir, 'iter-1'));
    await fs.mkdir(path.join(tmpDir, 'iter-2'));
    await fs.mkdir(path.join(tmpDir, 'iter-10'));
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual({ outcome: 'listed', iterations: [10, 2, 1] });
  });

  it('filters out non-iter-* directories and stray files', async () => {
    await fs.mkdir(path.join(tmpDir, 'iter-1'));
    await fs.mkdir(path.join(tmpDir, 'iter-5'));
    await fs.mkdir(path.join(tmpDir, 'other'));
    await fs.mkdir(path.join(tmpDir, 'iter-abc'));
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'noise');
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual({ outcome: 'listed', iterations: [5, 1] });
  });

  it('reports the directory absent', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = await discoverIterations(missing);
    expect(result).toEqual({ outcome: 'directory-absent' });
  });

  it('reports an empty listing', async () => {
    const result = await discoverIterations(tmpDir);
    expect(result).toEqual({ outcome: 'listed', iterations: [] });
  });

  // The point of the two cases above is not their individual answers but that
  // the answers DIFFER. Before this change both were `[]`, so a caller holding
  // the result could not tell "this phase was never recorded" from "this phase
  // was recorded and has produced nothing yet" — and the operator got the same
  // blank pane for both. Asserted here in one place so the collapse cannot come
  // back without a test naming it.
  it('answers the absent directory and the empty one differently', async () => {
    const absent = await discoverIterations(path.join(tmpDir, 'does-not-exist'));
    const empty = await discoverIterations(tmpDir);
    expect(absent.outcome).toBe('directory-absent');
    expect(empty.outcome).toBe('listed');
    expect(absent).not.toEqual(empty);
  });
});

describe.skipIf(!CAN_REFUSE)('Feature 203 T025 — a refusal is thrown, not swallowed', () => {
  it('rethrows EACCES/EPERM rather than answering with an empty listing', async () => {
    // The guard, asserted rather than assumed: if this process were root the
    // chmod below would not refuse it, `discoverIterations` would return a
    // perfectly ordinary listing, and the rejection assertion would fail for a
    // reason that has nothing to do with the code under test.
    expect(process.getuid?.()).not.toBe(0);

    const locked = path.join(tmpDir, 'locked');
    await fs.mkdir(locked);
    await fs.mkdir(path.join(locked, 'iter-1'));
    await fs.chmod(locked, 0o000);
    try {
      // A refusal is not an empty result. It reaches the operator through the
      // existing `permission-denied` failure at `readPhaseLog`, which returns
      // before any manifest is built — so it must leave here as a throw, and
      // there is exactly one way a refused access is reported (SC-017).
      await expect(discoverIterations(locked)).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/)
      });
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });
});

describe('Feature 203 T025 — what this checkout did not exercise', () => {
  it('records an environment that cannot refuse rather than reporting it met', () => {
    // Skipping is a stated limit, not a gap papered over by a green suite. On
    // Windows `chmod` maps onto a read-only attribute and does not model the
    // access bits `readdir` would refuse on; as root nothing refuses at all.
    const unexercised = CAN_REFUSE ? [] : ['refusal (chmod cannot refuse here)'];
    expect(unexercised.length).toBe(CAN_REFUSE ? 0 : 1);
    expect(NON_ROOT).toBe(process.getuid === undefined || process.getuid() !== 0);
  });
});
