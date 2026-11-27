import { describe, it, expect, beforeEach } from 'vitest';
import { platformLacksNoFollow } from '../../../src/lib/safe-open';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  judgeOutputTargetsAtDispatch,
  OutputTargetRefusedAtDispatch
} from '../../../src/services/dispatch-output-guard';
import { outputTargetIdentity } from '../../../src/lib/output-target-identity';
import type { FrozenOutputRequest } from '../../../src/contracts/run-request';

/**
 * FR-R3-079 (T1061, T1062) — the dispatch-time verdict and canonical identity.
 *
 * The finding is a window, not a wrong answer: request-time containment is
 * lexical and true when taken, the operator confirms it, and the whole planning
 * phase then runs before the child writes. These fixtures mutate the tree in
 * exactly that interval — after the target was validated, before it is
 * dispatched — which is the arrangement the old code had no second look at.
 *
 * NON-VACUITY (T1062), measured rather than asserted: replacing the component
 * walk with the lexical `resolveWithinWorkspace` check the validator uses makes
 * the first fixture below return `contained` for a target whose parent is a link
 * to a directory outside the workspace — the escape, reproduced. Reverted, and
 * the file re-run green. The identity fixture's control is the same swap in
 * reverse: with `path.normalize` + case-fold in place of
 * `outputTargetIdentity`, the two aliased targets produce two different keys and
 * the duplicate goes unreported.
 */
let workspaceRoot: string;
let outside: string;

const output = (portId: string, target: string, type = 'file'): FrozenOutputRequest =>
  ({ portId, type, target, overwriteConfirmed: true }) as unknown as FrozenOutputRequest;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-guard-'));
  workspaceRoot = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
});

describe('FR-R3-079 — the output target is re-judged at dispatch', () => {
  it('admits a target whose parents are ordinary directories', async () => {
    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/report.md')
    ]);
    expect(verdict).toEqual({ outcome: 'contained' });
  });

  it('admits a target whose parent does not exist yet', async () => {
    // The ordinary case for a declared output, and the one a stricter reading
    // would break: a component that is absent has nothing to be redirected
    // through, and every component above it was walked.
    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/not/created/yet/report.md')
    ]);
    expect(verdict).toEqual({ outcome: 'contained' });
  });

  it('refuses when a parent becomes a link out of the workspace after validation', async () => {
    // The window, in its literal order: the target validated and was confirmed
    // while `out/` was a real directory. Then this happened.
    await fs.rm(path.join(workspaceRoot, 'out'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, 'out'), 'dir');

    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/report.md')
    ]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome === 'refused') {
      // Names the link, not an errno.
      expect(verdict.reason).toBe('symlink-component');
      expect(verdict.portId).toBe('report');
    }
  });

  it('refuses a target that is lexically outside the workspace', async () => {
    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', '../escape.md')
    ]);
    expect(verdict.outcome).toBe('refused');
  });

  it('leaves the deliberate external-side-effect port alone', async () => {
    // Its externality is the operator's decision and was already taken behind
    // its own confirmation. This item must not turn that into a refusal.
    await fs.rm(path.join(workspaceRoot, 'out'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, 'out'), 'dir');
    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('webhook', 'out/report.md', 'external-reference')
    ]);
    expect(verdict).toEqual({ outcome: 'contained' });
  });

  it('creates nothing while judging', async () => {
    await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/deep/deeper/report.md')
    ]);
    // A check that materialised its own subject would be reporting on a tree it
    // had just changed.
    await expect(fs.stat(path.join(workspaceRoot, 'out', 'deep'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('refuses a LEAF swapped for a symlink out of the workspace', async () => {
    // The parent walk deliberately skips the leaf, "because the leaf is what the
    // child will create". That is true only while the leaf does not exist. A
    // target absent at request time is confirmed with no overwrite prompt, and
    // anything co-resident can create it as a link before dispatch — after which
    // the child's write follows it out. `SEC-04` with one more step, and the walk
    // above never looked at the name that was swapped.
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(workspaceRoot, 'out', 'report.md'));

    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/report.md')
    ]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    // FR-R3-083 — the reason is platform-dependent now. Where the kernel would have
    // refused the open atomically it is `symlink-leaf`; where it would not (no
    // `O_NOFOLLOW`, i.e. Windows) this guard's `lstat` is all there is, and it says
    // so. Pinning the POSIX value unguarded would fail on the very checkout this
    // feature exists to support.
    //
    // Only the two reparse kinds `lstat` reports as links are reachable at all;
    // telling tags apart needs a native call, declined on the record in
    // `docs/architecture/native-binding-decision.md`.
    expect(verdict.reason).toBe(
      platformLacksNoFollow() ? 'reparse-point-leaf' : 'symlink-leaf'
    );
    expect(verdict.portId).toBe('report');
  });

  it('passes an ordinary leaf that already exists as a regular file', async () => {
    // The overwrite case, which is the operator's decision and was taken at
    // request time. The leaf check must not turn it into a refusal.
    await fs.mkdir(path.join(workspaceRoot, 'out'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'out', 'report.md'), 'previous');

    const verdict = await judgeOutputTargetsAtDispatch(workspaceRoot, [
      output('report', 'out/report.md')
    ]);
    expect(verdict.outcome).toBe('contained');
  });

  it('carries the port and reason on the Run-level failure', () => {
    const error = new OutputTargetRefusedAtDispatch('report', 'symlink-component');
    expect(error.portId).toBe('report');
    expect(error.reason).toBe('symlink-component');
    // The path is deliberately absent: workspace paths are not serialized into
    // the structured record.
    expect(error.message).not.toContain(path.sep + 'workspace');
  });
});

describe('FR-R3-079 — canonical output-target identity', () => {
  it('gives two names for one existing file the same key', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'real'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'real', 'a.md'), 'x');
    await fs.symlink(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'alias'), 'dir');

    const viaReal = await outputTargetIdentity(workspaceRoot, 'real/a.md');
    const viaAlias = await outputTargetIdentity(workspaceRoot, 'alias/a.md');
    expect(viaAlias.key).toBe(viaReal.key);
  });

  it('gives two names for one ABSENT file the same key', async () => {
    // The residual `53_FR-R3-053` §5 recorded by name. `realpath` cannot answer
    // for a file that does not exist, so identity is the canonicalized deepest
    // existing ancestor plus the literal remainder — and the aliasing lives in
    // the ancestry, which is the part that does exist.
    await fs.mkdir(path.join(workspaceRoot, 'real'), { recursive: true });
    await fs.symlink(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'alias'), 'dir');

    const viaReal = await outputTargetIdentity(workspaceRoot, 'real/absent/report.md');
    const viaAlias = await outputTargetIdentity(workspaceRoot, 'alias/absent/report.md');
    expect(viaAlias.key).toBe(viaReal.key);
    expect(viaReal.rest).toEqual(['absent', 'report.md']);
  });

  it('keeps genuinely different targets distinct', async () => {
    const a = await outputTargetIdentity(workspaceRoot, 'out/a.md');
    const b = await outputTargetIdentity(workspaceRoot, 'out/b.md');
    expect(a.key).not.toBe(b.key);
  });

  it('agrees with the lexical form when no link is involved', async () => {
    const direct = await outputTargetIdentity(workspaceRoot, 'out/a.md');
    const roundabout = await outputTargetIdentity(workspaceRoot, 'out/nested/../a.md');
    expect(roundabout.key).toBe(direct.key);
  });
});
