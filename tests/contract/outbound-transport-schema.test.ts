// FR-R7-18 (`N11`, FR-012, SC-011, Contract 6) — Transport-level contract tests
// validating every actual `webview.postMessage(...)` emission from
// `SidebarViewProvider`, `DashboardPanel`, `PlaceholderProjector`,
// `StateProjector`, `MessageRouter`, and `PhaseLogTailSession` against
// `#/$defs/HostMessage` in the generated Draft 2020-12 JSON Schema
// (`src/contracts/generated/schemas/sidebar-ipc.schema.json`).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

interface MockDashboardPanel {
  webview: {
    html: string;
    options: Record<string, unknown>;
    cspSource: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
  };
  visible: boolean;
  active: boolean;
  viewType: string;
  title: string;
  reveal: Mock;
  dispose: Mock;
  onDidChangeViewState: Mock;
  onDidDispose: Mock;
  __inbound: ((raw: unknown) => void) | null;
  __triggerVisibilityChange: (visible: boolean) => void;
  __triggerDispose: () => void;
}

const mocks = vi.hoisted(() => ({
  panels: [] as MockDashboardPanel[],
  createWebviewPanel: vi.fn(),
  showWarningMessage: vi.fn()
}));

function createMockPanel(viewType: string, title: string): MockDashboardPanel {
  const viewStateListeners: Array<() => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel: MockDashboardPanel = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn((listener: (raw: unknown) => void) => {
        panel.__inbound = listener;
        return { dispose: vi.fn() };
      }),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `vscode-webview://${uri.fsPath}`
      }))
    },
    visible: true,
    active: true,
    viewType,
    title,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn((listener: () => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    __inbound: null,
    __triggerVisibilityChange: (visible: boolean) => {
      panel.visible = visible;
      for (const listener of viewStateListeners) listener();
    },
    __triggerDispose: () => {
      for (const listener of disposeListeners) listener();
    }
  };
  return panel;
}

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mocks.showWarningMessage,
    createWebviewPanel: mocks.createWebviewPanel
  },
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      scheme: 'file',
      path: fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2
  }
}));

import type * as vscode from 'vscode';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import {
  CMD_ACK,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_PAUSE_PHASE,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  MSG_PHASE_LOG_BATCH,
  STATE_SNAPSHOT,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/contracts/sidebar-ipc';
import { SNAPSHOT_RESYNC_REQUEST } from '../../src/contracts/snapshot-bounds';
import { SanitizedLogger } from '../../src/lib/logger';
import { PhaseLogTailSession } from '../../src/services/phase-log/phase-log-tail-session';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { DashboardPanel } from '../../src/ui/dashboard/dashboard-panel';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { PlaceholderProjector } from '../../src/ui/sidebar/placeholder-projector';
import type { ProjectorHandle, ProjectorListener } from '../../src/ui/sidebar/projector-handle';
import { SidebarViewProvider } from '../../src/ui/sidebar/sidebar-view-provider';
import { buildIdleSnapshot, type WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { validateAgainstSchema, type JsonSchemaNode } from '../helpers/json-schema-validator';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src/contracts/generated/schemas/sidebar-ipc.schema.json');

const ROOT_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchemaNode & {
  $defs: Record<string, JsonSchemaNode>;
};

function wireRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function assertValidHostMessage(raw: unknown, label: string): Record<string, unknown> {
  const wire = wireRoundTrip(raw);
  const unionResult = validateAgainstSchema(ROOT_SCHEMA, wire, '#/$defs/HostMessage');
  expect(
    unionResult.errors,
    `${label} failed #/$defs/HostMessage:\n${JSON.stringify(unionResult.errors, null, 2)}\nwire=${JSON.stringify(wire)}`
  ).toEqual([]);
  expect(unionResult.valid).toBe(true);

  const rec = wire as Record<string, unknown>;
  const msgType = String(rec['type']);
  const specificResult = validateAgainstSchema(ROOT_SCHEMA, wire, `#/$defs/HostMessage_${msgType}`);
  expect(
    specificResult.errors,
    `${label} failed #/$defs/HostMessage_${msgType}:\n${JSON.stringify(specificResult.errors, null, 2)}`
  ).toEqual([]);
  expect(specificResult.valid).toBe(true);
  return rec;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class ControllableProjector implements ProjectorHandle {
  private current: WorkflowSnapshot;
  private readonly listeners = new Set<ProjectorListener>();

  constructor(initial: WorkflowSnapshot) {
    this.current = initial;
  }

  subscribe(listener: ProjectorListener) {
    this.listeners.add(listener);
    listener(this.current);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  getCurrentSnapshot(): WorkflowSnapshot {
    return this.current;
  }

  emit(next: WorkflowSnapshot): void {
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
  }
}

function createFakeSidebarView(posted: unknown[]): {
  view: vscode.WebviewView;
  sendInbound: (raw: unknown) => void;
  setVisible: (visible: boolean) => void;
} {
  let inbound: ((raw: unknown) => void) | null = null;
  const visibilityListeners: Array<() => void> = [];
  const disposeListeners: Array<() => void> = [];
  const view = {
    visible: true,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `vscode-webview://${uri.fsPath}` }),
      postMessage: vi.fn(async (msg: unknown) => {
        posted.push(msg);
        return true;
      }),
      onDidReceiveMessage: vi.fn((listener: (raw: unknown) => void) => {
        inbound = listener;
        return { dispose: vi.fn() };
      })
    },
    onDidChangeVisibility: vi.fn((listener: () => void) => {
      visibilityListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    })
  };
  return {
    view: view as unknown as vscode.WebviewView,
    sendInbound: (raw: unknown) => {
      if (!inbound) throw new Error('expected SidebarViewProvider to register onDidReceiveMessage');
      inbound(raw);
    },
    setVisible: (visible: boolean) => {
      view.visible = visible;
      for (const listener of visibilityListeners) listener();
    }
  };
}

function fakeExec(result: unknown): RouterDeps['executeCommand'] {
  return (async <T = unknown>() => result as T) as RouterDeps['executeCommand'];
}

function makeRouter(overrides: Partial<RouterDeps> = {}): MessageRouter {
  const logger = new SanitizedLogger();
  const deps: RouterDeps = {
    executeCommand: fakeExec({ outcome: 'accepted' }),
    logger,
    isTrusted: () => true,
    isPrimary: () => true,
    ...overrides
  };
  return new MessageRouter(deps);
}

describe('Outbound webview transport contract validation (FR-R7-18 / N11 / SC-011)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    mocks.panels = [];
    mocks.showWarningMessage.mockReset();
    mocks.createWebviewPanel.mockReset();
    mocks.createWebviewPanel.mockImplementation((viewType: string, title: string) => {
      const panel = createMockPanel(viewType, title);
      mocks.panels.push(panel);
      return panel;
    });
    DashboardPanel.__resetForTests();
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-outbound-transport-'));
  });

  afterEach(async () => {
    DashboardPanel.__resetForTests();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('validates every SidebarViewProvider postMessage frame across PlaceholderProjector (no-workspace & init-failed) and fallback CMD_OPEN_DASHBOARD ack', async () => {
    for (const reason of ['no-workspace', 'init-failed'] as const) {
      const posted: unknown[] = [];
      const projector = new PlaceholderProjector({
        reason,
        now: () => new Date('2026-11-24T00:00:00.000Z')
      });
      const provider = new SidebarViewProvider({
        extensionRoot: tmpRoot,
        projector,
        logger: new SanitizedLogger()
      });
      const harness = createFakeSidebarView(posted);
      await provider.resolveWebviewView(
        harness.view,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      await flushMicrotasks();

      // Trigger fallback CMD_OPEN_DASHBOARD ack when no dispatcher is registered.
      harness.sendInbound({ type: CMD_OPEN_DASHBOARD, correlationId: `corr-open-${reason}` });
      await flushMicrotasks();

      expect(posted.length).toBeGreaterThanOrEqual(2);
      const validated = posted.map((msg, idx) => assertValidHostMessage(msg, `placeholder(${reason})[${idx}]`));
      const snapshots = validated.filter((m) => m['type'] === STATE_SNAPSHOT);
      const acks = validated.filter((m) => m['type'] === CMD_ACK);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect((snapshots[0]!['sync'] as Record<string, unknown>)['mode']).toBe('full');
      expect(acks).toEqual([
        {
          type: CMD_ACK,
          correlationId: `corr-open-${reason}`,
          status: 'accepted'
        }
      ]);

      provider.dispose();
      projector.dispose();
    }
  });

  it('validates every SidebarViewProvider postMessage frame across live StateProjector (full, routine, resync) and routed MessageRouter acks', async () => {
    const posted: unknown[] = [];
    const store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());

    const scheduledTimers = new Map<number, () => void>();
    let nextTimerId = 1;
    let tickNow = Date.parse('2026-11-24T01:00:00.000Z');
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'sidebar-transport-owner',
      isPrimary: true,
      debounceMs: 0,
      tickIntervalMs: 60_000,
      now: () => new Date((tickNow += 1000)),
      timer: {
        setTimeout: (fn: () => void) => {
          const id = nextTimerId++;
          scheduledTimers.set(id, fn);
          return id;
        },
        clearTimeout: (handle: unknown) => {
          scheduledTimers.delete(handle as number);
        }
      }
    });
    projector.start();

    const router = makeRouter({
      executeCommand: fakeExec({ outcome: 'accepted' })
    });
    const provider = new SidebarViewProvider({
      extensionRoot: tmpRoot,
      projector,
      dispatch: (command, ackFn) => router.dispatch(command, ackFn),
      logger: new SanitizedLogger()
    });

    const harness = createFakeSidebarView(posted);
    await provider.resolveWebviewView(
      harness.view,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken
    );
    await flushMicrotasks();

    // Mutate audit log to trigger a second StateProjector snapshot (routine update with omitted unchanged slices).
    await audit.append({
      runId: 'run-transport-1',
      phase: 'specify',
      iteration: 1,
      eventType: 'phase-start',
      payload: { phase: 'specify' },
      outcome: 'info'
    });
    for (const [id, fn] of [...scheduledTimers.entries()]) {
      scheduledTimers.delete(id);
      fn();
    }
    await flushMicrotasks();

    // Trigger resync via SNAPSHOT_RESYNC_REQUEST -> full snapshot.
    harness.sendInbound({ type: SNAPSHOT_RESYNC_REQUEST, lastRevision: 1 });
    await flushMicrotasks();

    // Route real inbound commands through SidebarViewProvider -> MessageRouter -> webview.postMessage.
    harness.sendInbound({ type: CMD_OPEN_AUDIT_LOG, correlationId: 'corr-sb-audit' });
    harness.sendInbound({
      type: CMD_PAUSE_PHASE,
      correlationId: 'corr-sb-pause',
      payload: { queueId: 'default' }
    });
    await flushMicrotasks();

    const validated = posted.map((msg, idx) => assertValidHostMessage(msg, `sidebar-live[${idx}]`));
    const snapshotModes = validated
      .filter((m) => m['type'] === STATE_SNAPSHOT)
      .map((m) => (m['sync'] as Record<string, unknown>)['mode']);
    expect(snapshotModes).toContain('full');
    expect(snapshotModes).toContain('routine');

    const routineMsg = validated.find(
      (m) => m['type'] === STATE_SNAPSHOT && (m['sync'] as Record<string, unknown>)['mode'] === 'routine'
    );
    expect(routineMsg).toBeDefined();
    const routineSync = routineMsg!['sync'] as Record<string, unknown>;
    expect(typeof routineSync['baseRevision']).toBe('number');
    expect(Array.isArray(routineSync['omittedSlices'])).toBe(true);

    const acks = validated.filter((m) => m['type'] === CMD_ACK);
    expect(acks.map((a) => a['correlationId'])).toEqual(['corr-sb-audit', 'corr-sb-pause']);

    provider.dispose();
    projector.dispose();
  });

  it('validates every DashboardPanel postMessage frame across postIfVisible snapshots, routed acks, and real PhaseLogTailSession batches', async () => {
    const snap1 = buildIdleSnapshot({ isPrimary: true, producedAt: '2026-11-24T02:00:00.000Z' });
    const snap2 = buildIdleSnapshot({ isPrimary: true, producedAt: '2026-11-24T02:00:05.000Z' });
    const projector = new ControllableProjector(snap1);
    const router = makeRouter({
      executeCommand: fakeExec({ outcome: 'refused', reason: 'no-active-run' })
    });

    const dashboard = DashboardPanel.open({
      extensionRoot: tmpRoot,
      projector,
      dispatch: (command, ackFn) => router.dispatch(command, ackFn),
      logger: new SanitizedLogger()
    });
    const panel = mocks.panels.at(0);
    if (!panel) throw new Error('expected DashboardPanel to open a mock webview panel');
    await flushMicrotasks();

    // Emit a second snapshot -> routine update with omitted unchanged slices.
    projector.emit(snap2);
    await flushMicrotasks();

    // Hide and reveal -> forces full resync snapshot.
    panel.__triggerVisibilityChange(false);
    panel.__triggerVisibilityChange(true);
    await flushMicrotasks();

    // Route an inbound command through DashboardPanel -> MessageRouter -> webview.postMessage.
    panel.__inbound?.({
      type: CMD_PAUSE_PHASE,
      correlationId: 'corr-dash-refused',
      payload: { queueId: 'default' }
    });
    await flushMicrotasks();

    // Drive a real PhaseLogTailSession reading a real JSONL stream file on disk and posting via dashboard.postPhaseLogBatch.
    const logDir = path.join(tmpRoot, '.schegent', 'sessions', 'run-1');
    await fsp.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, 'phase-1.jsonl');
    const initialLines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-24T02:01:00.000Z',
        message: {
          content: [{ type: 'text', text: 'Inspecting workspace state' }]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-24T02:01:01.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'README.md' } }]
        }
      }),
      'not-valid-json-line'
    ].join('\n') + '\n';
    await fsp.writeFile(logFile, initialLines, 'utf8');

    const tail = new PhaseLogTailSession({
      sessionId: 'tail-session-transport-1',
      workspaceRoot: tmpRoot,
      filePath: logFile,
      selection: {
        queueId: 'default',
        taskId: 'task-1',
        pipelineId: 'pipe-1',
        phaseId: 'plan',
        iterationN: 1
      },
      sanitize: (s) => s,
      caps: { perFieldBytes: 4096 },
      postBatch: (batch) => dashboard.postPhaseLogBatch({ type: MSG_PHASE_LOG_BATCH, payload: batch })
    });

    const started = await tail.start();
    expect(started).not.toBeNull();
    tail.ack({ batchSeq: 0 });
    await tail.tick();

    // Append another line and ack batch 1 so batch 2 emits with mode: 'continue'.
    tail.ack({ batchSeq: 1 });
    await fsp.appendFile(
      logFile,
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' })}\n`,
      'utf8'
    );
    await tail.tick();

    // Emit terminal tail-ended batch.
    await tail.dispose('phase-complete');
    await flushMicrotasks();

    const posted = panel.webview.postMessage.mock.calls.map((call) => call[0] as unknown);
    expect(posted.length).toBeGreaterThanOrEqual(6);

    const validated = posted.map((msg, idx) => assertValidHostMessage(msg, `dashboard[${idx}]`));
    const snapshotModes = validated
      .filter((m) => m['type'] === STATE_SNAPSHOT)
      .map((m) => (m['sync'] as Record<string, unknown>)['mode']);
    expect(snapshotModes).toContain('full');
    expect(snapshotModes).toContain('routine');

    const acks = validated.filter((m) => m['type'] === CMD_ACK);
    expect(acks).toEqual([
      {
        type: CMD_ACK,
        correlationId: 'corr-dash-refused',
        status: 'rejected',
        outcome: 'refused',
        reason: 'no-active-run'
      }
    ]);

    const batches = validated.filter((m) => m['type'] === MSG_PHASE_LOG_BATCH);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    const batchModes = batches.map((b) => (b['payload'] as Record<string, unknown>)['mode']);
    expect(batchModes).toContain('reset');
    expect(batchModes).toContain('continue');
    const allEntryKinds = batches.flatMap((b) =>
      ((b['payload'] as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>).map(
        (item) => ((item['entry'] as Record<string, unknown>)['kind'] as string)
      )
    );
    expect(allEntryKinds).toContain('assistant-text');
    expect(allEntryKinds).toContain('tool-use');
    expect(allEntryKinds).toContain('coverage-gap');
    expect(allEntryKinds).toContain('tail-ended');

    dashboard.dispose();
  });

  it('validates every real MessageRouter ACK path (accepted, outcome, query result, untrusted, secondary, validation/handler refusal, no-op, failed throw)', async () => {
    const capture = async (router: MessageRouter, command: SidebarCommand): Promise<CommandAckMessage> => {
      const acks: CommandAckMessage[] = [];
      await router.dispatch(command, async (msg) => {
        acks.push(msg);
        return true;
      });
      expect(acks).toHaveLength(1);
      assertValidHostMessage(acks[0], `router(${command.type}:${command.correlationId})`);
      return acks[0]!;
    };

    // 1. Accepted without outcome (CMD_OPEN_AUDIT_LOG -> ack(ctx, 'accepted'))
    const acceptedPlain = await capture(makeRouter(), {
      type: CMD_OPEN_AUDIT_LOG,
      correlationId: 'corr-accept-plain'
    });
    expect(acceptedPlain).toEqual({
      type: CMD_ACK,
      correlationId: 'corr-accept-plain',
      status: 'accepted'
    });
    expect('reason' in acceptedPlain).toBe(false);

    // 2. Accepted with outcome: 'accepted' (CMD_PAUSE_PHASE -> execAndAck)
    const acceptedWithOutcome = await capture(
      makeRouter({ executeCommand: fakeExec({ outcome: 'accepted' }) }),
      { type: CMD_PAUSE_PHASE, correlationId: 'corr-accept-outcome', payload: { queueId: 'default' } }
    );
    expect(acceptedWithOutcome).toEqual({
      type: CMD_ACK,
      correlationId: 'corr-accept-outcome',
      status: 'accepted',
      outcome: 'accepted'
    });
    expect('reason' in acceptedWithOutcome).toBe(false);

    // 3. Accepted with query result (CMD_RESOLVE_HISTORY_DESCRIPTION)
    const acceptedWithResult = await capture(
      makeRouter({
        historyDescriptionService: {
          resolve: vi.fn(async () => ({ outcome: 'resolved' as const, description: 'Full task text' }))
        }
      }),
      {
        type: CMD_RESOLVE_HISTORY_DESCRIPTION,
        correlationId: 'corr-query-result',
        payload: { runId: 'run-42' }
      }
    );
    expect(acceptedWithResult.status).toBe('accepted');
    expect('reason' in acceptedWithResult).toBe(false);
    expect(acceptedWithResult.result).toEqual({
      outcome: 'resolved',
      runId: 'run-42',
      description: 'Full task text'
    });

    // 4. Rejected by workspace-trust gate (untrusted)
    const rejectedUntrusted = await capture(
      makeRouter({ isTrusted: () => false }),
      { type: CMD_PAUSE_PHASE, correlationId: 'corr-untrusted', payload: { queueId: 'default' } }
    );
    expect(rejectedUntrusted.status).toBe('rejected');
    expect(rejectedUntrusted.reason).toBe('untrusted-workspace');

    // 5. Rejected by primary-host gate (secondary window)
    const rejectedSecondary = await capture(
      makeRouter({ isPrimary: () => false }),
      { type: CMD_PAUSE_PHASE, correlationId: 'corr-secondary', payload: { queueId: 'default' } }
    );
    expect(rejectedSecondary.status).toBe('rejected');
    expect(rejectedSecondary.reason).toBe('secondary-window-readonly');

    // 6. Rejected by handler validation / missing ops
    const rejectedMissingOps = await capture(makeRouter(), {
      type: CMD_REMOVE_QUEUE_ITEM,
      correlationId: 'corr-missing-ops',
      payload: { id: 'task-1', confirmed: true }
    });
    expect(rejectedMissingOps.status).toBe('rejected');
    expect(rejectedMissingOps.reason).toBe('queue-ops-unavailable');

    // 7. Rejected with outcome: 'no-op'
    const rejectedNoOp = await capture(
      makeRouter({
        executeCommand: fakeExec({ outcome: 'no-op', reason: 'already-paused' })
      }),
      { type: CMD_PAUSE_PHASE, correlationId: 'corr-noop', payload: { queueId: 'default' } }
    );
    expect(rejectedNoOp).toEqual({
      type: CMD_ACK,
      correlationId: 'corr-noop',
      status: 'rejected',
      outcome: 'no-op',
      reason: 'already-paused'
    });

    // 8. Rejected with outcome: 'refused'
    const rejectedRefused = await capture(
      makeRouter({
        executeCommand: fakeExec({ outcome: 'refused', reason: 'no-active-run' })
      }),
      { type: CMD_PAUSE_PHASE, correlationId: 'corr-refused', payload: { queueId: 'default' } }
    );
    expect(rejectedRefused).toEqual({
      type: CMD_ACK,
      correlationId: 'corr-refused',
      status: 'rejected',
      outcome: 'refused',
      reason: 'no-active-run'
    });

    // 9. Handler-throw failed (`command-dispatch-failed`, enforcing T28 path-leak prevention)
    const rejectedThrown = await capture(
      makeRouter({
        queueOps: {
          removeTask: vi.fn(async () => {
            throw new Error('EACCES: permission denied, open /Users/secret/workspace/file.txt');
          }),
          retry: vi.fn(),
          moveUp: vi.fn(),
          moveDown: vi.fn(),
          clearCompleted: vi.fn(),
          setQueuePausedState: vi.fn()
        }
      }),
      {
        type: CMD_REMOVE_QUEUE_ITEM,
        correlationId: 'corr-throw',
        payload: { id: 'task-boom', confirmed: true }
      }
    );
    expect(rejectedThrown).toEqual({
      type: CMD_ACK,
      correlationId: 'corr-throw',
      status: 'rejected',
      outcome: 'failed',
      reason: 'command-dispatch-failed'
    });
    expect(JSON.stringify(rejectedThrown)).not.toContain('/Users/secret');
  });

  it('NON-VACUITY: rejects tightened STATE_SNAPSHOT sync violations and accepted CMD_ACK carrying reason (T28)', () => {
    const idlePayload = wireRoundTrip(
      buildIdleSnapshot({ isPrimary: true, producedAt: '2026-11-24T03:00:00.000Z' })
    );

    // 1. mode: 'full' MUST forbid baseRevision and omittedSlices (in HostMessage and SnapshotSyncMeta).
    const fullWithBaseRevision = {
      type: STATE_SNAPSHOT,
      payload: idlePayload,
      sync: { mode: 'full', revision: 1, baseRevision: 0 }
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, fullWithBaseRevision, '#/$defs/HostMessage').valid).toBe(false);
    expect(
      validateAgainstSchema(ROOT_SCHEMA, fullWithBaseRevision.sync, '#/$defs/SnapshotSyncMeta').valid
    ).toBe(false);

    const fullWithOmittedSlices = {
      type: STATE_SNAPSHOT,
      payload: idlePayload,
      sync: { mode: 'full', revision: 1, omittedSlices: ['history'] }
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, fullWithOmittedSlices, '#/$defs/HostMessage').valid).toBe(false);
    expect(
      validateAgainstSchema(ROOT_SCHEMA, fullWithOmittedSlices.sync, '#/$defs/SnapshotSyncMeta').valid
    ).toBe(false);

    // 2. mode: 'routine' MUST require BOTH baseRevision and omittedSlices.
    const routineMissingBaseRevision = {
      type: STATE_SNAPSHOT,
      payload: idlePayload,
      sync: { mode: 'routine', revision: 2, omittedSlices: ['history'] }
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, routineMissingBaseRevision, '#/$defs/HostMessage').valid).toBe(false);
    expect(
      validateAgainstSchema(ROOT_SCHEMA, routineMissingBaseRevision.sync, '#/$defs/SnapshotSyncMeta').valid
    ).toBe(false);

    const routineMissingOmittedSlices = {
      type: STATE_SNAPSHOT,
      payload: idlePayload,
      sync: { mode: 'routine', revision: 2, baseRevision: 1 }
    };
    expect(validateAgainstSchema(ROOT_SCHEMA, routineMissingOmittedSlices, '#/$defs/HostMessage').valid).toBe(false);
    expect(
      validateAgainstSchema(ROOT_SCHEMA, routineMissingOmittedSlices.sync, '#/$defs/SnapshotSyncMeta').valid
    ).toBe(false);

    // 3. status: 'accepted' CMD_ACK MUST forbid reason (T28).
    for (const reason of ['should-not-be-here', '']) {
      const acceptedWithReason = {
        type: CMD_ACK,
        correlationId: 'corr-bad-accept',
        status: 'accepted',
        outcome: 'accepted',
        reason
      };
      expect(
        validateAgainstSchema(ROOT_SCHEMA, acceptedWithReason, '#/$defs/HostMessage_CMD_ACK').valid
      ).toBe(false);
      expect(validateAgainstSchema(ROOT_SCHEMA, acceptedWithReason, '#/$defs/HostMessage').valid).toBe(false);
    }

    // 4. Rejected CMD_ACK permits optional reason and non-accepted outcomes; accepted forbids non-accepted outcomes;
    // wire `status` is strictly `'accepted' | 'rejected'` (never `'refused' | 'failed'`).
    for (const outcome of ['no-op', 'refused', 'failed'] as const) {
      expect(
        validateAgainstSchema(
          ROOT_SCHEMA,
          { type: CMD_ACK, correlationId: `corr-rej-${outcome}-1`, status: 'rejected', outcome, reason: 'bounded-code' },
          '#/$defs/HostMessage'
        ).valid
      ).toBe(true);
      expect(
        validateAgainstSchema(
          ROOT_SCHEMA,
          { type: CMD_ACK, correlationId: `corr-bad-acc-${outcome}`, status: 'accepted', outcome },
          '#/$defs/HostMessage'
        ).valid
      ).toBe(false);
    }
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        { type: CMD_ACK, correlationId: 'corr-rej-bare', status: 'rejected' },
        '#/$defs/HostMessage'
      ).valid
    ).toBe(true);
    expect(
      validateAgainstSchema(
        ROOT_SCHEMA,
        { type: CMD_ACK, correlationId: 'corr-bad-rej-outcome', status: 'rejected', outcome: 'accepted' },
        '#/$defs/HostMessage'
      ).valid
    ).toBe(false);
    for (const badStatus of ['refused', 'failed', 'unknown-status'] as const) {
      expect(
        validateAgainstSchema(
          ROOT_SCHEMA,
          { type: CMD_ACK, correlationId: `corr-${badStatus}`, status: badStatus },
          '#/$defs/HostMessage'
        ).valid
      ).toBe(false);
    }
  });
});
