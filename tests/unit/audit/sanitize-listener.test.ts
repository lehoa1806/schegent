import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { AuditEntry } from '../../../src/audit/audit-entry';

describe('AuditLogWriter sanitizes the payload sent to listeners (US3 / T047)', () => {
  let workspaceRoot: string;
  let logger: SanitizedLogger;
  let writer: AuditLogWriter;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-'));
    logger = new SanitizedLogger();
    writer = new AuditLogWriter({ workspaceRoot }, logger);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('redacts secrets in the entry passed to listeners (not just to disk)', async () => {
    const captured: AuditEntry[] = [];
    writer.subscribe((e) => captured.push(e));
    const fakeKey = `sk-ant-${'A'.repeat(30)}`;
    await writer.append({
      runId: 'r1',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'cli-invocation',
      payload: { command: `claude --api-key ${fakeKey}` },
      outcome: 'info'
    });
    expect(captured).toHaveLength(1);
    const payload = captured[0].payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('sk-ant-AAA');
    expect(JSON.stringify(payload)).toContain('[REDACTED]');
  });

  it('writes sanitized JSON to disk', async () => {
    const fakeToken = `ghp_${'A'.repeat(36)}`;
    await writer.append({
      runId: 'r2',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'file-write',
      payload: { token: fakeToken },
      outcome: 'info'
    });
    const onDisk = await fs.readFile(writer.logPath, 'utf-8');
    expect(onDisk).not.toContain('ghp_AAA');
    expect(onDisk).toContain('[REDACTED]');
  });
});
