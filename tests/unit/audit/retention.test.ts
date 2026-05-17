import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

describe('AuditLogWriter retention pruning', () => {
  let workspaceRoot: string;
  let logger: SanitizedLogger;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-retention-'));
    logger = new SanitizedLogger();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
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
    const archives = entries.filter((n) => n.startsWith('audit.log.'));
    expect(archives.length).toBeLessThanOrEqual(2);
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
