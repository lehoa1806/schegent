// Feature 030 — `task-reordered` audit event end-to-end emission test.
//
// Verifies that:
//   1. The event type is registered in the QUEUE_CONTROL_EVENT_TYPES union
//      and is reachable as `AuditEventType` (the parser MUST NOT drop it).
//   2. A success-shaped payload (with `fromPosition`, `toPosition`,
//      `source`, `outcome: 'success'`) round-trips through
//      `AuditLogWriter.append` to `.schegent/audit.log` byte-identical
//      (the payload carries only enum / id / number fields, so
//      `SECRET_PATTERNS` MUST leave it unchanged).
//   3. Each rejection cause value (`secondary-host`, `task-not-pending`,
//      `invalid-position`, `no-op`) also round-trips as `outcome:
//      'rejected'` with the matching `cause`.
//
// This is the contract test for the audit shape; the wiring of
// drag-and-drop / arrow buttons → `CMD_REORDER_TASK` happens in US2.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  QUEUE_CONTROL_EVENT_TYPES,
  isKnownAuditEventType,
  type TaskReorderedRejectCause,
  type TaskReorderedPayload
} from '../../../src/contracts/audit-events';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-reorder-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readAuditLines(): Promise<unknown[]> {
  const contents = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
  return contents
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('Feature 030 — task-reordered audit event', () => {
  it('registers task-reordered in QUEUE_CONTROL_EVENT_TYPES', () => {
    expect(QUEUE_CONTROL_EVENT_TYPES).toContain('task-reordered');
  });

  it('treats task-reordered as a known audit event type (parser MUST NOT drop it)', () => {
    expect(isKnownAuditEventType('task-reordered')).toBe(true);
  });

  it('writes a successful task-reordered with sanitized payload byte-identical', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const payload: TaskReorderedPayload = {
      queueId: 'default',
      taskId: 't-success',
      fromPosition: 2,
      toPosition: 0,
      source: 'drag',
      outcome: 'success'
    };
    await writer.append({
      runId: 'router',
      phase: 'queue',
      iteration: 0,
      eventType: 'task-reordered',
      payload: payload as unknown as Record<string, unknown>,
      outcome: 'success'
    });
    const [entry] = (await readAuditLines()) as Array<{
      eventType: string;
      payload: TaskReorderedPayload;
      outcome: string;
    }>;
    expect(entry.eventType).toBe('task-reordered');
    expect(entry.payload).toEqual(payload);
    expect(entry.outcome).toBe('success');
  });

  it('writes a task-reordered rejection for every documented cause', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const causes: TaskReorderedRejectCause[] = [
      'secondary-host',
      'task-not-pending',
      'invalid-position',
      'no-op'
    ];
    for (const cause of causes) {
      const payload: TaskReorderedPayload = {
        queueId: 'default',
        taskId: `t-${cause}`,
        fromPosition: 1,
        toPosition: 1,
        source: 'arrow',
        outcome: 'rejected',
        cause
      };
      await writer.append({
        runId: 'router',
        phase: 'queue',
        iteration: 0,
        eventType: 'task-reordered',
        payload: payload as unknown as Record<string, unknown>,
        outcome: 'failure'
      });
    }
    const lines = (await readAuditLines()) as Array<{
      eventType: string;
      payload: TaskReorderedPayload;
      outcome: string;
    }>;
    expect(lines).toHaveLength(causes.length);
    for (let i = 0; i < causes.length; i += 1) {
      expect(lines[i].eventType).toBe('task-reordered');
      expect(lines[i].payload).toMatchObject({
        queueId: 'default',
        outcome: 'rejected',
        cause: causes[i],
        source: 'arrow'
      });
      expect(lines[i].outcome).toBe('failure');
    }
  });
});
