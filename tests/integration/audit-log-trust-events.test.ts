// Feature 059 (US6, T028) — audit-log trust-event integration test.
// Contract: specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md
//
// Verifies:
//   - A denied draft save results in EXACTLY ONE `trust.capability-denied`
//     entry in `<workspaceRoot>/.schegent/audit.log`.
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
//
// Feature 100 (T514) — the gate is unchanged and so is the entry it writes; only
// the commands that ask it moved. The 059 contract is per-capability rather than
// per-command (`trust-gate.ts`), so the two claims re-seat rather than being
// rewritten — but they seat on *different* commands, and that is the one thing
// worth reading twice:
//
//   - `phases` is asked of every Phase write, so a draft save carries it;
//   - `retryConditions` carries a `rowIndex`, and a row index needs rows. A
//     per-definition operation has no row to number, so the denial that names one
//     is now the package publish, which addresses a whole layer at once
//     (`cmd-catalog-lifecycle.ts` `packageCapabilities`).
//
// Asserting `rowIndex` against a draft save would have meant asserting it absent,
// which is a weaker claim about a different requirement (FR-046 wants the
// operator pointed at the line of the document they have to fix).

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
import { FakeCatalogStore, tokenFor } from '../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../fixtures/fake-catalog-lifecycle';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_PUBLISH_PACKAGE,
  CMD_SAVE_DEFINITION_DRAFT,
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
    catalogLifecycle: fakeCatalogLifecycle(store),
    refreshCatalog: async () => undefined,
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
  };
  return { router: new MessageRouter(deps), audit, store };
}

type Harness = { readonly router: MessageRouter; readonly store: FakeCatalogStore };

async function dispatch(
  harness: Harness,
  command: SidebarCommand
): Promise<CommandAckMessage> {
  let captured: CommandAckMessage | undefined;
  await harness.router.dispatch(command, async (msg: CommandAckMessage) => {
    captured = msg;
    return true;
  });
  if (!captured) throw new Error('router did not ack the command');
  return captured;
}

/**
 * A draft save of one Phase — the operation the `phases` capability gates.
 *
 * The token comes from the store rather than being written out, because the gate
 * this suite is about runs *after* the staleness pre-check (FR-014): a hand-written
 * token that happened not to match would report `stale-catalog` and the trust
 * denial under test would never be reached.
 */
async function dispatchSave(
  harness: Harness,
  body: { readonly id: string },
  correlationId: string
): Promise<CommandAckMessage> {
  return dispatch(harness, {
    type: CMD_SAVE_DEFINITION_DRAFT,
    correlationId,
    payload: {
      kind: 'phase',
      id: body.id,
      expectedDraftVersion: tokenFor(harness.store, 'phase', body.id),
      body
    }
  } as unknown as SidebarCommand);
}

/** A package publish of a Phase layer — the operation whose denial can name a row. */
async function dispatchPackage(
  harness: Harness,
  phases: readonly { readonly id: string }[],
  correlationId: string
): Promise<CommandAckMessage> {
  return dispatch(harness, {
    type: CMD_PUBLISH_PACKAGE,
    correlationId,
    payload: {
      layers: [
        {
          kind: 'phase',
          expectedRevision: harness.store.revisionOf('phase'),
          definitions: phases.map((body) => ({ id: body.id, body }))
        }
      ]
    }
  } as unknown as SidebarCommand);
}

describe('Feature 059 T028 — audit log trust-event shape', () => {
  it('writes exactly one trust.capability-denied entry for a denied draft save', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'user');
    const harness = buildHarness();
    const { audit } = harness;
    const phase = {
      id: 'speckit-specify',
      name: 'Modified Specify',
      instruction: 'Operator-authored override',
      loopable: false
    };
    const correlationId = 'corr-audit-trust-1';

    const ack = await dispatchSave(harness, phase, correlationId);
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

    const ack = await dispatchPackage(harness, phases, 'corr-audit-trust-2');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('trust-denied');

    await flushAuditChain(audit);
    const entries = await readAuditLog(tmpRoot);
    const trustEntries = entries.filter((e) => e.eventType === 'trust.capability-denied');
    // One entry, not two: `phases` was allowed, so only the capability that was
    // actually denied is recorded. The gate returns at the first denial.
    expect(trustEntries).toHaveLength(1);
    const payload = trustEntries[0].payload as Record<string, unknown>;
    expect(payload.capability).toBe('retryConditions');
    expect(typeof payload.rowIndex).toBe('number');
    expect(payload.rowIndex).toBe(0);
  });
});
