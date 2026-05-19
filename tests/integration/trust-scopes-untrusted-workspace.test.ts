// Feature 059 (US2, T015) — integration test for the untrusted-workspace
// ceiling.
//
// Scope:
//   - `workspace.isTrusted === false` (modeled by the resolver mock
//     returning `false` for every capability and `'workspace-trust'` for
//     the resolved scope, matching `capability-trust-resolver.ts`'s
//     step-1 behavior).
//   - Workspace-scope `schegent.trust.allowCustomPhases: true` (would
//     widen the user-scope value on a trusted workspace, but cannot
//     widen the ceiling).
//   - `CMD_SAVE_PHASES` with a NON-default payload MUST be rejected with
//     `trust-denied`, `resolvedScope: 'workspace-trust'`. No persistence,
//     audit entry emitted.
//
// Note: the existing workspace-trust gate at `MessageRouter` (see
// `cmd-untrusted-rejection.test.ts`) would normally short-circuit this
// command before the handler runs. This test deliberately wires
// `isTrusted: () => true` on the router and lets the per-capability
// resolver (which models `isTrusted === false` at the capability layer)
// produce the rejection. This proves the per-capability gate is
// independently sufficient, satisfying FR-002 in isolation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => {
  const state = {
    canonicalBasename: 'integration-test-workspace'
  };
  return { state };
});

vi.mock('../../src/state/capability-trust-resolver', () => ({
  // Untrusted ceiling: every capability is denied, every scope is
  // 'workspace-trust' (step 1 of the resolution ladder).
  isCapabilityAllowed: (_capability: string) => false,
  getResolvedScope: (_capability: string) => 'workspace-trust' as const
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: {
      fsPath: path.join(os.tmpdir(), mocks.state.canonicalBasename),
      scheme: 'file'
    },
    name: mocks.state.canonicalBasename,
    index: 0
  }),
  disposeWorkspaceFolderPicker: () => undefined
}));

import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_SAVE_PHASES,
  type SidebarCommand,
  type CommandAckMessage,
  type TrustDeniedError
} from '../../src/ui/sidebar/messages';

interface CapturedAck {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}

async function readAuditLog(workspaceRoot: string): Promise<Array<Record<string, unknown>>> {
  const logPath = path.join(workspaceRoot, '.schegent', 'audit.log');
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function flushAuditChain(audit: AuditLogWriter): Promise<void> {
  await audit.append({
    runId: 'test-flush',
    phase: 'queue',
    iteration: 0,
    eventType: 'queue-settings-saved',
    payload: { queueId: 'flush' },
    outcome: 'info'
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-059-trust-untrusted-'));
  mocks.state.canonicalBasename = path.basename(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

interface Harness {
  router: MessageRouter;
  audit: AuditLogWriter;
  updateConfigCalls: Array<{ key: string; value: unknown }>;
}

function buildHarness(): Harness {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const updateConfigCalls: Array<{ key: string; value: unknown }> = [];
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    // The router-level workspace-trust gate is exercised by a separate
    // test. Here we route the command through to the handler so the
    // per-capability gate is the only thing standing between the payload
    // and `updateConfig`.
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger,
    audit,
    updateConfig: async (key, value) => {
      updateConfigCalls.push({ key, value });
    }
  };
  return { router: new MessageRouter(deps), audit, updateConfigCalls };
}

async function dispatchSave(
  router: MessageRouter,
  phases: readonly unknown[],
  correlationId = 'integ-untrusted-1'
): Promise<CapturedAck> {
  let captured: CapturedAck | undefined;
  const command = {
    type: CMD_SAVE_PHASES,
    correlationId,
    payload: { phases }
  } as unknown as SidebarCommand;
  await router.dispatch(command, async (msg: CommandAckMessage) => {
    captured = { status: msg.status, reason: msg.reason, result: msg.result };
    return true;
  });
  if (!captured) throw new Error('router did not ack the save');
  return captured;
}

describe('Feature 059 T015 — untrusted-workspace ceiling cannot be widened', () => {
  it('rejects non-default CMD_SAVE_PHASES with resolvedScope=workspace-trust and emits the audit entry', async () => {
    const { router, audit, updateConfigCalls } = buildHarness();
    const nonDefaultPhases = [
      {
        id: 'speckit-specify',
        name: 'Modified Specify',
        instruction: 'Operator-authored override',
        loopable: false
      }
    ];

    const ack = await dispatchSave(router, nonDefaultPhases);

    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('trust-denied');
    const err = ack.result as TrustDeniedError;
    expect(err.kind).toBe('trust-denied');
    expect(err.capability).toBe('phases');
    expect(err.resolvedScope).toBe('workspace-trust');

    expect(updateConfigCalls).toEqual([]);

    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    expect(trustEntries).toHaveLength(1);
    const payload = trustEntries[0].payload as Record<string, unknown>;
    expect(payload.capability).toBe('phases');
    expect(payload.resolvedScope).toBe('workspace-trust');
    expect(String(payload.workspaceBasename)).toBe(mocks.state.canonicalBasename);
    expect(String(payload.workspaceBasename)).not.toMatch(/[\\/]/);
  });
});
