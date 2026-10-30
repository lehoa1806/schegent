import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { AUDIT_CHAIN_GENESIS, digestOf, verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { EvidenceHealthMonitor } from '../../../src/services/evidence-health/evidence-health-monitor';
import type { AuditEntry } from '../../../src/audit/audit-entry';

/**
 * FR-R4-F03 (FR-005, FR-006, SC-002; contract T3) — a rejected append, with appends queued behind
 * it, never leaves a silent fork.
 *
 * THE DEFECT (the filing's U-12). `append` linked each row to the previous row's digest and advanced
 * that digest BEFORE the write was queued, so a rejected write was never rolled back and the next
 * row linked to bytes that never landed: the verifier reported a break at the first row after the
 * rejection although nothing was ever tampered with. Each row now links to the last row that landed,
 * computed inside the serialized step.
 *
 * REAL COMPONENTS. The rejection is a real `0400` log, restored to `0600`. The one case that needs a
 * rejection while appends are already queued behind it makes the SAME real refusal for exactly one
 * open, by flipping the real file's mode around that open through the hoisted `fs/promises` seam
 * (the shape of `audit-append-ordering.test.ts`): no error is invented and nothing is injected into
 * the writer. Health is the real `EvidenceHealthMonitor`, the chain is read by the real verifier.
 */

const seam = vi.hoisted(() => ({
  gate: null as null | ((n: number, run: () => Promise<unknown>) => Promise<unknown>),
  opens: 0
}));

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const { constants } = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      // Only an APPEND open of the audit log: reads, the cut file and the gitignore are not counted.
      const flags = args[1];
      const isAppend =
        String(args[0]).endsWith('audit.log') && typeof flags === 'number' && (flags & constants.O_APPEND) !== 0;
      if (!isAppend || !seam.gate) return real.open(...args);
      return seam.gate(++seam.opens, () => real.open(...args));
    }
  };
});

const NOTICE = 'audit append failed; structured evidence is unavailable';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('a rejected append never becomes the predecessor of a later row (SC-002)', () => {
  let root: string;
  let lines: string[];
  let monitor: EvidenceHealthMonitor;
  let writer: AuditLogWriter;
  const notified: AuditEntry[] = [];
  const dir = (): string => path.join(root, '.schegent');
  const logFile = (): string => path.join(dir(), 'audit.log');
  const entry = (runId: string) =>
    ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;
  const notices = (): number => lines.filter((line) => line.includes(NOTICE)).length;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-reject-'));
    lines = [];
    notified.length = 0;
    monitor = new EvidenceHealthMonitor();
    writer = new AuditLogWriter(
      { workspaceRoot: root },
      new SanitizedLogger([{ appendLine: (line: string) => lines.push(line) }]),
      monitor
    );
    writer.subscribe((e) => notified.push(e));
  });

  afterEach(async () => {
    seam.gate = null;
    seam.opens = 0;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function refuseTheLog(): Promise<void> {
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(logFile(), '', { mode: 0o600 });
    await fs.chmod(logFile(), 0o400);
  }

  const rawLines = async (): Promise<string[]> =>
    (await fs.readFile(logFile(), 'utf8')).split('\n').filter((line) => line.trim().length > 0);

  const lineObjects = async (): Promise<Array<Record<string, unknown>>> =>
    (await rawLines()).map((line) => JSON.parse(line) as Record<string, unknown>);

  it.skipIf(isRoot)('links the first landed row to genesis after the first append of a fresh log was rejected', async () => {
    await refuseTheLog();
    await expect(writer.append(entry('first'))).rejects.toThrow();
    expect(monitor.getSnapshot().audit.status).toBe('unavailable');

    await fs.chmod(logFile(), 0o600);
    await writer.append(entry('second'));

    const rows = await lineObjects();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prevDigest).toBe(AUDIT_CHAIN_GENESIS);
    expect(verifyAuditChainAt(dir())?.verdict).toMatchObject({ ok: true, entries: 1 });
  });

  it.skipIf(isRoot)('links each landed row to a landed row when a middle append is rejected with two queued behind it', async () => {
    seam.gate = async (n, run) => {
      if (n !== 2) return run();
      await fs.chmod(logFile(), 0o400);
      try {
        return await run();
      } finally {
        await fs.chmod(logFile(), 0o600);
      }
    };

    await writer.append(entry('run-a'));
    const outcomes = await Promise.allSettled([
      writer.append(entry('run-b')),
      writer.append(entry('run-c')),
      writer.append(entry('run-d'))
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(seam.opens, 'the gate saw all four append opens').toBeGreaterThanOrEqual(4);

    const rows = await lineObjects();
    expect(rows.map((row) => row.runId)).toEqual(['run-a', 'run-c', 'run-d']);
    const raw = await rawLines();
    expect(rows[1]?.prevDigest).toBe(digestOf(raw[0] as string));
    expect(rows[2]?.prevDigest).toBe(digestOf(raw[1] as string));
    expect(verifyAuditChainAt(dir())?.verdict).toMatchObject({ ok: true, entries: 3 });

    // One notice for the one rejected entry, and the rejected id is never written, now or later.
    expect(notices()).toBe(1);
    const rejected = notified.find((e) => e.runId === 'run-b');
    expect(rejected, 'a subscriber still hears of a rejected entry').toBeDefined();
    expect(await fs.readFile(logFile(), 'utf8')).not.toContain(rejected?.id as string);
  });

  it.skipIf(isRoot)('reports one notice per rejected entry when several are rejected', async () => {
    await refuseTheLog();
    for (const runId of ['one', 'two', 'three']) {
      await expect(writer.append(entry(runId))).rejects.toThrow();
    }
    expect(notices()).toBe(3);
  });

  it.skipIf(isRoot)('stays unavailable from a rejection until the next landed row, then is healthy', async () => {
    await writer.append(entry('before'));
    expect(monitor.getSnapshot().audit.status).toBe('healthy');

    await fs.chmod(logFile(), 0o400);
    await expect(writer.append(entry('rejected'))).rejects.toThrow();
    expect(monitor.getSnapshot().audit.status).toBe('unavailable');

    await fs.chmod(logFile(), 0o600);
    await writer.append(entry('after'));
    expect(monitor.getSnapshot().audit.status).toBe('healthy');
    expect(monitor.getSnapshot().audit.cause).toBeNull();
  });

  it.skipIf(isRoot)('does not let a landed row clear a broken link set before the rejection', async () => {
    await writer.append(entry('before'));
    writer.noteChainBreak('a break found by verification');
    expect(monitor.getSnapshot().audit.cause).toBe('chain-broken');

    await fs.chmod(logFile(), 0o400);
    await expect(writer.append(entry('rejected'))).rejects.toThrow();
    expect(monitor.getSnapshot().audit.status).toBe('unavailable');
    expect(monitor.getSnapshot().audit.cause, 'a write cause never replaces an integrity cause').toBe(
      'chain-broken'
    );

    await fs.chmod(logFile(), 0o600);
    await writer.append(entry('after'));
    expect(monitor.getSnapshot().audit.status, 'a landed row does not clear a broken link').toBe(
      'unavailable'
    );
    expect(monitor.getSnapshot().audit.cause).toBe('chain-broken');
  });
});
