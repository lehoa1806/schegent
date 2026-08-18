import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionArtifactRetentionService } from '../../../../src/services/session-retention/session-artifact-retention-service';

describe('SessionArtifactRetentionService', () => {
  let workspaceRoot: string;
  const now = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-retention-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function writeArtifacts(runId: string, bytes: number, ageDays: number): Promise<void> {
    const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
    const diagnostics = path.join(sessions, runId, 'diagnostics', 'p', 'q', 'iter-1');
    await fs.mkdir(diagnostics, { recursive: true });
    const raw = path.join(sessions, `raw-${runId}.log`);
    const stream = path.join(diagnostics, 'stream.jsonl');
    await fs.writeFile(raw, 'r'.repeat(bytes));
    await fs.writeFile(stream, 'd'.repeat(bytes));
    const stamp = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(raw, stamp, stamp);
    await fs.utimes(stream, stamp, stamp);
    await fs.utimes(path.join(sessions, runId), stamp, stamp);
    await fs.utimes(path.join(sessions, runId, 'diagnostics'), stamp, stamp);
    await fs.utimes(path.join(sessions, runId, 'diagnostics', 'p'), stamp, stamp);
    await fs.utimes(path.join(sessions, runId, 'diagnostics', 'p', 'q'), stamp, stamp);
    await fs.utimes(diagnostics, stamp, stamp);
  }

  function service(maxAgeDays: number, maxBytes: number, append = vi.fn()) {
    const warn = vi.fn();
    return {
      warn,
      append,
      value: new SessionArtifactRetentionService({
        workspaceRoot,
        now: () => now,
        policy: () => ({
          maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
          maxBytes
        }),
        logger: { warn },
        audit: { append } as never
      })
    };
  }

  it('removes expired inactive raw and diagnostic artifacts as one run group', async () => {
    await writeArtifacts('old-run', 32, 40);
    await writeArtifacts('fresh-run', 32, 1);
    const { value, append } = service(30, 1024 * 1024);

    const result = await value.sweep();

    expect(result.removedArtifactCount).toBe(1);
    expect(result.artifactCount).toBe(1);
    await expect(fs.access(path.join(workspaceRoot, '.schegent', 'sessions', 'raw-old-run.log')))
      .rejects.toBeDefined();
    await expect(fs.access(path.join(workspaceRoot, '.schegent', 'sessions', 'old-run')))
      .rejects.toBeDefined();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'session-retention-applied',
      payload: expect.not.objectContaining({ path: expect.anything(), runId: expect.anything() })
    }));
  });

  it('never prunes a protected active run even when age and byte limits are exceeded', async () => {
    await writeArtifacts('active-run', 128, 90);
    const { value } = service(1, 1);

    const result = await value.sweep(new Set(['active-run']));

    expect(result.removedArtifactCount).toBe(0);
    expect(result.protectedArtifactCount).toBe(1);
    await expect(fs.access(path.join(workspaceRoot, '.schegent', 'sessions', 'raw-active-run.log')))
      .resolves.toBeUndefined();
  });

  it('enforces the total-byte budget oldest-first and is idempotent', async () => {
    const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    const oldest = path.join(sessions, 'raw-oldest.log');
    const newest = path.join(sessions, 'raw-newest.log');
    await fs.writeFile(oldest, 'o'.repeat(128));
    await fs.writeFile(newest, 'n'.repeat(128));
    const oldestStamp = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const newestStamp = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await fs.utimes(oldest, oldestStamp, oldestStamp);
    await fs.utimes(newest, newestStamp, newestStamp);
    const { value } = service(365, 128);

    const first = await value.sweep();
    const second = await value.sweep();

    expect(first.removedArtifactCount).toBe(1);
    expect(second.removedArtifactCount).toBe(0);
    await expect(fs.access(path.join(workspaceRoot, '.schegent', 'sessions', 'raw-oldest.log')))
      .rejects.toBeDefined();
    await expect(fs.access(path.join(workspaceRoot, '.schegent', 'sessions', 'raw-newest.log')))
      .resolves.toBeUndefined();
  });

  it('contains filesystem failures and exposes only metadata in warnings', async () => {
    await writeArtifacts('failed-run', 32, 40);
    const base = service(1, 1);
    const failing = new SessionArtifactRetentionService({
      workspaceRoot,
      now: () => now,
      policy: () => ({ maxAgeMs: 1, maxBytes: 1 }),
      logger: { warn: base.warn },
      filesystem: {
        readdir: (target, options) => fs.readdir(target, options),
        lstat: (target) => fs.lstat(target),
        realpath: (target) => fs.realpath(target),
        rm: async () => {
          const error = new Error('secret path must not surface') as NodeJS.ErrnoException;
          error.code = 'ENOSPC';
          throw error;
        }
      }
    });

    const result = await failing.sweep();

    expect(result.lastSweepFailures).toBeGreaterThan(0);
    expect(base.warn).toHaveBeenCalled();
    expect(JSON.stringify(base.warn.mock.calls)).not.toContain('failed-run');
    expect(JSON.stringify(base.warn.mock.calls)).not.toContain(workspaceRoot);
    expect(JSON.stringify(base.warn.mock.calls)).toContain('ENOSPC');
  });
});

describe('SessionArtifactRetentionService — root containment (SEC-01)', () => {
  let workspaceRoot: string;
  let outside: string;
  const now = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-contain-ws-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-contain-out-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function service(warn = vi.fn(), append = vi.fn()) {
    return {
      warn,
      append,
      value: new SessionArtifactRetentionService({
        workspaceRoot,
        now: () => now,
        // Age 0 / bytes 0 makes every discovered group a removal candidate, so
        // a sweep that is not refused necessarily deletes.
        policy: () => ({ maxAgeMs: 0, maxBytes: 0 }),
        logger: { warn },
        audit: { append } as never
      })
    };
  }

  /** A run-shaped directory the sweep would delete if it ever reached it. */
  async function seedExternalArtifacts(root: string): Promise<string> {
    const victim = path.join(root, 'important-external-data');
    await fs.mkdir(victim, { recursive: true });
    await fs.writeFile(path.join(victim, 'payroll.csv'), 'do-not-delete');
    const stamp = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(victim, 'payroll.csv'), stamp, stamp);
    await fs.utimes(victim, stamp, stamp);
    return victim;
  }

  it('refuses to sweep when the sessions root itself is a symlink outside the workspace', async () => {
    const victim = await seedExternalArtifacts(outside);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent', 'sessions'), 'dir');

    const { value, warn } = service();
    const result = await value.sweep();

    expect(await fs.stat(victim)).toBeTruthy();
    expect(await fs.readFile(path.join(victim, 'payroll.csv'), 'utf8')).toBe('do-not-delete');
    expect(result.removedArtifactCount).toBe(0);
    expect(result.lastSweepFailures).toBeGreaterThan(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('root-not-contained');
  });

  it('refuses to sweep when an intermediate component is a symlink outside the workspace', async () => {
    const victim = await seedExternalArtifacts(path.join(outside, 'sessions'));
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    const { value, warn } = service();
    const result = await value.sweep();

    expect(await fs.stat(victim)).toBeTruthy();
    expect(result.removedArtifactCount).toBe(0);
    expect(result.lastSweepFailures).toBeGreaterThan(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('root-not-contained');
  });

  it('does not leak the refused path into the warning', async () => {
    await seedExternalArtifacts(outside);
    await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent', 'sessions'), 'dir');

    const { value, warn } = service();
    await value.sweep();

    expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(workspaceRoot);
  });

  it('still sweeps a real directory inside the workspace', async () => {
    const sessions = path.join(workspaceRoot, '.schegent', 'sessions');
    await fs.mkdir(path.join(sessions, 'run-a'), { recursive: true });
    await fs.writeFile(path.join(sessions, 'run-a', 'stream.jsonl'), 'x');

    const { value } = service();
    const result = await value.sweep();

    expect(result.removedArtifactCount).toBe(1);
    await expect(fs.stat(path.join(sessions, 'run-a'))).rejects.toThrow();
  });

  it('reports no failure when the sessions root does not exist yet', async () => {
    const { value } = service();
    const result = await value.sweep();
    expect(result.lastSweepFailures).toBe(0);
    expect(result.removedArtifactCount).toBe(0);
  });
});
