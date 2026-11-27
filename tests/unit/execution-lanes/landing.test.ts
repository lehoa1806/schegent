// FR-R6-F10 T027 — landing an approved request (contract §6, research R4).
//
// WHAT THIS PINS:
//   - the landing classifier, row by row (contract §6);
//   - a checked-out target lands by fast-forward: its tip, index and files equal the candidate,
//     and the journal holds the intent before the observation;
//   - a target checked out nowhere lands by `update-ref` with the expected old value;
//   - the re-checks refuse before any Git effect: target-advanced, target-diverged,
//     target-worktree-dirty (even with `merge.autoStash=true`), target-is-lane, review-stale;
//   - an effect that did not apply is `landing-not-applied`, and a checked-out target whose files
//     differ from the candidate afterwards is `uncertain`;
//   - the target is located again right before the effect, so a branch checked out since is
//     fast-forwarded in its worktree, not moved by `update-ref` (review S9).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationRequestView, VerificationProfile } from '../../../src/contracts/execution-lanes';
import { classifyLandingObservation } from '../../../src/services/execution-lanes/landing';
import { createLaneHarness, disposeLaneHarnesses, type LaneHarness, type LaneHarnessOptions } from './lane-harness';

afterEach(() => {
  disposeLaneHarnesses();
});

const MAIN = 'main';
const RELEASE = 'release';
const LANDED_TEXT = 'alpha, landed\n';
const PASSING: VerificationProfile = {
  profileId: 'unit',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

interface Approved {
  readonly h: LaneHarness;
  readonly root: string;
  readonly request: IntegrationRequestView;
}

interface ApprovedOptions extends LaneHarnessOptions {
  readonly target?: string;
  readonly approve?: boolean;
}

async function approved(options: ApprovedOptions = {}): Promise<Approved> {
  const h = createLaneHarness({ label: 'land', ...options });
  h.fixture.git(['branch', RELEASE]);
  const lane = await h.provision();
  const root = await h.laneRoot(lane.laneId);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), LANDED_TEXT);
  const frozen = await h.service.freezeCandidate({ laneId: lane.laneId });
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.refusal.reason}`);
  const queued = await h.service.requestIntegration({
    laneId: lane.laneId,
    targetBranch: options.target ?? MAIN,
    profile: PASSING
  });
  if (!queued.ok) throw new Error(`request refused: ${queued.refusal.reason}`);
  const verified = await h.service.verifyRequest({ requestId: queued.value.requestId });
  if (!verified.ok) throw new Error(`verify refused: ${verified.refusal.reason}`);
  const request = verified.value;
  if (options.approve !== false) {
    const receipt = h.service.approveRequest({
      requestId: request.requestId,
      candidateCommit: request.candidateCommit,
      targetCommit: request.expectedTargetCommit,
      profileRevision: request.profile.revision,
      profileDigest: request.profile.digest
    });
    if (!receipt.ok) throw new Error(`approve refused: ${receipt.refusal.reason}`);
  }
  return { h, root, request };
}

function tipOf(a: Approved, branch: string): string {
  return a.h.fixture.git(['rev-parse', `refs/heads/${branch}`]).trim();
}

function journalOf(a: Approved) {
  return a.h.integrations
    .listJournal(a.request.requestId)
    .map((entry) => [entry.kind, entry.method, entry.outcome, entry.reason]);
}

function stateOf(a: Approved) {
  const view = a.h.service.getRequest({ requestId: a.request.requestId });
  if (!view.ok) throw new Error(`getRequest refused: ${view.refusal.reason}`);
  return [view.value.state, view.value.reason, view.value.receipt?.outcome ?? null];
}

describe('FR-R6-F10 landing classifier (contract §6)', () => {
  const expected = 'e'.repeat(40);
  const candidate = 'c'.repeat(40);
  const other = 'f'.repeat(40);

  it.each([
    ['the tip is still the expected commit', { observedTip: expected, isAncestor: false, checkedOutFilesMatch: true }, { outcome: 'blocked', reason: 'landing-not-applied' }],
    ['the tip is the candidate, files match', { observedTip: candidate, isAncestor: true, checkedOutFilesMatch: true }, { outcome: 'landed', reason: null }],
    ['the tip is the candidate, not checked out', { observedTip: candidate, isAncestor: true, checkedOutFilesMatch: null }, { outcome: 'landed', reason: null }],
    ['the tip is the candidate, files differ', { observedTip: candidate, isAncestor: true, checkedOutFilesMatch: false }, { outcome: 'uncertain', reason: null }],
    ['the candidate is in the tip history', { observedTip: other, isAncestor: true, checkedOutFilesMatch: true }, { outcome: 'landed', reason: 'target-advanced-beyond' }],
    ['anything else', { observedTip: other, isAncestor: false, checkedOutFilesMatch: null }, { outcome: 'uncertain', reason: null }],
    ['the branch is gone', { observedTip: null, isAncestor: false, checkedOutFilesMatch: null }, { outcome: 'uncertain', reason: null }]
  ])('%s', (_label, observed, classification) => {
    expect(classifyLandingObservation({ expected, candidate, ...observed })).toEqual(classification);
  });
});

describe('FR-R6-F10 landing: applied', () => {
  it('fast-forwards a checked-out target: tip, index and files equal the candidate', async () => {
    const a = await approved();

    const landed = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(landed.ok && landed.value.state).toBe('landed');
    expect(tipOf(a, MAIN)).toBe(a.request.candidateCommit);
    expect(a.h.fixture.head()).toBe(a.request.candidateCommit);
    expect(a.h.fixture.git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(fs.readFileSync(path.join(a.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe(LANDED_TEXT);
    expect(stateOf(a)).toEqual(['landed', null, 'landed']);
    expect(journalOf(a)).toEqual([
      ['landing-intent', 'ff-merge', null, null],
      ['landing-observed', 'ff-merge', 'landed', null]
    ]);
  });

  it('moves a target checked out nowhere with update-ref, leaving the checkout alone', async () => {
    const a = await approved({ target: RELEASE });
    const mainBefore = tipOf(a, MAIN);

    const landed = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(landed.ok && landed.value.state).toBe('landed');
    expect(tipOf(a, RELEASE)).toBe(a.request.candidateCommit);
    expect(tipOf(a, MAIN)).toBe(mainBefore);
    expect(fs.readFileSync(path.join(a.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(journalOf(a)).toEqual([
      ['landing-intent', 'update-ref', null, null],
      ['landing-observed', 'update-ref', 'landed', null]
    ]);
  });
});

describe('FR-R6-F10 landing: the target checked out after it was located (review S9)', () => {
  it('fast-forwards it in its worktree, never moving a checked-out branch with update-ref', async () => {
    const window = { armed: false, checkOut: (): void => undefined };
    const checkOutOnFirstLocate: LaneHarnessOptions['wrapGit'] = (real) => ({
      run: async (args, opts) => {
        const result = await real.run(args, opts);
        if (window.armed && args.at(0) === 'worktree' && args.at(1) === 'list') {
          window.armed = false;
          window.checkOut();
        }
        return result;
      }
    });
    const a = await approved({ target: RELEASE, wrapGit: checkOutOnFirstLocate });
    window.checkOut = () => {
      a.h.fixture.git(['checkout', '-q', RELEASE]);
    };
    window.armed = true;

    const landed = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(landed.ok && landed.value.state).toBe('landed');
    expect(a.h.fixture.head()).toBe(a.request.candidateCommit);
    expect(a.h.fixture.git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(fs.readFileSync(path.join(a.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe(LANDED_TEXT);
    expect(journalOf(a)).toEqual([
      ['landing-intent', 'update-ref', null, null],
      ['landing-observed', 'ff-merge', 'landed', null]
    ]);
  });
});

describe('FR-R6-F10 landing: re-checks refuse before the effect', () => {
  it('refuses target-advanced when the target moved forward after approval', async () => {
    const a = await approved();
    a.h.fixture.write('src/c.txt', 'charlie\n');
    const advanced = a.h.fixture.commit('advance');

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'target-advanced',
        commits: { expected: a.request.expectedTargetCommit, candidate: a.request.candidateCommit, observed: advanced }
      }
    });
    expect(tipOf(a, MAIN)).toBe(advanced);
    expect(stateOf(a)).toEqual(['blocked', 'target-advanced', 'blocked']);
  });

  it('refuses target-diverged when the target no longer descends from the expected commit', async () => {
    const a = await approved({ target: RELEASE });
    const orphan = a.h.fixture
      .git(['commit-tree', `${a.request.expectedTargetCommit}^{tree}`, '-m', 'orphan'])
      .trim();
    a.h.fixture.git(['update-ref', `refs/heads/${RELEASE}`, orphan]);

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('target-diverged');
    expect(tipOf(a, RELEASE)).toBe(orphan);
  });

  it.each([
    ['with the default config', false],
    ['with merge.autoStash=true', true]
  ])('refuses target-worktree-dirty on a tracked edit %s, changing no file or ref', async (_label, autoStash) => {
    const a = await approved();
    if (autoStash) a.h.fixture.git(['config', 'merge.autoStash', 'true']);
    const readme = path.join(a.h.fixture.root, 'README.md');
    fs.writeFileSync(readme, 'operator edit\n');

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('target-worktree-dirty');
    expect(tipOf(a, MAIN)).toBe(a.request.expectedTargetCommit);
    expect(fs.readFileSync(readme, 'utf8')).toBe('operator edit\n');
    expect(fs.readFileSync(path.join(a.h.fixture.root, 'src', 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(a.h.fixture.git(['stash', 'list'])).toBe('');
  });

  it('refuses target-is-lane when the target branch is checked out in a lane root', async () => {
    const a = await approved({ target: RELEASE });
    const other = await a.h.provision();
    a.h.fixture.git(['checkout', '-q', RELEASE], await a.h.laneRoot(other.laneId));

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('target-is-lane');
    expect(tipOf(a, RELEASE)).toBe(a.request.expectedTargetCommit);
  });

  it('refuses review-stale with no receipt, leaving the request awaiting review', async () => {
    const a = await approved({ approve: false });

    expect(await a.h.service.landRequest({ requestId: a.request.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'review-stale' }
    });
    expect(stateOf(a)).toEqual(['awaiting-review', null, null]);
    expect(a.h.integrations.listJournal(a.request.requestId)).toEqual([]);
  });

  it('refuses review-stale when the receipt no longer matches the request', async () => {
    const a = await approved({ approve: false });
    a.h.integrations.insertReceipt({
      receiptId: 'a'.repeat(32),
      requestId: a.request.requestId,
      laneId: a.request.laneId,
      candidateCommit: a.request.candidateCommit,
      targetRef: a.request.targetRef,
      targetCommit: 'f'.repeat(40),
      profileRevision: a.request.profile.revision,
      profileDigest: a.request.profile.digest,
      approvedAt: '2026-11-10T12:00:00.000Z',
      outcome: null,
      outcomeReason: null,
      ownerGeneration: a.h.service.generation
    });

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(!result.ok && result.refusal.reason).toBe('review-stale');
    expect(tipOf(a, MAIN)).toBe(a.request.expectedTargetCommit);
  });

  it('refuses request-state-invalid for a request not awaiting review', async () => {
    const a = await approved();
    await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(await a.h.service.landRequest({ requestId: a.request.requestId })).toEqual({
      ok: false,
      refusal: { reason: 'request-state-invalid' }
    });
  });
});

describe('FR-R6-F10 landing: the observation decides', () => {
  it('blocks with landing-not-applied when the effect left the tip unchanged', async () => {
    const a = await approved({
      wrapGit: (real) => ({
        run: (args, opts) => (args.includes('merge') ? Promise.resolve({ ok: true, stdout: '' }) : real.run(args, opts))
      })
    });

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'landing-not-applied',
        commits: {
          expected: a.request.expectedTargetCommit,
          candidate: a.request.candidateCommit,
          observed: a.request.expectedTargetCommit
        }
      }
    });
    expect(stateOf(a)).toEqual(['blocked', 'landing-not-applied', 'blocked']);
    expect(journalOf(a).at(-1)).toEqual(['landing-observed', 'ff-merge', 'blocked', 'landing-not-applied']);
  });

  it('marks uncertain when the checked-out files differ from the candidate after the effect', async () => {
    let fixtureRoot = '';
    const a = await approved({
      wrapGit: (real) => ({
        run: async (args, opts) => {
          const result = await real.run(args, opts);
          if (args.includes('merge')) fs.writeFileSync(path.join(fixtureRoot, 'src', 'b.txt'), 'raced\n');
          return result;
        }
      })
    });
    fixtureRoot = a.h.fixture.root;

    const result = await a.h.service.landRequest({ requestId: a.request.requestId });

    expect(result.ok && result.value.state).toBe('uncertain');
    expect(stateOf(a)).toEqual(['uncertain', null, 'uncertain']);
    expect(a.h.integrations.listJournal(a.request.requestId).at(-1)).toMatchObject({
      kind: 'landing-observed',
      outcome: 'uncertain',
      observedTip: a.request.candidateCommit
    });
  });
});
