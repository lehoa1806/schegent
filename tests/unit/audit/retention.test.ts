import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AUDIT_CHAIN_GENESIS,
  appendCutText,
  createAuditCutAccumulator,
  digestOf,
  finalizeAuditCutRecord,
  verifyAuditChainAt
} from '../../../src/audit/audit-chain';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { removeTempRoot } from '../../temp-root-cleanup';

describe('AuditLogWriter retention pruning', () => {
  let workspaceRoot: string;
  let logger: SanitizedLogger;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-retention-'));
    logger = new SanitizedLogger();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await removeTempRoot(workspaceRoot);
  });

  const appendRotating = async (writer: AuditLogWriter, count: number): Promise<void> => {
    const baseTimeMs = 1_750_000_000_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < count; i++) {
        const stamp = new Date(baseTimeMs + i * 1_000);
        vi.setSystemTime(stamp);
        await writer.append({
          runId: `r${i}`,
          phase: 'speckit-specify',
          iteration: 1,
          eventType: 'cli-invocation',
          payload: { i },
          outcome: 'info'
        });
        await fs.utimes(writer.logPath, stamp, stamp);
      }
    } finally {
      vi.useRealTimers();
    }
  };

  it('prunes archives beyond the retentionMaxArchives count', async () => {
    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 1, // force rotation on every append
        retentionMaxArchives: 2,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000
      },
      logger
    );
    await appendRotating(writer, 5);
    const dir = path.dirname(writer.logPath);
    const entries = await fs.readdir(dir);
    // FR-R3-112 — `audit.log.cuts` sits beside the archives and is not one: it is the record
    // of what the prune removed, so counting it as an archive would make this assertion
    // fail every time the prune worked.
    const archives = entries.filter((n) => n.startsWith('audit.log.') && n !== 'audit.log.cuts');
    expect(archives.length).toBeLessThanOrEqual(2);
  });

  it('FR-126a — a prune leaves a cut record naming the removed range', async () => {
    // The prune is the legitimate operation that looks most like tampering. Without this
    // record every routine retention pass would report a break, and the verifier would be
    // switched off within a week.
    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 1,
        retentionMaxArchives: 1,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000
      },
      logger
    );
    await appendRotating(writer, 4);
    const cuts = await fs.readFile(`${writer.logPath}.cuts`, 'utf8');
    const records = cuts
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.kind).toBe('audit-cut');
      // Both boundaries are real digests read off the deleted bytes, not placeholders.
      expect(record.removedFrom).toMatch(/^(genesis|[0-9a-f]{64})$/);
      expect(record.removedTo).toMatch(/^[0-9a-f]{64}$/);
      expect(record.removedCount as number).toBeGreaterThan(0);
    }
  });

  it('prunes archives older than retentionMaxArchiveAgeMs', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 1,
        retentionMaxArchives: 100,
        retentionMaxArchiveAgeMs: 50 // clamped internally to the 7-day compliance floor
      },
      logger
    );
    const dir = path.dirname(writer.logPath);
    await writer.append({
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info'
    });
    // Second append rotates r1 into the first archive.
    await writer.append({
      runId: 'r2',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info'
    });
    const beforePrune = (await fs.readdir(dir)).filter(
      (n) => n.startsWith('audit.log.') && n !== 'audit.log.cuts'
    );
    expect(beforePrune).toHaveLength(1);
    const agedArchive = beforePrune[0]!;
    // Backdate the first archive beyond the 7-day retention floor with fs.utimes instead of sleeping.
    const expiredStamp = new Date(Date.now() - 8 * DAY_MS);
    await fs.utimes(path.join(dir, agedArchive), expiredStamp, expiredStamp);

    // Third append rotates r2 into a fresh archive and prunes the expired first archive by age.
    await writer.append({
      runId: 'r3',
      phase: 'speckit-tasks',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info'
    });
    const entries = await fs.readdir(dir);
    const archives = entries.filter((n) => n.startsWith('audit.log.') && n !== 'audit.log.cuts');
    // The first archive was pruned by age; only the most recent archive remains.
    expect(archives).not.toContain(agedArchive);
    expect(archives.length).toBeLessThanOrEqual(1);
    expect(archives).toHaveLength(1);
  });

  it('FR-R5-F13 (FR-001) — prunes multiple archives in chronological (oldest-first) order so verifyAuditChainAt succeeds', async () => {
    const auditDir = path.join(workspaceRoot, '.schegent');
    await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
    const makeRow = (n: number, prevDigest: string): string =>
      JSON.stringify({
        id: `row-${n}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'phase-start',
        runId: 'r',
        payload: { phase: 'implement' },
        schemaVersion: 3,
        prevDigest,
        digestAlg: 'sha256'
      });
    const row1 = makeRow(1, AUDIT_CHAIN_GENESIS);
    const row2 = makeRow(2, digestOf(row1));
    const row3 = makeRow(3, digestOf(row2));
    const row4 = makeRow(4, digestOf(row3));
    const arch1 = path.join(auditDir, 'audit.log.20250101-000001-000-aaaaaaaa');
    const arch2 = path.join(auditDir, 'audit.log.20250101-000002-000-bbbbbbbb');
    const arch3 = path.join(auditDir, 'audit.log.20250101-000003-000-cccccccc');
    await fs.writeFile(arch1, `${row1}\n`, { mode: 0o600 });
    await fs.writeFile(arch2, `${row2}\n`, { mode: 0o600 });
    await fs.writeFile(arch3, `${row3}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(auditDir, 'audit.log'), `${row4}\n`, { mode: 0o600 });
    await fs.utimes(arch1, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
    await fs.utimes(arch2, new Date(1_700_000_002_000), new Date(1_700_000_002_000));
    await fs.utimes(arch3, new Date(), new Date());

    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        retentionMaxArchives: 1,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000
      },
      logger
    );
    expect(await writer.runArchiveMaintenance()).toBe('ran');
    const check = verifyAuditChainAt(auditDir);
    expect(check?.verdict).toMatchObject({ ok: true, entries: 2, cuts: 1 });
  });

  it('FR-R5-F13 (FR-002) — accumulates >100,000 archive lines without stack overflow', () => {
    const acc = createAuditCutAccumulator();
    const row = JSON.stringify({
      id: 'row-1',
      eventType: 'phase-start',
      prevDigest: AUDIT_CHAIN_GENESIS
    });
    const text = Array.from({ length: 120_000 }, () => row).join('\n');
    appendCutText(acc, text);
    const record = finalizeAuditCutRecord(acc, 1_700_000_000_000);
    expect(record).toMatchObject({
      kind: 'audit-cut',
      removedCount: 120_000,
      removedChained: 120_000,
      removedFrom: AUDIT_CHAIN_GENESIS
    });
  });

  it('FR-R5-F13 (FR-003) — leaves archives intact when audit.log.cuts is refused as a symlink', async () => {
    const auditDir = path.join(workspaceRoot, '.schegent');
    await fs.mkdir(auditDir, { recursive: true, mode: 0o700 });
    const row1 = JSON.stringify({
      id: 'row-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      eventType: 'phase-start',
      runId: 'r',
      payload: { phase: 'implement' },
      schemaVersion: 3,
      prevDigest: AUDIT_CHAIN_GENESIS,
      digestAlg: 'sha256'
    });
    const arch1 = path.join(auditDir, 'audit.log.20250101-000001-000-aaaaaaaa');
    await fs.writeFile(arch1, `${row1}\n`, { mode: 0o600 });
    await fs.utimes(arch1, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
    const target = path.join(workspaceRoot, 'outside-cuts');
    await fs.writeFile(target, '');
    await fs.symlink(target, path.join(auditDir, 'audit.log.cuts'));

    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        retentionMaxArchives: 0,
        retentionMaxArchiveAgeMs: 365 * 24 * 60 * 60 * 1000
      },
      logger
    );
    expect(await writer.runArchiveMaintenance()).toBe('ran');
    const stat = await fs.stat(arch1);
    expect(stat.isFile()).toBe(true);
  });
});
