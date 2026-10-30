import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkpointKey,
  classifyLoss,
  parseCheckpoint,
  settleCheckpointMode,
  type AuditHeadCheckpointV1,
  type CheckpointRead
} from '../../../src/audit/audit-checkpoint';
import type { ChainCheck, ChainPositions } from '../../../src/audit/audit-chain';

/**
 * FR-R4-F03 (FR-015, FR-016, SC-006; contract T9, C2, C6; data-model §4, §5; R15, R16) — the head
 * checkpoint's pure core: its key, its parse, the loss classification and the writer's mode table.
 *
 * Pure on purpose: every row of the two tables is one case, so a failure names the row. The real
 * writer, store and verifier are driven together in `audit-checkpoint-lifecycle.test.ts`.
 *
 * THE RULE THIS FILE HOLDS. A checkpoint that is absent, retired or unreadable never produces a
 * clean verdict, and a history that is shorter than its checkpoint is reported with the counts that
 * show it, as `shorter` or `missing`. "Not performed" is never worded as "complete".
 */

const hex = (digit: string): string => digit.repeat(64);
const KEY = hex('a');

const checkpoint = (over: Partial<AuditHeadCheckpointV1> = {}): AuditHeadCheckpointV1 => ({
  version: 1,
  workspaceKey: KEY,
  state: 'active',
  origin: 'new',
  headDigest: hex('b'),
  position: 5,
  establishedAtMs: 1_000,
  updatedAtMs: 2_000,
  ...over
});

const active = (over: Partial<AuditHeadCheckpointV1> = {}): CheckpointRead => ({
  status: 'active',
  checkpoint: checkpoint(over)
});

const retired = (): CheckpointRead => ({
  status: 'retired',
  checkpoint: checkpoint({
    state: 'retired',
    headDigest: '',
    position: 0,
    retiredAtMs: 3_000,
    retiredPosition: 5
  })
});

const absent: CheckpointRead = { status: 'absent' };

const intact = (positions: ChainPositions): ChainCheck => ({
  files: { ordered: ['audit.log'], unrecognized: [] },
  verdict: {
    ok: true,
    entries: positions.tail - positions.prunedThrough,
    cuts: 0,
    unchainedPrefix: 0,
    prunedLegacy: 0,
    transition: 'genesis',
    damages: [],
    positions
  }
});

const broken = (): ChainCheck => ({
  files: { ordered: ['audit.log'], unrecognized: [] },
  verdict: { ok: false, reason: 'broken-link', atEntry: 3, detail: 'x' }
});

describe('the checkpoint key (C1; FR-019)', () => {
  it('is 64 lowercase hex characters and is stable for one path', () => {
    const key = checkpointKey('/work/space');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpointKey('/work/space')).toBe(key);
  });

  it('differs for two paths, and from a plain SHA-256 of the path', () => {
    expect(checkpointKey('/work/a')).not.toBe(checkpointKey('/work/b'));
    const plain = createHash('sha256').update('/work/space').digest('hex');
    expect(checkpointKey('/work/space')).not.toBe(plain);
  });

  it('carries no part of the path', () => {
    const key = checkpointKey('/Users/someone/projects/secret-product');
    expect(key).not.toContain('someone');
    expect(key).not.toContain('secret');
  });
});

describe('parsing a checkpoint file (C2)', () => {
  const text = (value: unknown): string => JSON.stringify(value);

  it('reads an active and a retired checkpoint', () => {
    expect(parseCheckpoint(text(checkpoint()), KEY)).toEqual(active());
    const retiredCheckpoint = checkpoint({
      state: 'retired',
      headDigest: '',
      position: 0,
      retiredAtMs: 3_000,
      retiredPosition: 5
    });
    expect(parseCheckpoint(text(retiredCheckpoint), KEY)).toEqual({
      status: 'retired',
      checkpoint: retiredCheckpoint
    });
  });

  it('calls bad JSON corrupt, never absent', () => {
    expect(parseCheckpoint('{not json', KEY)).toEqual({ status: 'unreadable', reason: 'corrupt' });
    expect(parseCheckpoint('', KEY)).toEqual({ status: 'unreadable', reason: 'corrupt' });
    expect(parseCheckpoint('[]', KEY)).toEqual({ status: 'unreadable', reason: 'corrupt' });
  });

  it('calls wrong field types corrupt', () => {
    expect(parseCheckpoint(text({ ...checkpoint(), position: '5' }), KEY)).toEqual({
      status: 'unreadable',
      reason: 'corrupt'
    });
    expect(parseCheckpoint(text({ ...checkpoint(), state: 'sleeping' }), KEY)).toEqual({
      status: 'unreadable',
      reason: 'corrupt'
    });
    expect(parseCheckpoint(text({ ...checkpoint(), origin: 'invented' }), KEY)).toEqual({
      status: 'unreadable',
      reason: 'corrupt'
    });
  });

  it('calls a workspaceKey that is not the file key corrupt', () => {
    expect(parseCheckpoint(text(checkpoint({ workspaceKey: hex('c') })), KEY)).toEqual({
      status: 'unreadable',
      reason: 'corrupt'
    });
  });

  it('calls a version this release does not know version-unknown, and does not read its other fields', () => {
    expect(parseCheckpoint(text({ version: 2, anything: 'a newer release wrote' }), KEY)).toEqual({
      status: 'unreadable',
      reason: 'version-unknown'
    });
    expect(parseCheckpoint(text({ ...checkpoint(), version: 2 }), KEY)).toEqual({
      status: 'unreadable',
      reason: 'version-unknown'
    });
  });
});

describe('classifying loss, top to bottom (data-model §5; R16)', () => {
  it.each([
    ['corrupt', 'checkpoint-unreadable'],
    ['version-unknown', 'checkpoint-version-unknown'],
    ['unreachable', 'checkpoint-unreachable']
  ] as const)('row 1: an unreadable checkpoint (%s) is not-performed (%s), whatever the chain says', (reason, mapped) => {
    const read: CheckpointRead = { status: 'unreadable', reason };
    const expected = { state: 'not-performed', reason: mapped };
    expect(classifyLoss(read, null)).toEqual(expected);
    expect(classifyLoss(read, intact({ prunedThrough: 0, tail: 5, probe: null }))).toEqual(expected);
    expect(classifyLoss(read, broken())).toEqual(expected);
  });

  it('row 2: a chain that is not intact is not-performed (chain-not-intact)', () => {
    const expected = { state: 'not-performed', reason: 'chain-not-intact' };
    expect(classifyLoss(active(), broken())).toEqual(expected);
    expect(classifyLoss(absent, broken())).toEqual(expected);
    expect(classifyLoss(retired(), broken())).toEqual(expected);
  });

  it('row 3: no chain file and no active checkpoint is a new workspace', () => {
    expect(classifyLoss(absent, null)).toEqual({ state: 'new-workspace' });
    expect(classifyLoss(retired(), null)).toEqual({ state: 'new-workspace' });
  });

  it('row 4: no chain file with an active checkpoint is missing history', () => {
    expect(classifyLoss(active({ position: 12 }), null)).toEqual({ state: 'missing', expected: 12 });
  });

  it('row 5: chain files with no active checkpoint is no-checkpoint-for-location', () => {
    const present = intact({ prunedThrough: 0, tail: 3, probe: null });
    expect(classifyLoss(absent, present)).toEqual({ state: 'no-checkpoint-for-location' });
    expect(classifyLoss(retired(), present)).toEqual({ state: 'no-checkpoint-for-location' });
  });

  it('row 6: the head found where the checkpoint says is consistent, for origin new and reset', () => {
    const found = intact({ prunedThrough: 0, tail: 7, probe: { digest: hex('b'), foundAt: 5 } });
    expect(classifyLoss(active({ origin: 'new' }), found)).toEqual({ state: 'consistent', position: 5 });
    expect(classifyLoss(active({ origin: 'reset' }), found)).toEqual({ state: 'consistent', position: 5 });
  });

  it('row 6: origin adopted reads as adopted, with the time detection began', () => {
    const found = intact({ prunedThrough: 0, tail: 5, probe: { digest: hex('b'), foundAt: 5 } });
    expect(classifyLoss(active({ origin: 'adopted', establishedAtMs: 4_242 }), found)).toEqual({
      state: 'adopted',
      position: 5,
      adoptedAtMs: 4_242
    });
  });

  it('row 6: a head that retention legitimately removed (its position is at or below the pruned total) is consistent', () => {
    const pruned = intact({ prunedThrough: 5, tail: 8, probe: { digest: hex('b'), foundAt: null } });
    expect(classifyLoss(active({ position: 5 }), pruned)).toEqual({ state: 'consistent', position: 5 });
    const prunedFurther = intact({ prunedThrough: 9, tail: 9, probe: null });
    expect(classifyLoss(active({ position: 5 }), prunedFurther)).toEqual({ state: 'consistent', position: 5 });
  });

  it('row 7: a tail shorter than the checkpoint, head not found, is shorter / tail-removed with both counts', () => {
    const truncated = intact({ prunedThrough: 0, tail: 3, probe: { digest: hex('b'), foundAt: null } });
    expect(classifyLoss(active({ position: 5 }), truncated)).toEqual({
      state: 'shorter',
      expected: 5,
      found: 3,
      detail: 'tail-removed'
    });
  });

  it('row 8: history at least as long as the checkpoint but without its head is shorter / head-absent', () => {
    const rewritten = intact({ prunedThrough: 0, tail: 6, probe: { digest: hex('b'), foundAt: null } });
    expect(classifyLoss(active({ position: 5 }), rewritten)).toEqual({
      state: 'shorter',
      expected: 5,
      found: 6,
      detail: 'head-absent'
    });
  });

  it('the same row at another position is a rewrite with recomputed links, so it is shorter, not consistent', () => {
    const elsewhere = intact({ prunedThrough: 0, tail: 9, probe: { digest: hex('b'), foundAt: 8 } });
    expect(classifyLoss(active({ position: 5 }), elsewhere)).toMatchObject({
      state: 'shorter',
      detail: 'head-absent'
    });
  });
});

describe("the writer's checkpoint mode (R15)", () => {
  const found = (foundAt: number | null, over: Partial<ChainPositions> = {}): ChainCheck =>
    intact({ prunedThrough: 0, tail: 9, probe: { digest: hex('b'), foundAt }, ...over });

  it('absent and no chain files: new, from position 0', () => {
    expect(settleCheckpointMode(absent, { filesPresent: false, tailDigest: null, walk: null })).toEqual({
      mode: 'new',
      position: 0
    });
  });

  it('absent or retired, files present and an intact walk: adopt, at the walk\'s tail position', () => {
    const walk = intact({ prunedThrough: 2, tail: 9, probe: null });
    expect(settleCheckpointMode(absent, { filesPresent: true, tailDigest: hex('d'), walk })).toEqual({
      mode: 'adopt',
      position: 9
    });
    expect(settleCheckpointMode(retired(), { filesPresent: true, tailDigest: hex('d'), walk })).toEqual({
      mode: 'adopt',
      position: 9
    });
  });

  it('active, and the head is the tail: track, at the checkpoint\'s own position, with no walk needed', () => {
    expect(
      settleCheckpointMode(active({ position: 5 }), { filesPresent: true, tailDigest: hex('b'), walk: null })
    ).toEqual({ mode: 'track', position: 5 });
  });

  it('active, and the head is found behind the tail (a crash before an advance): track, at the walk\'s tail', () => {
    expect(
      settleCheckpointMode(active({ position: 5 }), {
        filesPresent: true,
        tailDigest: hex('d'),
        walk: found(5, { tail: 7 })
      })
    ).toEqual({ mode: 'track', position: 7 });
  });

  it('active, and the head was legitimately pruned: track', () => {
    expect(
      settleCheckpointMode(active({ position: 5 }), {
        filesPresent: true,
        tailDigest: hex('d'),
        walk: found(null, { prunedThrough: 6, tail: 9 })
      })
    ).toEqual({ mode: 'track', position: 9 });
  });

  it('active, and the head is neither found nor pruned by an intact walk: loss', () => {
    expect(
      settleCheckpointMode(active({ position: 5 }), {
        filesPresent: true,
        tailDigest: hex('d'),
        walk: found(null, { tail: 3 })
      }).mode
    ).toBe('loss');
  });

  it('active, and no chain file at all: loss (the history is missing)', () => {
    expect(
      settleCheckpointMode(active(), { filesPresent: false, tailDigest: null, walk: null }).mode
    ).toBe('loss');
  });

  it('retired and no chain files: reset', () => {
    expect(settleCheckpointMode(retired(), { filesPresent: false, tailDigest: null, walk: null })).toEqual({
      mode: 'reset',
      position: 0
    });
  });

  it.each(['corrupt', 'version-unknown', 'unreachable'] as const)(
    'an unreadable checkpoint (%s) is off, whatever the chain holds',
    (reason) => {
      const read: CheckpointRead = { status: 'unreadable', reason };
      expect(settleCheckpointMode(read, { filesPresent: false, tailDigest: null, walk: null }).mode).toBe('off');
      expect(
        settleCheckpointMode(read, {
          filesPresent: true,
          tailDigest: hex('d'),
          walk: intact({ prunedThrough: 0, tail: 4, probe: null })
        }).mode
      ).toBe('off');
    }
  );

  it('a walk that is not intact is off for an absent, a retired and an active checkpoint alike', () => {
    const facts = { filesPresent: true, tailDigest: hex('d'), walk: broken() };
    expect(settleCheckpointMode(absent, facts).mode).toBe('off');
    expect(settleCheckpointMode(retired(), facts).mode).toBe('off');
    expect(settleCheckpointMode(active(), facts).mode).toBe('off');
  });
});
