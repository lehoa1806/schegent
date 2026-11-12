/**
 * Review gap GC-08 (2026-11-12) — the ACP authority gate's primacy probe must not be satisfied by
 * "a SQLite store is attached": a window opens its store while primary and keeps it after losing
 * primacy. And the gate's receipt writer must say when a receipt goes nowhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  writer: undefined as { run(sql: string, ...params: unknown[]): void } | undefined
}));

vi.mock('../../../src/activation/sqlite-cutover-wiring', () => ({
  getSqliteCutoverCoordinator: () => ({
    getSqliteStore: () =>
      registry.writer === undefined ? null : { writerConnection: registry.writer },
    recordAcpObservation: () => undefined
  })
}));

import { buildHostAcpDispatchOptions } from '../../../src/activation/acp-execution-wiring';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';

type Dispatch = ReturnType<typeof buildHostAcpDispatchOptions>;
type Gate = NonNullable<Dispatch['authorityGate']>;

const SESSION = 'sess-1';
const WIRING_OWNERSHIP_GENERATION = 1;

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

function build(options: {
  readonly primary: boolean;
  readonly logger?: ReturnType<typeof makeLogger>;
}): { readonly dispatch: Dispatch; readonly gate: Gate } {
  const dispatch = buildHostAcpDispatchOptions({
    workspaceRoot: '/workspace',
    store: {} as WorkspaceStateStore,
    logger: (options.logger ?? makeLogger()) as never,
    isWorkspaceTrusted: () => true,
    hasPrimacy: () => Promise.resolve(options.primary)
  });
  const gate = dispatch.authorityGate;
  if (gate === undefined) throw new Error('wiring built no authority gate');
  gate.registerScope({
    attemptId: 'att-1',
    acpSessionId: SESSION,
    connectionGeneration: 1,
    ownershipGeneration: WIRING_OWNERSHIP_GENERATION,
    executionRoot: '/workspace',
    primaryWorkspaceRoot: '/workspace'
  });
  return { dispatch, gate };
}

function readRequest(): Parameters<Gate['authorize']>[0] {
  return { requestKind: 'filesystem', acpSessionId: SESSION, connectionGeneration: 1, mutating: false };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('GC-08 — ACP authority gate primacy and receipt writer wiring', () => {
  beforeEach(() => {
    registry.writer = { run: vi.fn() };
  });

  it('denies a window that lost primacy though its SQLite store is still attached', async () => {
    const { dispatch, gate } = build({ primary: false });

    dispatch.currentOwnershipGeneration?.();
    await settle();

    const decision = gate.authorize(readRequest());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('ownership-lost');
  });

  it('denies from the callback after the first verify, when no session start ran one', async () => {
    const { gate } = build({ primary: false });

    gate.authorize(readRequest());
    await settle();

    expect(gate.authorize(readRequest()).reason).toBe('ownership-lost');
  });

  it('lets an attached store stand in for primacy only until the first verdict lands', () => {
    const { gate } = build({ primary: true });

    expect(gate.authorize(readRequest()).allowed).toBe(true);
  });

  it('denies before the first verdict when no store is attached', () => {
    registry.writer = undefined;
    const { gate } = build({ primary: true });

    expect(gate.authorize(readRequest()).reason).toBe('ownership-lost');
  });

  it('reports a receipt with no store to write it to, once', async () => {
    registry.writer = undefined;
    const logger = makeLogger();
    const { dispatch, gate } = build({ primary: true, logger });
    dispatch.currentOwnershipGeneration?.();
    await settle();

    expect(gate.authorize(readRequest()).allowed).toBe(true);
    gate.authorize(readRequest());

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      operation: 'acp-authorization-receipt',
      error: 'AcpReceiptStoreDetachedError'
    });
  });

  it('reports a receipt write the database refused', () => {
    registry.writer = {
      run: () => {
        throw new RangeError('constraint');
      }
    };
    const logger = makeLogger();
    const { gate } = build({ primary: true, logger });

    expect(gate.authorize(readRequest()).allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      operation: 'acp-authorization-receipt',
      error: 'RangeError'
    });
  });
});
