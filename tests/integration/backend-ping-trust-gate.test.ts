// FR-R4-F05 (FR-004, FR-006 to FR-008, SC-002; contract T, T1; contract C, C7, C8)
// — raw `CMD_PING_BACKEND` is refused before any process starts and before any
// `backend-ping` audit row, in an untrusted workspace and in a trusted secondary
// window.
//
// WHY A WIRED TEST. `CMD_PING_BACKEND` was read-only in the router's table, so the
// workspace-trust check never saw it, while the handler it reached starts the
// backend CLI with `--help` in the workspace folder. A unit test of the router with
// a stubbed `ping` could not notice: the stub never spawns. This one builds the
// production `MessageRouter` and `HANDLERS` over a real `BackendPingService` over a
// real `BackendCapabilityService`, whose `spawnFn` counts calls, and an audit writer
// that records appends. The message is sent raw, the way a hostile webview would,
// with no UI in between.
//
// The trusted-primary cases are pins: Ping there is unchanged (FR-007).

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { BackendCapabilityService } from '../../src/services/backend-capability-service';
import { BackendPingService } from '../../src/services/backend-ping-service';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';
import type { RouterDeps } from '../../src/ui/sidebar/commands/router-types';

const SYNTHETIC_CLI_PATH = '/synthetic/home/user-252/bin/claude';
const SYNTHETIC_PROBE_OUTPUT = 'SYNTHETIC-MARKER-252-1';

interface FakeChild extends ChildProcess {
  readonly kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    pid: 252,
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(() => true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn()
  });
  return child;
}

function closeChild(child: FakeChild, code: number): void {
  Object.defineProperty(child, 'exitCode', { value: code, configurable: true });
  child.emit('close', code, null);
}

interface AuditRow {
  readonly eventType: string;
  readonly runId: string;
}

interface Harness {
  readonly router: MessageRouter;
  readonly spawns: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  readonly rows: AuditRow[];
  readonly logCalls: unknown[][];
  readonly heldChildren: FakeChild[];
  /** Settles once the nth process has been spawned; no timer is involved. */
  readonly spawned: (count: number) => Promise<void>;
  readonly acksFor: (correlationId: string) => CommandAckMessage[];
  readonly send: (correlationId: string, runner?: string) => Promise<void>;
}

/**
 * Builds the production router over the real Ping service. `holdProbe` leaves each
 * spawned child open until the test closes it; otherwise it closes at once.
 */
function build(input: {
  readonly isPrimary: () => boolean;
  readonly isTrusted?: (() => boolean) | undefined;
  readonly holdProbe?: boolean;
}): Harness {
  const spawns: Harness['spawns'] = [];
  const rows: AuditRow[] = [];
  const logCalls: unknown[][] = [];
  const heldChildren: FakeChild[] = [];
  const allAcks = new Map<string, CommandAckMessage[]>();
  const spawnWaiters: Array<{ count: number; resolve: () => void }> = [];

  const record = (level: string) => (...args: unknown[]) => {
    logCalls.push([level, ...args]);
  };
  const logger = {
    info: vi.fn(record('info')),
    warn: vi.fn(record('warn')),
    error: vi.fn(record('error')),
    debug: vi.fn(record('debug')),
    sanitize: (value: string) => value
  };

  const capabilities = new BackendCapabilityService({
    cwd: '/synthetic/workspace-252',
    resolveCliPath: () => SYNTHETIC_CLI_PATH,
    readTimeoutSeconds: () => 5,
    buildEnv: () => ({ PATH: '/synthetic/bin' }),
    logger: { debug: vi.fn(), warn: vi.fn() },
    spawnFn: (command, args, options) => {
      spawns.push({ command, args, options });
      for (const waiter of spawnWaiters) {
        if (spawns.length >= waiter.count) waiter.resolve();
      }
      const child = makeChild();
      if (input.holdProbe) {
        heldChildren.push(child);
      } else {
        queueMicrotask(() => {
          child.stdout?.emit('data', Buffer.from(SYNTHETIC_PROBE_OUTPUT));
          closeChild(child, 0);
        });
      }
      return child;
    }
  });
  const backendPingService = new BackendPingService({
    capabilities,
    readTimeoutSeconds: () => 5,
    audit: {
      append: async (entry) => {
        rows.push({ eventType: entry.eventType, runId: entry.runId });
      }
    },
    logger: { warn: vi.fn() }
  });

  const deps: RouterDeps = {
    executeCommand: async <T = unknown>() => undefined as T,
    isPrimary: input.isPrimary,
    ...(input.isTrusted ? { isTrusted: input.isTrusted } : {}),
    logger,
    backendPingService
  };
  const router = new MessageRouter(deps);

  return {
    router,
    spawns,
    rows,
    logCalls,
    heldChildren,
    spawned: (count) =>
      spawns.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            spawnWaiters.push({ count, resolve });
          }),
    acksFor: (correlationId) => allAcks.get(correlationId) ?? [],
    send: async (correlationId, runner = 'claude') => {
      await router.dispatch(
        // The payload is built raw: this is the shape a hostile webview posts.
        { type: 'CMD_PING_BACKEND', correlationId, payload: { runner } } as never,
        async (ack) => {
          allAcks.set(correlationId, [...(allAcks.get(correlationId) ?? []), ack]);
          return true;
        }
      );
    }
  };
}

function expectNoProbeDetail(logCalls: readonly unknown[][]): void {
  const serialized = JSON.stringify(logCalls);
  expect(serialized).not.toContain('user-252');
  expect(serialized).not.toContain('--help');
  expect(serialized).not.toContain(SYNTHETIC_PROBE_OUTPUT);
}

describe('raw CMD_PING_BACKEND under the router gate (T1)', () => {
  const untrustedCases: ReadonlyArray<readonly [string, (() => boolean) | undefined]> = [
    ['trust reports false', () => false],
    ['the trust callback is missing', undefined],
    [
      'the trust callback throws',
      () => {
        throw new Error('synthetic trust failure');
      }
    ]
  ];

  it.each(untrustedCases)(
    'refuses with untrusted-workspace, no spawn and no row, when %s',
    async (_label, isTrusted) => {
      const harness = build({ isPrimary: () => true, isTrusted });

      await harness.send('untrusted-ping');

      // The effects first: a refusal that still spawned is the defect, whatever
      // the ack says.
      expect(harness.spawns).toHaveLength(0);
      expect(harness.rows.filter((row) => row.eventType === 'backend-ping')).toHaveLength(0);
      expect(harness.acksFor('untrusted-ping')).toEqual([
        expect.objectContaining({ status: 'rejected', reason: 'untrusted-workspace' })
      ]);
      expectNoProbeDetail(harness.logCalls);
    }
  );

  it('refuses with secondary-window-readonly, no spawn and no row, in a trusted secondary window', async () => {
    const harness = build({ isPrimary: () => false, isTrusted: () => true });

    await harness.send('secondary-ping');

    expect(harness.spawns).toHaveLength(0);
    expect(harness.rows).toHaveLength(0);
    expect(harness.acksFor('secondary-ping')).toEqual([
      expect.objectContaining({ status: 'rejected', reason: 'secondary-window-readonly' })
    ]);
    expectNoProbeDetail(harness.logCalls);
  });

  it('logs each refusal with the command type and correlation id only', async () => {
    const untrusted = build({ isPrimary: () => true, isTrusted: () => false });
    await untrusted.send('untrusted-log');
    const secondary = build({ isPrimary: () => false, isTrusted: () => true });
    await secondary.send('secondary-log');

    const refusalLine = (calls: readonly unknown[][], text: string): unknown[] | undefined =>
      calls.find((call) => call[0] === 'warn' && call[1] === text);
    expect(refusalLine(untrusted.logCalls, 'router: rejected by workspace-trust gate')).toEqual([
      'warn',
      'router: rejected by workspace-trust gate',
      { type: 'CMD_PING_BACKEND', correlationId: 'untrusted-log' }
    ]);
    expect(refusalLine(secondary.logCalls, 'router: rejected by primary-host gate')).toEqual([
      'warn',
      'router: rejected by primary-host gate',
      { type: 'CMD_PING_BACKEND', correlationId: 'secondary-log' }
    ]);
  });

  describe('trusted primary window (pins, FR-007)', () => {
    it('accepts, spawns once and reports the bounded state', async () => {
      const harness = build({ isPrimary: () => true, isTrusted: () => true });

      await harness.send('primary-ping');

      const [accepted] = harness.acksFor('primary-ping');
      expect(accepted).toMatchObject({ status: 'accepted' });
      expect(harness.spawns).toHaveLength(1);
      expect(harness.spawns[0]?.args).toEqual(['--help']);
      expect(harness.rows).toEqual([{ eventType: 'backend-ping', runId: 'backend-ping:claude' }]);
    });

    it('answers already-in-progress to a second Ping while the first probe is held', async () => {
      const harness = build({ isPrimary: () => true, isTrusted: () => true, holdProbe: true });

      const first = harness.send('held-first');
      await harness.spawned(1);
      await harness.send('held-second');

      expect(harness.acksFor('held-second')).toEqual([
        expect.objectContaining({ status: 'rejected', reason: 'already-in-progress' })
      ]);
      expect(harness.spawns).toHaveLength(1);

      const [held] = harness.heldChildren;
      expect(held).toBeDefined();
      closeChild(held!, 0);
      await first;
      expect(harness.acksFor('held-first')).toEqual([
        expect.objectContaining({ status: 'accepted' })
      ]);
    });
  });
});
