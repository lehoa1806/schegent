import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionArtifactRetentionService } from '../../../../src/services/session-retention/session-artifact-retention-service';
import { cleanupSessionArtifacts } from '../../../../src/services/session-cleanup/session-cleanup-service';

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

// FR-R4-F15 (feature 243, contract K2, K6.7, L5.2; clarification Q1) — the failure-record pass runs
// INSIDE the sweep's serialized chain, after the session pass, and changes nothing the sweep reports.
//
// One window's sweeps are chained on `sweepTail`, so a second sweep starts only after the first has
// finished; the record pass is part of the first, so the second's session pass starts after the first's
// record pass has ended. A pass that throws is one warning and the session result. And the audit event
// that already existed, `session-retention-applied`, is deep-equal with and without the pass, because
// the spec gives the audit log no new field.
describe('the failure-record pass inside the sweep (FR-R4-F15, K2, K6.7)', () => {
  let workspaceRoot: string;
  const now = new Date('2026-08-01T00:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-retention-records-'));
    await fs.mkdir(path.join(workspaceRoot, '.schegent', 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function build(options: {
    readonly failureRecords?: { sweep(maxAgeMs: number, now: Date): Promise<unknown> };
    readonly events?: string[];
    readonly root?: string;
  }) {
    const warn = vi.fn();
    const append = vi.fn();
    const events = options.events ?? [];
    const service = new SessionArtifactRetentionService({
      workspaceRoot: options.root ?? workspaceRoot,
      now: () => now,
      policy: () => ({ maxAgeMs: 30 * DAY_MS, maxBytes: 1024 * 1024 }),
      logger: { warn },
      audit: { append } as never,
      // The session pass lists its root exactly once per sweep, so this marks where it starts.
      filesystem: {
        readdir: (target, readdirOptions) => {
          events.push('session:start');
          return fs.readdir(target, readdirOptions);
        },
        lstat: (target) => fs.lstat(target),
        realpath: (target) => fs.realpath(target),
        rm: (target, rmOptions) => fs.rm(target, rmOptions)
      },
      ...(options.failureRecords === undefined ? {} : { failureRecords: options.failureRecords })
    });
    return { service, warn, append, events };
  }

  async function seedExpiredRun(root: string): Promise<void> {
    const sessions = path.join(root, '.schegent', 'sessions');
    await fs.mkdir(path.join(sessions, 'old-run'), { recursive: true });
    await fs.writeFile(path.join(sessions, 'old-run', 'stream.jsonl'), 'x');
    const old = new Date(now.getTime() - 40 * DAY_MS);
    await fs.utimes(path.join(sessions, 'old-run', 'stream.jsonl'), old, old);
    await fs.utimes(path.join(sessions, 'old-run'), old, old);
  }

  it('runs the record pass after the session pass, with the normalized age and the sweep\'s clock', async () => {
    const events: string[] = [];
    const sweep = vi.fn(async (_maxAgeMs: number, _at: Date) => {
      events.push('records:sweep');
    });
    const { service } = build({ failureRecords: { sweep }, events });

    await service.sweep();

    expect(events).toEqual(['session:start', 'records:sweep']);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(30 * DAY_MS, now);
  });

  it('starts the second sweep\'s session pass only after the first sweep\'s record pass has ended', async () => {
    const events: string[] = [];
    let markFirstEnteredRecords: () => void = () => undefined;
    const firstEnteredRecords = new Promise<void>((resolve) => {
      markFirstEnteredRecords = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let passes = 0;
    const sweep = vi.fn(async () => {
      passes += 1;
      events.push(`records:start:${passes}`);
      if (passes === 1) {
        markFirstEnteredRecords();
        await gate;
      }
      events.push(`records:end:${passes}`);
    });
    const { service } = build({ failureRecords: { sweep }, events });

    const first = service.sweep();
    const second = service.sweep();
    // Wait deterministically until the first sweep is blocked in its record pass, then flush
    // microtasks/immediates to prove the second sweep has not started its session pass.
    await firstEnteredRecords;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['session:start', 'records:start:1']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'session:start',
      'records:start:1',
      'records:end:1',
      'session:start',
      'records:start:2',
      'records:end:2'
    ]);
  });

  it.each([
    ['rejects', async () => { throw Object.assign(new Error('secret /Users/someone/path'), { code: 'EACCES' }); }],
    ['throws synchronously', () => { throw Object.assign(new Error('secret /Users/someone/path'), { code: 'EACCES' }); }]
  ] as const)('a pass that %s is one warning by code, and the session result is still returned', async (_label, sweep) => {
    await seedExpiredRun(workspaceRoot);
    const { service, warn } = build({ failureRecords: { sweep: sweep as never } });

    const result = await service.sweep();

    expect(result.removedArtifactCount).toBe(1);
    const passWarnings = warn.mock.calls.filter((call) => call[0] === 'failure-record-retention: pass failed');
    expect(passWarnings).toHaveLength(1);
    expect(passWarnings[0]?.[1]).toEqual({ errorCode: 'EACCES' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/someone');
    expect(service.getUsage()).toEqual(result);
  });

  it('keeps the audit event, the result and the usage deep-equal to the same sweep without the pass (L5.2)', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-retention-records-bare-'));
    try {
      await fs.mkdir(path.join(other, '.schegent', 'sessions'), { recursive: true });
      await seedExpiredRun(workspaceRoot);
      await seedExpiredRun(other);
      const withPass = build({ failureRecords: { sweep: vi.fn(async () => ({ removed: 3, failures: 1 })) } });
      const without = build({ root: other });

      const resultWith = await withPass.service.sweep();
      const resultWithout = await without.service.sweep();

      expect(withPass.append).toHaveBeenCalledTimes(1);
      expect(without.append).toHaveBeenCalledTimes(1);
      expect(withPass.append.mock.calls[0]?.[0]).toEqual(without.append.mock.calls[0]?.[0]);
      expect(resultWith).toEqual(resultWithout);
      expect(withPass.service.getUsage()).toEqual(without.service.getUsage());
      // The pass's own figures never reach any of the three.
      expect(JSON.stringify([withPass.append.mock.calls, resultWith])).not.toContain('"removed":3');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('behaves exactly as before with no pass at all', async () => {
    await seedExpiredRun(workspaceRoot);
    const { service, warn } = build({});
    const result = await service.sweep();
    expect(result.removedArtifactCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('FR-R7-11 (FR-020) — protected database path guards in session retention and session cleanup', () => {
  let workspaceRoot: string;
  const now = new Date('2026-08-01T00:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-prot-sess-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function seedOldRun(runId: string): Promise<string> {
    const runDir = path.join(workspaceRoot, '.schegent', 'sessions', runId);
    await fs.mkdir(runDir, { recursive: true });
    const file = path.join(runDir, 'stream.jsonl');
    await fs.writeFile(file, 'x'.repeat(128));
    const old = new Date(now.getTime() - 60 * DAY_MS);
    await fs.utimes(file, old, old);
    await fs.utimes(runDir, old, old);
    return runDir;
  }

  it('SessionArtifactRetentionService refuses deleting canonical, fallback, sidecar, and preserved unselected protected paths', async () => {
    const canonicalDir = await seedOldRun('run-canonical');
    const fallbackDir = await seedOldRun('run-fallback');
    const sidecarDir = await seedOldRun('run-sidecar');
    const preservedDir = await seedOldRun('run-preserved');
    const disposableDir = await seedOldRun('run-disposable');

    const protectedList = [
      path.join(canonicalDir, 'schegent-state.db'),
      path.join(fallbackDir, 'schegent-state.db'),
      path.join(sidecarDir, 'schegent-state.db-shm'),
      path.join(preservedDir, 'schegent-state.unselected-123456789abc.db')
    ];

    const warn = vi.fn();
    const svc = new SessionArtifactRetentionService({
      workspaceRoot,
      now: () => now,
      policy: () => ({ maxAgeMs: 1 * DAY_MS, maxBytes: 1 }),
      logger: { warn },
      protectedPaths: () => protectedList
    });

    const result = await svc.sweep();
    expect(result.removedArtifactCount).toBe(1);
    expect(result.lastSweepFailures).toBe(4);
    await expect(fs.access(canonicalDir)).resolves.toBeUndefined();
    await expect(fs.access(fallbackDir)).resolves.toBeUndefined();
    await expect(fs.access(sidecarDir)).resolves.toBeUndefined();
    await expect(fs.access(preservedDir)).resolves.toBeUndefined();
    await expect(fs.access(disposableDir)).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledWith('session-retention: remove-artifact refused', {
      reason: 'protected-path'
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(workspaceRoot);
  });

  it('cleanupSessionArtifacts refuses deleting targets overlapping protected database paths', async () => {
    const runId = 'run-protected-cleanup';
    const sessionDir = await seedOldRun(runId);
    const rawLog = path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
    await fs.writeFile(rawLog, 'raw-data');

    const warn = vi.fn();
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger: { warn },
      protectedPaths: () => [
        path.join(sessionDir, 'schegent-state.db'),
        path.join(sessionDir, 'schegent-state.db-wal')
      ]
    });

    expect(outcome.cleaned).toBe(false);
    expect(outcome.refusal).toBe('not-contained');
    // Protected session directory must remain intact
    await expect(fs.access(sessionDir)).resolves.toBeUndefined();
    // Unprotected raw transcript sibling was still cleaned up
    await expect(fs.access(rawLog)).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(workspaceRoot);
  });

  it('fails closed on unresolvable protected paths (ELOOP) and enforces case-variant protection in retention and cleanup', async () => {
    const runId = 'run-case-and-eloop';
    const sessionDir = await seedOldRun(runId);
    const loopA = path.join(workspaceRoot, 'prot-loop-a');
    const loopB = path.join(workspaceRoot, 'prot-loop-b');
    await fs.symlink(loopB, loopA);
    await fs.symlink(loopA, loopB);
    const unresolvableProtected = path.join(loopA, 'schegent-state.db');

    const svcLoop = new SessionArtifactRetentionService({
      workspaceRoot,
      now: () => now,
      policy: () => ({ maxAgeMs: 1 * DAY_MS, maxBytes: 1 }),
      logger: { warn: vi.fn() },
      protectedPaths: () => [unresolvableProtected]
    });
    const loopRes = await svcLoop.sweep();
    expect(loopRes.removedArtifactCount).toBe(0);
    expect(loopRes.lastSweepFailures).toBe(1);
    await expect(fs.access(sessionDir)).resolves.toBeUndefined();

    const cleanupLoop = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger: { warn: vi.fn() },
      protectedPaths: () => [unresolvableProtected]
    });
    expect(cleanupLoop.cleaned).toBe(false);
    expect(cleanupLoop.refusal).toBe('not-contained');
    await expect(fs.access(sessionDir)).resolves.toBeUndefined();

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const upperProtected = path.join(sessionDir, 'SCHEGENT-STATE.DB').toUpperCase();
      const svcCase = new SessionArtifactRetentionService({
        workspaceRoot,
        now: () => now,
        policy: () => ({ maxAgeMs: 1 * DAY_MS, maxBytes: 1 }),
        logger: { warn: vi.fn() },
        protectedPaths: () => [upperProtected]
      });
      const caseRes = await svcCase.sweep();
      expect(caseRes.removedArtifactCount).toBe(0);
      expect(caseRes.lastSweepFailures).toBe(1);
      await expect(fs.access(sessionDir)).resolves.toBeUndefined();

      const cleanupCase = await cleanupSessionArtifacts({
        workspaceRoot,
        runId,
        logger: { warn: vi.fn() },
        protectedPaths: () => [upperProtected]
      });
      expect(cleanupCase.cleaned).toBe(false);
      expect(cleanupCase.refusal).toBe('not-contained');
      await expect(fs.access(sessionDir)).resolves.toBeUndefined();
    }
  });
});
