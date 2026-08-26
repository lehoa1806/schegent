// FR-R3-085 — delete refuses rather than races, and reports both halves.
import { promises as fsp, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteRunEvidence } from '../../../src/services/evidence-delete';

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
    // control. Simulated by making the leaf a directory, which `rm` without
    // `recursive` refuses.
    await fsp.mkdir(path.join(workspace, '.schegent', 'sessions', `dir-${RUN}.log`), { recursive: true });
    const result = await deleteRunEvidence(workspace, RUN, idle);
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('unreachable');
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.retained.length).toBeGreaterThan(0);
    for (const entry of result.retained) expect(entry.reason.length).toBeGreaterThan(2);
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
