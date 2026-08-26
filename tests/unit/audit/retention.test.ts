import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
    await removeTempRoot(workspaceRoot);
  });

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
    for (let i = 0; i < 5; i++) {
      await writer.append({
        runId: `r${i}`,
        phase: 'speckit-specify',
        iteration: 1,
        eventType: 'cli-invocation',
        payload: { i },
        outcome: 'info'
      });
      // ensure mtime stamps are distinct so the sort is stable
      await new Promise((r) => setTimeout(r, 10));
    }
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
    for (let i = 0; i < 4; i++) {
      await writer.append({
        runId: `r${i}`,
        phase: 'speckit-specify',
        iteration: 1,
        eventType: 'cli-invocation',
        payload: { i },
        outcome: 'info'
      });
      await new Promise((r) => setTimeout(r, 10));
    }
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
    const writer = new AuditLogWriter(
      {
        workspaceRoot,
        rotationSizeBytes: 1,
        retentionMaxArchives: 100,
        retentionMaxArchiveAgeMs: 50 // 50 ms
      },
      logger
    );
    await writer.append({
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info'
    });
    // wait long enough for the first archive to age out
    await new Promise((r) => setTimeout(r, 120));
    await writer.append({
      runId: 'r2',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: {},
      outcome: 'info'
    });
    const dir = path.dirname(writer.logPath);
    const entries = await fs.readdir(dir);
    const archives = entries.filter((n) => n.startsWith('audit.log.'));
    // The first archive should have been pruned by age; only the most recent remains.
    expect(archives.length).toBeLessThanOrEqual(1);
  });
});
