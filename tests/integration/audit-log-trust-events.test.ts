// Feature 059 (US6, T028) — audit-log trust-event integration test.
// Contract: specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md
//
// Verifies:
//   - A denied CMD_SAVE_PHASES results in EXACTLY ONE
//     `trust.capability-denied` entry in `<workspaceRoot>/.schegent/audit.log`.
//   - `capability`, `resolvedScope`, and `reason` are members of their
//     respective closed enums.
//   - `workspaceBasename` is the basename only (no `/` or `\`).
//   - The audit entry surfaces `outcome: 'failure'`, `runId: 'trust-gate'`,
//     `phase: 'settings'`, `iteration: 0`, and the `correlationId` from
//     the originating IPC command (I-5 of the audit shape).
//
// This test complements T010/T015 (which assert end-to-end gate
// behavior) by focusing on the audit log itself as the system-of-record
// for trust-denied events that downstream monitoring or SIEM tooling
// consumes (FR-007). The mock-resolver pattern matches the existing
// integration tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => {
  const state = {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    canonicalBasename: 'audit-trust-test-workspace'
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
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_SAVE_PHASES,
  type SidebarCommand,
  type CommandAckMessage
} from '../../src/ui/sidebar/messages';
import {
  TRUST_DENIED_REASONS,
  type TrustCapability,
  type ResolvedScope,
  type TrustDeniedReason
} from '../../src/contracts/sidebar-ipc';

// Feature 099 (T496f, FR-046) — `pipelineOverrides` left with the layer tier it
// gated: it asked whether one layer could redefine what another declares, and one
// layer poses no such question. The two that remain are keyed on document content.
const VALID_CAPABILITIES: readonly TrustCapability[] = ['phases', 'retryConditions'];
const VALID_SCOPES: readonly ResolvedScope[] = [
  'user',
  'workspace',
  'workspace-trust'
];
const VALID_REASONS: readonly TrustDeniedReason[] = Object.values(
  TRUST_DENIED_REASONS
);

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
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-059-audit-trust-'));
  mocks.state.canonicalBasename = path.basename(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function buildHarness(): {
  router: MessageRouter;
  audit: AuditLogWriter;
  store: FakeCatalogStore;
} {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const store = new FakeCatalogStore();
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger,
    audit,
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
  };
  return { router: new MessageRouter(deps), audit, store };
}

async function dispatchSave(
  harness: { readonly router: MessageRouter; readonly store: FakeCatalogStore },
  phases: readonly unknown[],
  correlationId: string
): Promise<CommandAckMessage> {
  let captured: CommandAckMessage | undefined;
  const command = {
    type: CMD_SAVE_PHASES,
    correlationId,
    payload: {
      expectedRevision: harness.store.revisionOf('phase'),
      mutation: { kind: 'create', phaseId: String((phases[0] as { id?: unknown })?.id) },
      phases
    }
  } as unknown as SidebarCommand;
  await harness.router.dispatch(command, async (msg: CommandAckMessage) => {
    captured = msg;
    return true;
  });
  if (!captured) throw new Error('router did not ack the save');
  return captured;
}

describe('Feature 059 T028 — audit log trust-event shape', () => {
  it('writes exactly one trust.capability-denied entry for a denied CMD_SAVE_PHASES', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'user');
    const harness = buildHarness();
    const { audit } = harness;
    const phases = [
      {
        id: 'speckit-specify',
        name: 'Modified Specify',
        instruction: 'Operator-authored override',
        loopable: false
      }
    ];
    const correlationId = 'corr-audit-trust-1';

    const ack = await dispatchSave(harness, phases, correlationId);
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('trust-denied');

    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    expect(trustEntries).toHaveLength(1);

    const entry = trustEntries[0];
    expect(entry.runId).toBe('trust-gate');
    expect(entry.phase).toBe('settings');
    expect(entry.iteration).toBe(0);
    expect(entry.outcome).toBe('failure');
    expect(entry.correlationId).toBe(correlationId);

    const payload = entry.payload as Record<string, unknown>;
    expect(VALID_CAPABILITIES).toContain(payload.capability as TrustCapability);
    expect(payload.capability).toBe('phases');
    expect(VALID_SCOPES).toContain(payload.resolvedScope as ResolvedScope);
    expect(payload.resolvedScope).toBe('user');
    expect(VALID_REASONS).toContain(payload.reason as TrustDeniedReason);
    expect(String(payload.workspaceBasename)).toBe(mocks.state.canonicalBasename);
    expect(String(payload.workspaceBasename)).not.toMatch(/[\\/]/);
  });

  it('records the rowIndex on a retry-condition denial entry', async () => {
    // Phases allowed at workspace; retryConditions denied at user.
    mocks.state.capabilities.set('phases', true);
    mocks.state.scopes.set('phases', 'workspace');
    mocks.state.capabilities.set('retryConditions', false);
    mocks.state.scopes.set('retryConditions', 'user');
    const harness = buildHarness();
    const { audit } = harness;
    const phases = [
      {
        id: 'speckit-clarify',
        name: 'Clarify',
        instruction: 'Clarify',
        loopable: true,
        retryCondition: 'custom > 0'
      }
    ];

    const ack = await dispatchSave(harness, phases, 'corr-audit-trust-2');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('trust-denied');

    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    expect(trustEntries).toHaveLength(1);
    const payload = trustEntries[0].payload as Record<string, unknown>;
    expect(payload.capability).toBe('retryConditions');
    expect(typeof payload.rowIndex).toBe('number');
    expect(payload.rowIndex).toBe(0);
  });
});
