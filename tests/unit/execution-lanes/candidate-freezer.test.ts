// FR-R6-F10 T023 — freezing a lane's work into a candidate commit (research R3).
//
// WHAT THIS PINS:
//   - the candidate's parent is the lane's HEAD, and its tree holds the new, modified and deleted
//     files; the lane is clean afterwards, its HEAD and candidate ref name the commit, and each
//     freeze takes the next sequence number;
//   - no commit hook runs: a `pre-commit` or `commit-msg` hook that exits 1 neither runs nor
//     blocks the freeze;
//   - a clean lane refuses `candidate-empty`, and a missing `user.email` or `user.name` refuses
//     `git-identity-missing`, each with the lane's HEAD unchanged and no candidate recorded;
//   - an unknown lane refuses `lane-not-found`, and a paused lane `lane-state-invalid`;
//   - "no changes" is measured from the last recorded candidate, or the source commit, so a freeze
//     that failed after moving HEAD can be repeated (review R3).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateView } from '../../../src/contracts/execution-lanes';
import {
  createLaneHarness,
  disposeLaneHarnesses,
  HARNESS_NOW_MS,
  HARNESS_WS,
  type GitWrapper,
  type LaneHarness
} from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const NOW_ISO = new Date(HARNESS_NOW_MS).toISOString();
const FAILING_HOOKS = ['pre-commit', 'commit-msg', 'prepare-commit-msg'];

function gitIn(h: LaneHarness, cwd: string, args: readonly string[]): string {
  return h.fixture.git(args, cwd).trim();
}

async function frozen(h: LaneHarness, laneId: string): Promise<CandidateView> {
  const result = await h.service.freezeCandidate({ laneId });
  if (!result.ok) throw new Error(`freeze refused: ${result.refusal.reason}`);
  return result.value;
}

async function editedLane(h: LaneHarness): Promise<{ laneId: string; root: string; source: string }> {
  const lane = await h.provision();
  const root = await h.laneRoot(lane.laneId);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha, edited\n');
  fs.rmSync(path.join(root, 'src', 'b.txt'));
  fs.writeFileSync(path.join(root, 'src', 'c.txt'), 'charlie\n');
  return { laneId: lane.laneId, root, source: lane.sourceCommit };
}

describe('FR-R6-F10 candidate freezer: the freeze', () => {
  it('commits the lane work on top of its HEAD and leaves the lane clean', async () => {
    const h = createLaneHarness({ label: 'freeze' });
    const { laneId, root, source } = await editedLane(h);

    const candidate = await frozen(h, laneId);

    expect(candidate.seq).toBe(1);
    expect(candidate.parent).toBe(source);
    expect(candidate.createdAt).toBe(NOW_ISO);
    expect(gitIn(h, root, ['rev-parse', 'HEAD'])).toBe(candidate.commit);
    expect(gitIn(h, root, ['rev-parse', `${candidate.commit}^`])).toBe(source);
    expect(gitIn(h, root, ['rev-parse', `${candidate.commit}^{tree}`])).toBe(candidate.tree);
    expect(gitIn(h, root, ['rev-parse', `refs/schegent/lanes/${laneId}/candidate`])).toBe(candidate.commit);
    expect(gitIn(h, root, ['status', '--porcelain'])).toBe('');
    expect(gitIn(h, root, ['ls-tree', '-r', '--name-only', candidate.commit]).split('\n')).toEqual([
      'README.md',
      'src/a.txt',
      'src/c.txt'
    ]);
    expect(gitIn(h, root, ['show', `${candidate.commit}:src/a.txt`])).toBe('alpha, edited');
    expect(gitIn(h, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
  });

  it('takes the next sequence number on each freeze and reports it on the lane', async () => {
    const h = createLaneHarness({ label: 'freeze' });
    const { laneId, root } = await editedLane(h);
    const first = await frozen(h, laneId);
    fs.writeFileSync(path.join(root, 'src', 'd.txt'), 'delta\n');
    const second = await frozen(h, laneId);

    expect(second.seq).toBe(2);
    expect(second.parent).toBe(first.commit);
    const lane = h.service.getLane({ laneId });
    expect(lane.ok && lane.value.currentCandidate).toEqual(second);
  });

  it('runs no commit hook', async () => {
    const h = createLaneHarness({ label: 'freeze-hooks' });
    const hooksDir = path.join(h.fixture.root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const marker = path.join(h.fixture.sibling('hook-marker'), 'ran');
    for (const hook of FAILING_HOOKS) {
      const script = path.join(hooksDir, hook);
      fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      fs.chmodSync(script, 0o755);
    }
    const { laneId } = await editedLane(h);

    const result = await h.service.freezeCandidate({ laneId });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('FR-R6-F10 candidate freezer: an interrupted freeze (review R3)', () => {
  it('freezes again after a failure left HEAD moved and no candidate recorded', async () => {
    const armed = { value: true };
    const failCandidateRefOnce: GitWrapper = (real) => ({
      run: (args, opts) => {
        const isCandidateRef = args.at(0) === 'update-ref' && (args.at(1) ?? '').endsWith('/candidate');
        if (!armed.value || !isCandidateRef) return real.run(args, opts);
        armed.value = false;
        return Promise.resolve({ ok: false, code: 'exit', exitCode: 1 });
      }
    });
    const h = createLaneHarness({ label: 'freeze-interrupted', wrapGit: failCandidateRefOnce });
    const { laneId, root, source } = await editedLane(h);
    await expect(h.service.freezeCandidate({ laneId })).rejects.toThrow();
    const movedHead = gitIn(h, root, ['rev-parse', 'HEAD']);
    expect(movedHead).not.toBe(source);
    expect(h.lanes.currentCandidate(laneId)).toBeNull();

    const candidate = await frozen(h, laneId);

    expect(candidate.seq).toBe(1);
    expect(candidate.tree).toBe(gitIn(h, root, ['rev-parse', `${movedHead}^{tree}`]));
    expect(gitIn(h, root, ['rev-parse', 'HEAD'])).toBe(candidate.commit);
    expect(gitIn(h, root, ['rev-parse', `refs/schegent/lanes/${laneId}/candidate`])).toBe(candidate.commit);
    expect(await h.service.freezeCandidate({ laneId })).toEqual({ ok: false, refusal: { reason: 'candidate-empty' } });
  });
});

describe('FR-R6-F10 candidate freezer: refusals', () => {
  it('refuses candidate-empty for a clean lane', async () => {
    const h = createLaneHarness({ label: 'freeze-empty' });
    const lane = await h.provision();
    const root = await h.laneRoot(lane.laneId);

    expect(await h.service.freezeCandidate({ laneId: lane.laneId })).toEqual({
      ok: false,
      refusal: { reason: 'candidate-empty' }
    });
    expect(gitIn(h, root, ['rev-parse', 'HEAD'])).toBe(lane.sourceCommit);
    expect(h.lanes.currentCandidate(lane.laneId)).toBeNull();
  });

  it.each(['user.email', 'user.name'])('refuses git-identity-missing without %s', async (key) => {
    const h = createLaneHarness({ label: 'freeze-identity' });
    const { laneId, root, source } = await editedLane(h);
    h.fixture.git(['config', '--unset', key]);

    expect(await h.service.freezeCandidate({ laneId })).toEqual({
      ok: false,
      refusal: { reason: 'git-identity-missing' }
    });
    expect(gitIn(h, root, ['rev-parse', 'HEAD'])).toBe(source);
    expect(h.lanes.currentCandidate(laneId)).toBeNull();
  });

  it('refuses lane-busy for a second freeze of the same lane in flight', async () => {
    const h = createLaneHarness({ label: 'freeze-busy' });
    const { laneId } = await editedLane(h);

    const [first, second] = await Promise.all([
      h.service.freezeCandidate({ laneId }),
      h.service.freezeCandidate({ laneId })
    ]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    expect(h.lanes.currentCandidate(laneId)?.seq).toBe(1);
  });

  it('refuses lane-not-found for an unknown lane', async () => {
    const h = createLaneHarness({ label: 'freeze-missing' });
    expect(await h.service.freezeCandidate({ laneId: 'f'.repeat(32) })).toEqual({
      ok: false,
      refusal: { reason: 'lane-not-found' }
    });
  });

  it('refuses lane-state-invalid for a paused lane', async () => {
    const h = createLaneHarness({ label: 'freeze-paused' });
    const { laneId } = await editedLane(h);
    const paused = h.lanes.transitionLane(HARNESS_WS, laneId, ['active'], 'paused', {
      reason: null,
      now: NOW_ISO,
      generation: h.service.generation
    });
    expect(paused.ok).toBe(true);

    expect(await h.service.freezeCandidate({ laneId })).toEqual({
      ok: false,
      refusal: { reason: 'lane-state-invalid' }
    });
  });
});
