import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';

/**
 * FR-R4-F03 (FR-022; contract T4, W6, R9) — what an append failure is called, as the evidence-health
 * monitor records it.
 *
 * THE FINDING. A log the writer cannot open fails inside `openWithinRoot` with an errno, and the
 * failure handler used to read only `err.code`, which the wrapping `AuditPathRefusedError` does not
 * set. So a real `EACCES` reached health as `io-error`, and an operator told that the disk "failed"
 * went looking at the disk. The classification is now one pure table (`audit-write-failure.ts`).
 *
 * REAL FAULTS, STATED LIMITS. Permission refusal is a real `0400` log. No space and a short write
 * cannot be made real in a test, so they use the hoisted `fs/promises` seam of
 * `audit-append-ordering.test.ts`, re-created here, and every such case asserts the seam FIRED
 * (R20): a fault test that never injects its fault passes and proves nothing. The disk was never
 * actually full.
 *
 * ADMISSION. Whether health is `unavailable` is what Phase admission reads
 * (`isAuditEvidenceAvailable`, wired in `extension.ts`). `RunDriver` refusing a Run on a false
 * answer is pinned in `run-driver-failure-cause.test.ts` (C9); this file records the two answers
 * the audit sink gives (permission refused, no space) as separate cases.
 */

const seam = vi.hoisted(() => ({
  write: null as
    | null
    | ((n: number, write: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>),
  calls: 0
}));

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (!seam.write || !String(args[0]).endsWith('audit.log')) return handle;
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      return Object.assign(handle, {
        write: (...w: unknown[]) => seam.write?.(++seam.calls, write, w)
      });
    }
  };
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const admitsRuns = (monitor: EvidenceHealthMonitor): boolean =>
  monitor.getSnapshot().audit.status !== 'unavailable';

describe('audit write failures are classified by what they are (FR-022)', () => {
  let root: string;
  let monitor: EvidenceHealthMonitor;
  let writer: AuditLogWriter;
  const dir = (): string => path.join(root, '.schegent');
  const logFile = (): string => path.join(dir(), 'audit.log');
  const entry = (runId: string) =>
    ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;
  const cause = (): string | null => monitor.getSnapshot().audit.cause;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-fault-'));
    monitor = new EvidenceHealthMonitor();
    writer = new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([]), monitor);
  });

  afterEach(async () => {
    seam.write = null;
    seam.calls = 0;
    await fs.rm(root, { recursive: true, force: true });
  });

  const noSpace = (): void => {
    seam.write = async () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
  };

  const halfTheLine = (): void => {
    seam.write = async (n, write, args) => {
      if (n !== 1) return write(...args);
      const line = args[0] as string;
      return write(line.slice(0, Math.floor(line.length / 2)), null, 'utf8');
    };
  };

  it.skipIf(isRoot)('names a real permission refusal permission-denied, not io-error', async () => {
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(logFile(), '', { mode: 0o600 });
    await fs.chmod(logFile(), 0o400);

    await expect(writer.append(entry('refused'))).rejects.toThrow();

    expect(cause()).toBe('permission-denied');
  });

  it('names an ENOSPC from the write disk-full, and the seam fired', async () => {
    noSpace();

    await expect(writer.append(entry('full'))).rejects.toThrow();

    expect(seam.calls, 'the fault seam must have fired').toBeGreaterThanOrEqual(1);
    expect(cause()).toBe('disk-full');
  });

  it('names a short write partial-write, and the next append diagnoses a damaged tail', async () => {
    halfTheLine();

    await expect(writer.append(entry('torn'))).rejects.toThrow();

    expect(seam.calls, 'the fault seam must have fired').toBeGreaterThanOrEqual(1);
    expect(cause()).toBe('partial-write');

    const torn = await fs.readFile(logFile(), 'utf8');
    expect(torn.length, 'half a line really is on disk').toBeGreaterThan(0);
    expect(torn.endsWith('\n')).toBe(false);

    seam.write = null;
    await writer.append(entry('after'));

    const verdict = verifyAuditChainAt(dir())?.verdict;
    expect(verdict).toMatchObject({ ok: true, entries: 2 });
    expect(verdict?.ok === true ? verdict.damages : []).toHaveLength(1);
    expect(monitor.getSnapshot().audit.status, 'a landed row ends the write failure').toBe('healthy');
  });

  it('names a containment refusal path-refused', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-elsewhere-'));
    try {
      await fs.symlink(elsewhere, dir());

      await expect(writer.append(entry('linked'))).rejects.toThrow();

      expect(cause()).toBe('path-refused');
      expect(await fs.readdir(elsewhere), 'nothing was written through the link').toEqual([]);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  describe('Phase admission reads the sink', () => {
    it.skipIf(isRoot)('refuses admission after a permission refusal (recorded on its own)', async () => {
      await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
      await fs.writeFile(logFile(), '', { mode: 0o600 });
      await fs.chmod(logFile(), 0o400);

      await expect(writer.append(entry('refused'))).rejects.toThrow();

      expect(admitsRuns(monitor)).toBe(false);
    });

    it('refuses admission after no space (recorded on its own), and admits again once a row lands', async () => {
      noSpace();

      await expect(writer.append(entry('full'))).rejects.toThrow();

      expect(seam.calls, 'the fault seam must have fired').toBeGreaterThanOrEqual(1);
      expect(admitsRuns(monitor)).toBe(false);

      seam.write = null;
      await writer.append(entry('after'));
      expect(admitsRuns(monitor)).toBe(true);
    });
  });
});
