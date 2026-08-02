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

  it('omits command detail from the entry passed to listeners', async () => {
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
    expect(JSON.stringify(payload)).not.toContain('command');
    expect(payload.operation).toBe('phase');
  });

  it('rejects unsafe generic payloads instead of writing redacted evidence', async () => {
    const fakeToken = `ghp_${'A'.repeat(36)}`;
    await expect(writer.append({
      runId: 'r2',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'file-write',
      payload: { token: fakeToken },
      outcome: 'info'
    })).rejects.toMatchObject({ reasonCode: 'secret-detected' });
    await expect(fs.readFile(writer.logPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
