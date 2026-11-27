import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuditLogWriter,
  CRITICAL_DURABILITY_AUDIT_EVENT_TYPES
} from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

const datasyncTracker = vi.hoisted(() => ({
  calls: 0
}));

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (!String(args[0]).endsWith('audit.log')) return handle;
      const origDatasync = handle.datasync.bind(handle);
      return Object.assign(handle, {
        datasync: async () => {
          datasyncTracker.calls += 1;
          return origDatasync();
        }
      });
    }
  };
});

describe('AuditLogWriter critical-event datasync durability', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    datasyncTracker.calls = 0;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-datasync-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('invokes handle.datasync() for critical terminal, security, ownership, reset, and export events', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());

    const criticalEntries: Array<Parameters<AuditLogWriter['append']>[0]> = [
      {
        runId: 'run-term-1',
        phase: 'done',
        iteration: 1,
        eventType: 'task-execution-ended',
        payload: { taskId: 'task-1', terminalStatus: 'completed', durationMs: 1200 },
        outcome: 'success'
      },
      {
        runId: 'run-sec-1',
        phase: 'plan',
        iteration: 1,
        eventType: 'backend-posture-admitted',
        payload: {
          runner: 'claude',
          containment: 'uncontained',
          mechanism: 'none',
          allowUncontained: true
        },
        outcome: 'info'
      },
      {
        runId: 'run-ack-1',
        phase: 'plan',
        iteration: 1,
        eventType: 'agent-config-acknowledged',
        payload: { backend: 'claude', fileCount: 2, decision: 'acknowledged' },
        outcome: 'info'
      },
      {
        runId: 'run-sup-1',
        phase: 'implement',
        iteration: 1,
        eventType: 'run-invocation-aborted-on-supersession',
        payload: { queueId: 'default' },
        outcome: 'info'
      },
      {
        runId: 'system',
        phase: 'reset',
        iteration: 0,
        eventType: 'workspace-state-reset',
        payload: {
          outcome: 'completed',
          phaseReached: 'reload',
          generation: 1,
          refusalReason: null,
          canceledRunCount: 0
        },
        outcome: 'success'
      },
      {
        runId: 'system',
        phase: 'export',
        iteration: 0,
        eventType: 'evidence-exported',
        payload: {
          kind: 'diagnostics-bundle',
          outcome: 'exported',
          included: 2,
          omitted: 0
        },
        outcome: 'success'
      }
    ];

    for (let i = 0; i < criticalEntries.length; i += 1) {
      const entry = criticalEntries[i]!;
      expect(CRITICAL_DURABILITY_AUDIT_EVENT_TYPES.has(entry.eventType)).toBe(true);
      await writer.append(entry);
      expect(datasyncTracker.calls, `expected datasync for ${entry.eventType}`).toBe(i + 1);
    }
  });

  it('does NOT invoke handle.datasync() for routine non-critical audit rows', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());

    const routineEntries: Array<Parameters<AuditLogWriter['append']>[0]> = [
      {
        runId: 'run-1',
        phase: 'speckit-plan',
        iteration: 1,
        eventType: 'phase-start',
        payload: { phaseId: 'speckit-plan', runner: 'claude', isContinue: false, sessionReuse: false },
        outcome: 'info'
      },
      {
        runId: 'run-1',
        phase: 'speckit-plan',
        iteration: 1,
        eventType: 'cli-invocation',
        payload: { operation: 'phase', runner: 'claude' },
        outcome: 'info'
      },
      {
        runId: 'run-1',
        phase: 'speckit-plan',
        iteration: 1,
        eventType: 'monitor-progress',
        payload: { bytes: 128 },
        outcome: 'info'
      },
      {
        runId: 'run-1',
        phase: 'speckit-plan',
        iteration: 1,
        eventType: 'phase-end',
        payload: { phaseId: 'speckit-plan', runner: 'claude', exitCode: 0, durationMs: 500 },
        outcome: 'success'
      }
    ];

    for (const entry of routineEntries) {
      expect(CRITICAL_DURABILITY_AUDIT_EVENT_TYPES.has(entry.eventType)).toBe(false);
      await writer.append(entry);
    }

    expect(datasyncTracker.calls).toBe(0);
    const lines = (await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(routineEntries.length);
  });
});
