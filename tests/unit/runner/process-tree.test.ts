import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  processTreeSpawnOptions,
  signalProcessTree,
  processTreeIsGone
} from '../../../src/runner/process-tree';

/**
 * FR-R3-054 (H-05) — the escalation ladder signalled the direct child only.
 *
 * A CLI tool that forks a helper survives cancel, timeout, aggressive pause and
 * deactivation, and keeps mutating the workspace after Schegent has recorded a
 * terminal state -- racing rollback, retry, recovery and the next phase.
 *
 * The oracle is a sentinel file a GRANDCHILD appends to on a timer. If it keeps
 * growing after the direct child is signalled, the descendant is alive. Nothing
 * about that is inferred: the bytes are on disk or they are not.
 */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('signalling the process tree (H-05)', () => {
  let dir: string;
  let sentinel: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-tree-'));
    sentinel = path.join(dir, 'sentinel');
    await fs.writeFile(sentinel, '');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A child that forks a grandchild appending to the sentinel every 25ms. */
  const spawnTree = (withGroup: boolean) =>
    spawn(
      '/bin/sh',
      ['-c', `( while true; do printf 'x' >> "${sentinel}"; sleep 0.025; done ) & sleep 60`],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, ...(withGroup ? processTreeSpawnOptions() : {}) }
    );

  const size = async (): Promise<number> => (await fs.stat(sentinel)).size;
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  posixOnly('killing only the direct child leaves the grandchild running', async () => {
    // The defect, demonstrated. This is what the ladder did before this change.
    const child = spawnTree(false);
    await settle(200);
    child.kill('SIGKILL');
    await settle(150);
    const afterKill = await size();
    await settle(250);
    expect(await size()).toBeGreaterThan(afterKill);
    // Clean up the survivor this test deliberately created.
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group may not exist without detached */
      }
    }
    await settle(50);
  }, 20_000);

  posixOnly('signalling the group stops the grandchild too', async () => {
    const child = spawnTree(true);
    await settle(200);
    expect(await size()).toBeGreaterThan(0);

    await signalProcessTree(child, 'SIGKILL');
    await settle(200);
    const afterKill = await size();
    await settle(300);
    expect(await size()).toBe(afterKill);
  }, 20_000);

  posixOnly('reports the tree gone only once it really is', async () => {
    const child = spawnTree(true);
    await settle(150);
    expect(processTreeIsGone(child)).toBe(false);
    await signalProcessTree(child, 'SIGKILL');
    await settle(250);
    expect(processTreeIsGone(child)).toBe(true);
  }, 20_000);

  it('asks for its own group only where that means something', () => {
    const options = processTreeSpawnOptions();
    expect(options.detached).toBe(process.platform !== 'win32');
  });
});
