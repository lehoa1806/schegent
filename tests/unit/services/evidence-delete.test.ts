// FR-R3-085 — delete refuses rather than races, and reports both halves.
import { promises as fsp, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteRunEvidence } from '../../../src/services/evidence-delete';
import { SanitizedLogger } from '../../../src/lib/logger';
import { createFailureRecorder } from '../../../src/services/failure-record/failure-record-service';

const RUN = '5b8a1c22-7d3e-4f10-9c44-1a2b3c4d5e6f';
const idle = { isRunActive: () => false };
const busy = { isRunActive: () => true };

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'evidence-delete-ws-'));
  await fsp.mkdir(path.join(workspace, '.schegent', 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', `raw-${RUN}.log`), 'transcript\n');
  await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', `raw-other.log`), 'another run\n');
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe('FR-R3-085 — evidence delete', () => {
  it('removes this run and reports what it removed', async () => {
    const result = await deleteRunEvidence(workspace, RUN, idle);
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.removed.some((entry) => entry.includes(RUN))).toBe(true);
    expect(result.retained).toEqual([]);
  });

  it("leaves another run's evidence alone", async () => {
    await deleteRunEvidence(workspace, RUN, idle);
    const remaining = await fsp.readdir(path.join(workspace, '.schegent', 'sessions'));
    expect(remaining).toContain('raw-other.log');
    expect(remaining).not.toContain(`raw-${RUN}.log`);
  });

  it('REFUSES while the run is still executing, and says so', async () => {
    // Racing a live writer leaves a half-deleted Run and a file that reappears a
    // second later. Refusing leaves an operator who knows to stop the Run first.
    const result = await deleteRunEvidence(workspace, RUN, busy);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('active-writer');
    expect(result.artifact).toContain(RUN);
    // ...and nothing was removed.
    const remaining = await fsp.readdir(path.join(workspace, '.schegent', 'sessions'));
    expect(remaining).toContain(`raw-${RUN}.log`);
  });

  it('REFUSES when a spool entry for this run is mid-write, and NAMES that artifact', async () => {
    // "Something is still being written" is not actionable; the artifact is.
    await fsp.mkdir(path.join(workspace, '.schegent', 'sessions', '.pending'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', '.pending', `raw-${RUN}.log`), 'mid\n');
    const result = await deleteRunEvidence(workspace, RUN, idle);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('active-writer');
    expect(result.artifact).toContain('.pending');
    expect(result.artifact).toContain(RUN);
  });

  it('NON-VACUITY: clearing the spool entry lets the same delete complete', async () => {
    const pending = path.join(workspace, '.schegent', 'sessions', '.pending');
    await fsp.mkdir(pending, { recursive: true });
    const marker = path.join(pending, `raw-${RUN}.log`);
    await fsp.writeFile(marker, 'mid\n');
    expect((await deleteRunEvidence(workspace, RUN, idle)).outcome).toBe('refused');
    await fsp.rm(marker);
    expect((await deleteRunEvidence(workspace, RUN, idle)).outcome).toBe('completed');
  });

  it('reports what it could NOT remove rather than reporting silent success', async () => {
    // A partial delete that reports success is how an operator comes to believe
    // evidence is gone when it is not — the worst outcome available to a privacy
    // control. FR-R4-F04 (TA8): this was simulated by making the leaf an (empty) directory, which `rm`
    // without `recursive` refused with ERR_EISDIR; emptied directories are removed now, so the
    // simulation is a directory the owner cannot write into, which no removal can empty.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = path.join(workspace, '.schegent', 'sessions', `dir-${RUN}`);
    await fsp.mkdir(locked, { recursive: true });
    await fsp.writeFile(path.join(locked, 'inside.log'), 'x\n');
    await fsp.chmod(locked, 0o500);
    try {
      const result = await deleteRunEvidence(workspace, RUN, idle);
      expect(result.outcome).toBe('completed');
      if (result.outcome !== 'completed') throw new Error('unreachable');
      expect(result.removed.length).toBeGreaterThan(0);
      expect(result.retained.length).toBeGreaterThan(0);
      for (const entry of result.retained) expect(entry.reason.length).toBeGreaterThan(2);
    } finally {
      await fsp.chmod(locked, 0o700);
    }
  });

  it('refuses when the run has no evidence at all', async () => {
    const result = await deleteRunEvidence(workspace, '00000000-0000-4000-8000-000000000000', idle);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('no-evidence');
  });

  it('SECURITY: refuses a degenerate run id rather than matching by substring', async () => {
    // The same boundary, and the worse direction: an unvalidated id here removes
    // every Run's evidence instead of one Run's.
    for (const bad of ['.', '', 'log', 'raw', '../../etc']) {
      const result = await deleteRunEvidence(workspace, bad, idle);
      expect(result.outcome, `run id ${JSON.stringify(bad)} must be refused`).toBe('refused');
      if (result.outcome !== 'refused') throw new Error('unreachable');
      expect(result.reason).toBe('invalid-run-id');
    }
    // ...and nothing was removed by any of those calls.
    const remaining = await fsp.readdir(path.join(workspace, '.schegent', 'sessions'));
    expect(remaining).toContain(`raw-${RUN}.log`);
    expect(remaining).toContain('raw-other.log');
  });
});

// FR-R4-F15 (feature 243, contract K4, K6.9; FR-017, D14) — Delete Evidence removes one Run's failure
// records and no other Run's, and refuses while the Run is active. No code selects them: the command
// removes every leaf under `.schegent/` whose path contains the Run id, and a record's name carries it.
describe('FR-R4-F15 K6.9 — Delete Evidence removes one Run\'s failure records', () => {
  const RUN_B = '9b2e5f10-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
  const TASK_A = '11111111-1111-4111-8111-111111111111';
  const TASK_B = '22222222-2222-4222-8222-222222222222';
  const recordsDir = (): string => path.join(workspace, '.schegent', 'failure-records');

  async function writeRecord(runId: string, taskId: string, summary: string): Promise<void> {
    const recorder = createFailureRecorder({
      logger: new SanitizedLogger(),
      queue: { queueIdForExistingTask: () => 'default' },
      workspaceRoot: workspace
    });
    const wrote = await recorder.record({
      run: { id: runId, featureId: taskId, currentPhase: 'implement' },
      cause: 'last_phase_issues_remain',
      result: { kind: 'remaining_issues', issues: [{ tag: 'regression', summary }], auditEntry: null }
    });
    expect(wrote).toBe(true);
  }

  beforeEach(async () => {
    await writeRecord(RUN, TASK_A, 'run A first');
    await writeRecord(RUN, TASK_A, 'run A second');
    await writeRecord(RUN_B, TASK_B, 'run B only');
  });

  it('removes exactly Run A\'s two records, and reports them', async () => {
    expect(await fsp.readdir(recordsDir())).toHaveLength(3);

    const result = await deleteRunEvidence(workspace, RUN, idle);

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.removed.filter((entry) => entry.includes('failure-records/'))).toHaveLength(2);
    expect(result.retained).toEqual([]);
    const remaining = await fsp.readdir(recordsDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain(`_${RUN_B}_`);
  });

  it('leaves Run B\'s record alone when Run B is deleted second', async () => {
    await deleteRunEvidence(workspace, RUN, idle);
    const second = await deleteRunEvidence(workspace, RUN_B, idle);
    expect(second.outcome).toBe('completed');
    expect(await fsp.readdir(recordsDir())).toEqual([]);
  });

  it('refuses while Run A is active, and removes nothing, records included', async () => {
    const before = (await fsp.readdir(recordsDir())).sort();

    const result = await deleteRunEvidence(workspace, RUN, busy);

    expect(result).toMatchObject({ outcome: 'refused', reason: 'active-writer' });
    expect((await fsp.readdir(recordsDir())).sort()).toEqual(before);
    expect(await fsp.readdir(path.join(workspace, '.schegent', 'sessions'))).toContain(`raw-${RUN}.log`);
  });
});


// FR-R4-F04 (feature 251, contract T7; SC-004, SC-005, FR-010 to FR-013) — deletion removes the
// directories it names, the Run's private checkpoint, keeps Run history, and lists every kept store.
//
// What it pins: nested diagnostics and their emptied directories go (the filing's finding was that the
// non-recursive `rm` left every one of them with ERR_EISDIR), the Run's checkpoint under private storage
// goes with them, a sibling Run's files and every audit byte are identical before and after, an active
// Run or a spool entry removes nothing (the checkpoint included), a link or an unwritable directory is
// retained with its reason, `.schegent/history/<runId>.txt` stays and is said to, and the kept stores are
// listed, the legacy transport with the date it ages out exactly when one exists.
describe('FR-R4-F04 T7 — deletion removes directories and the checkpoint, and names what it keeps', () => {
  const OTHER = '9b2e5f10-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
  const posixOnly = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;
  const sessions = (): string => path.join(workspace, '.schegent', 'sessions');
  let storage: string;

  const checkpointDir = (runId: string): string => path.join(storage, 'checkpoints', runId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const exists = async (target: string): Promise<boolean> =>
    fsp.lstat(target).then(
      () => true,
      () => false
    );

  async function seedNested(runId: string): Promise<void> {
    const iteration = path.join(sessions(), runId, 'diagnostics', 'pipe', 'phase', 'iter-1');
    await fsp.mkdir(iteration, { recursive: true });
    await fsp.writeFile(path.join(iteration, 'stream.jsonl'), '{"a":1}\n');
    await fsp.writeFile(path.join(iteration, 'debug.json'), '{}\n');
    await fsp.writeFile(path.join(sessions(), runId, 'transport.log'), 'a transport record\n');
  }

  async function seedCheckpoint(runId: string): Promise<void> {
    await fsp.mkdir(checkpointDir(runId), { recursive: true });
    await fsp.writeFile(path.join(checkpointDir(runId), '1-implement.patch'), 'diff --git a b\n');
    await fsp.writeFile(path.join(checkpointDir(runId), '1-implement.json'), '{}\n');
  }

  const deps = (extra: Partial<Parameters<typeof deleteRunEvidence>[2]> = {}): Parameters<typeof deleteRunEvidence>[2] => ({
    isRunActive: () => false,
    checkpointRoot: storage,
    legacyAgesOutBy: () => null,
    ...extra
  });

  beforeEach(async () => {
    storage = mkdtempSync(path.join(tmpdir(), 'evidence-delete-storage-'));
  });

  afterEach(async () => {
    await fsp.rm(storage, { recursive: true, force: true });
  });

  it('removes nested diagnostics, emptied directories and the private checkpoint, with no retained directory', async () => {
    await seedNested(RUN);
    await seedCheckpoint(RUN);

    const result = await deleteRunEvidence(workspace, RUN, deps());

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.retained.filter((entry) => entry.reason !== 'run-history')).toEqual([]);
    expect(result.checkpoint).toBe('removed');
    expect(await exists(path.join(sessions(), RUN)), 'the session directory is gone, not ERR_EISDIR').toBe(false);
    expect(await exists(checkpointDir(RUN)), 'the private checkpoint is gone').toBe(false);
    expect(result.removed).toContain(path.posix.join('.schegent', 'sessions', RUN));
    // The control: the raw transcript beside them was removed too, so this is the whole Run.
    expect(await exists(path.join(sessions(), `raw-${RUN}.log`))).toBe(false);
  });

  it("leaves a sibling Run's files and every audit.log byte identical", async () => {
    await seedNested(RUN);
    await seedNested(OTHER);
    await seedCheckpoint(OTHER);
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log'), 'chain-bytes\n');
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log.20260101T000000.000Z'), 'older chain\n');
    const before = new Map<string, string>();
    for (const rel of [
      ['sessions', OTHER, 'transport.log'],
      ['sessions', OTHER, 'diagnostics', 'pipe', 'phase', 'iter-1', 'stream.jsonl'],
      ['audit.log'],
      ['audit.log.20260101T000000.000Z']
    ]) {
      const file = path.join(workspace, '.schegent', ...rel);
      before.set(file, await fsp.readFile(file, 'utf8'));
    }

    await deleteRunEvidence(workspace, RUN, deps());

    for (const [file, content] of before) expect(await fsp.readFile(file, 'utf8'), file).toBe(content);
    expect(await exists(checkpointDir(OTHER)), "the other Run's checkpoint is untouched").toBe(true);
  });

  it.each([
    ['an active Run', () => deps({ isRunActive: () => true })],
    ['a mid-write spool entry', () => deps()]
  ])('removes nothing, the checkpoint included, for %s', async (label, makeDeps) => {
    await seedNested(RUN);
    await seedCheckpoint(RUN);
    if (label === 'a mid-write spool entry') {
      await fsp.mkdir(path.join(sessions(), '.pending'), { recursive: true });
      await fsp.writeFile(path.join(sessions(), '.pending', `raw-${RUN}.log`), 'mid\n');
    }

    const result = await deleteRunEvidence(workspace, RUN, makeDeps());

    expect(result.outcome).toBe('refused');
    expect(await exists(checkpointDir(RUN)), 'a refusal removes no checkpoint').toBe(true);
    expect(await exists(path.join(sessions(), RUN, 'transport.log'))).toBe(true);
  });

  it('refuses on a lock marker, and the checkpoint stays', async () => {
    await seedCheckpoint(RUN);
    await fsp.writeFile(path.join(sessions(), `${RUN}.lock`), 'held\n');

    expect((await deleteRunEvidence(workspace, RUN, deps())).outcome).toBe('refused');
    expect(await exists(checkpointDir(RUN))).toBe(true);
  });

  posixOnly('retains a symlinked checkpoint as `symlink`, and never follows it', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'evidence-delete-outside-'));
    try {
      await fsp.writeFile(path.join(outside, 'keep.txt'), 'not evidence\n');
      await fsp.mkdir(path.join(storage, 'checkpoints'), { recursive: true });
      await fsp.symlink(outside, checkpointDir(RUN));

      const result = await deleteRunEvidence(workspace, RUN, deps());

      expect(result.outcome).toBe('completed');
      if (result.outcome !== 'completed') throw new Error('unreachable');
      expect(result.checkpoint).toBe('retained');
      expect(result.retained.some((entry) => entry.reason === 'symlink')).toBe(true);
      expect(await fsp.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'the link target is untouched').toBe('not evidence\n');
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  posixOnly('retains an unwritable directory with its errno code and the directory above it as not-empty', async () => {
    const locked = path.join(sessions(), RUN);
    await fsp.mkdir(locked, { recursive: true });
    await fsp.writeFile(path.join(locked, 'inside.log'), 'x\n');
    await fsp.chmod(locked, 0o500);
    try {
      const result = await deleteRunEvidence(workspace, RUN, deps());

      expect(result.outcome).toBe('completed');
      if (result.outcome !== 'completed') throw new Error('unreachable');
      const reasons = Object.fromEntries(result.retained.map((entry) => [entry.path, entry.reason]));
      expect(reasons[path.posix.join('.schegent', 'sessions', RUN, 'inside.log')]).toMatch(/^errno:E(ACCES|PERM)$/);
      expect(reasons[path.posix.join('.schegent', 'sessions', RUN)]).toBe('not-empty');
    } finally {
      await fsp.chmod(locked, 0o700);
    }
  });

  it('keeps Run history: the description is not a target, and is reported as run-history', async () => {
    await seedNested(RUN);
    const history = path.join(workspace, '.schegent', 'history');
    await fsp.mkdir(history, { recursive: true });
    await fsp.writeFile(path.join(history, `${RUN}.txt`), 'the full description\n');

    const result = await deleteRunEvidence(workspace, RUN, deps());

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.retained).toContainEqual({ path: path.posix.join('.schegent', 'history', `${RUN}.txt`), reason: 'run-history' });
    expect(await fsp.readFile(path.join(history, `${RUN}.txt`), 'utf8')).toBe('the full description\n');
  });

  it('lists the kept stores, and the legacy transport with its date exactly when one exists', async () => {
    await seedNested(RUN);
    const without = await deleteRunEvidence(workspace, RUN, deps({ legacyAgesOutBy: () => null }));
    expect(without.outcome).toBe('completed');
    if (without.outcome !== 'completed') throw new Error('unreachable');
    expect(without.keptStores.map((kept) => kept.store)).toEqual(['audit-log', 'runtime-log', 'metrics-rollup', 'run-history']);

    await seedNested(RUN);
    const aged = '2026-12-01T00:00:00.000Z';
    const withLegacy = await deleteRunEvidence(workspace, RUN, deps({ legacyAgesOutBy: () => aged }));
    expect(withLegacy.outcome).toBe('completed');
    if (withLegacy.outcome !== 'completed') throw new Error('unreachable');
    expect(withLegacy.keptStores).toContainEqual({ store: 'legacy-transport', agesOutBy: aged });
    expect(withLegacy.keptStores).toHaveLength(5);
  });

  it('reports the checkpoint as absent when the Run never took one', async () => {
    await seedNested(RUN);
    const result = await deleteRunEvidence(workspace, RUN, deps());
    expect(result.outcome === 'completed' && result.checkpoint).toBe('absent');
  });

  it('works for a caller that passes no private storage, and reports no checkpoint step', async () => {
    const result = await deleteRunEvidence(workspace, RUN, idle);
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.checkpoint).toBe('absent');
  });
});
