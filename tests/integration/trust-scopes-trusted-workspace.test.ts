// Feature 059 (US1, T010) — integration test for the trusted-workspace +
// workspace-scope deny path.
//
// Scope:
//   - A real on-disk workspace under `tmpRoot`.
//   - `workspace.isTrusted === true`.
//   - Workspace-scope `schegent.trust.allowCustomPhases: false`.
//   - The host's MessageRouter dispatches `CMD_SAVE_PHASES` with a
//     NON-default payload.
//   - The save command MUST reject with `trust-denied`, the on-disk
//     `schegent.phases` (modeled here as the `updateConfig` call) MUST be
//     unchanged, and a single `trust.capability-denied` audit entry MUST
//     land in `<workspaceRoot>/.schegent/audit.log` with the contracted
//     payload shape.
//
// The capability resolver and canonical-folder picker are mocked at
// module load so the integration test can exercise the gate without a
// running VS Code host. The integration spans:
//   MessageRouter → cmd-save-phases handler → resolver → audit writer
//   → on-disk JSONL.
//
// Test is expected to FAIL until T013 (gate insertion) and T014 (audit
// emission helper) land. See:
//   `specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md`

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => {
  const state = {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    canonicalBasename: 'integration-test-workspace'
  };
  return { state };
});

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) =>
    mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: (capability: string) =>
    mocks.state.scopes.get(capability) ?? 'workspace-trust'
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
import { phaseLayerRevision } from '../../src/config/process-catalog';
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
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function flushAuditChain(audit: AuditLogWriter): Promise<void> {
  // AuditLogWriter serializes appends behind a private write chain. The
  // test reaches into the chain by appending a harmless info event and
  // awaiting it; once the trailing append resolves, every earlier append
  // is durable on disk.
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-059-trust-trusted-'));
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
  mocks.state.canonicalBasename = path.basename(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

interface Harness {
  router: MessageRouter;
  audit: AuditLogWriter;
  logger: SanitizedLogger;
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
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger,
    audit,
    updateConfig: async (key, value) => {
      updateConfigCalls.push({ key, value });
    },
    readPhaseConfig: () => ({ user: [], workspace: [] })
  };
  return { router: new MessageRouter(deps), audit, logger, updateConfigCalls };
}

async function dispatchSave(
  router: MessageRouter,
  phases: readonly unknown[],
  correlationId = 'integ-trust-1'
): Promise<CapturedAck> {
  let captured: CapturedAck | undefined;
  const command = {
    type: CMD_SAVE_PHASES,
    correlationId,
    payload: {
      scope: 'workspace',
      expectedRevision: phaseLayerRevision([]),
      mutation: { kind: 'create', phaseId: String((phases[0] as { id?: unknown })?.id) },
      phases
    }
  } as unknown as SidebarCommand;
  await router.dispatch(command, async (msg: CommandAckMessage) => {
    captured = {
      status: msg.status,
      reason: msg.reason,
      result: msg.result
    };
    return true;
  });
  if (!captured) throw new Error('router did not ack the save');
  return captured;
}

describe('Feature 059 T010 — trusted workspace + workspace-scope deny path', () => {
  it('rejects non-default CMD_SAVE_PHASES with trust-denied and emits a single trust.capability-denied audit entry', async () => {
    // Trusted workspace; workspace-scope allowCustomPhases=false.
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'workspace');

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
    expect(err.resolvedScope).toBe('workspace');
    expect(typeof err.reason).toBe('string');

    // On-disk persistence MUST be untouched: the handler must not call
    // `updateConfig` once the gate fires.
    expect(updateConfigCalls).toEqual([]);

    // Audit log on disk MUST contain exactly one `trust.capability-denied`
    // entry with the contracted payload shape. A harmless trailing append
    // forces the chained writer to flush before we read.
    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    expect(trustEntries).toHaveLength(1);
    const entry = trustEntries[0];
    expect(entry.outcome).toBe('failure');
    const payload = entry.payload as Record<string, unknown>;
    expect(payload.capability).toBe('phases');
    expect(payload.resolvedScope).toBe('workspace');
    expect(typeof payload.reason).toBe('string');
    expect(typeof payload.workspaceBasename).toBe('string');
    expect(String(payload.workspaceBasename)).not.toMatch(/[\\/]/);
    expect(String(payload.workspaceBasename)).toBe(mocks.state.canonicalBasename);
  });

  it('accepts a non-default payload when allowCustomPhases is true at workspace scope', async () => {
    // Same workspace, but the workspace scope now permits custom phases.
    mocks.state.capabilities.set('phases', true);
    mocks.state.scopes.set('phases', 'workspace');

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

    expect(ack.status).toBe('accepted');
    expect(ack.reason).toBeUndefined();
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('phases');
    expect(updateConfigCalls[0].value).toEqual([
      expect.objectContaining({ ...nonDefaultPhases[0], version: 1 })
    ]);

    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    expect(trustEntries).toEqual([]);
  });
});
