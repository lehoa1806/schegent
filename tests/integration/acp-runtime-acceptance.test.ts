// FR-R6-F13 T033 — the ACP runtime acceptance scenarios (quickstart), end to end through the
// stdio transport and the synthetic child-process agent.
//
// WHAT THIS PINS:
//   - AC-01: an unqualified profile refuses with no launch; protocol version 2 and a silent
//     initialize refuse before any session request, and nothing falls back;
//   - AC-02: a prompt keeps the host attempt, root and generation on every observation, every
//     observation is an F02 envelope F02 accepts, and the projection holds no launch value;
//   - AC-03: a session/load replay is history, unattributed and replayed usage;
//   - AC-04: default denial, refused filesystem and terminal requests, and a cancel the agent
//     ignores ends in teardown on the bound, with SIGKILL after the SIGTERM it ignores;
//   - AC-05: an oversized frame fails the connection;
//   - AC-06: the release matrix names zero qualified profiles and the Claude, Codex and Agy gaps;
//   - AC-07: stderr is never protocol and is kept sanitized; a malformed frame fails the
//     connection; repeated request ids on a new generation stay separate;
//   - AC-08: a missing required capability refuses; end_turn still needs host validation;
//   - AC-09: a crash after the prompt write is uncertain and nothing is re-sent; an agent that
//     closes its stdin and lives on fails the connection without any deadline.
//
// Deferred: F15 delivery (AC-02) and the legacy cutover (FR-021, AC-09). The mapping latency
// bound (AC-05) is the perf tier.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AcpObservation,
  AcpOpenOptions,
  AcpOpenResult,
  AcpTransport,
  AgentProfile
} from '../../src/contracts/acp-runtime';
import { normalizeAcpEventToDomainFixtures } from '../../src/contracts/shared-memory-storage/artifacts-streams-and-acp';
import { createObservationLedgerState } from '../../src/contracts/shared-memory-storage/identity-and-observations';
import { openAcpConnection, spawnStdioTransport, toSharedAcpEnvelope } from '../../src/services/acp-runtime/index';
import { FakeClock, flush } from '../fixtures/acp/memory-agent';

const AGENT = resolve(__dirname, '..', 'fixtures', 'acp', 'fake-acp-agent.mjs');
const RUNBOOK = resolve(__dirname, '..', '..', 'docs', 'operations', 'acp-runtime.md');
const SESSION = 'fixture-session-1';
const WAIT_MS = 20_000;
// A shell agent that answers `initialize`, closes its own stdin and lives on. Node cannot play
// this agent: it keeps descriptor 0 open, and libuv aborts on an explicit close of it.
const INIT_ANSWER = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
const CLOSES_STDIN_AND_LIVES = `IFS= read -r _line; printf '%s\\n' '${INIT_ANSWER}'; exec 0<&-; exec sleep 30`;
const BEL = String.fromCodePoint(0x07);
const ESC = String.fromCodePoint(0x1b);

const PROFILE: AgentProfile = {
  profileId: 'fixture-agent',
  revision: 3,
  kind: 'native',
  executableRef: 'fake-acp-agent-bin',
  attribution: { provider: 'fixture-provider', backend: 'fixture-backend', model: 'fixture-model' },
  requiredCapabilities: [],
  qualification: 'fixture'
};

interface Opened {
  readonly result: AcpOpenResult;
  readonly observations: AcpObservation[];
  readonly launches: { count: number; closes: number };
  readonly clock: FakeClock;
}

function options(scenario: string, extra: Partial<AcpOpenOptions> = {}) {
  const observations: AcpObservation[] = [];
  const launches = { count: 0, closes: 0 };
  const clock = new FakeClock();
  const open: AcpOpenOptions = {
    profile: PROFILE,
    generation: 7,
    allowFixtureProfiles: true,
    clock,
    launch: (): AcpTransport => {
      launches.count += 1;
      const transport = spawnStdioTransport({ command: process.execPath, args: [AGENT, scenario], cwd: process.cwd(), env: {} });
      transport.onClose(() => {
        launches.closes += 1;
      });
      return transport;
    },
    onObservation: (observation) => {
      observations.push(observation);
    },
    ...extra
  };
  return { open, observations, launches, clock };
}

async function openWith(scenario: string, extra: Partial<AcpOpenOptions> = {}): Promise<Opened> {
  const built = options(scenario, extra);
  const result = await openAcpConnection(built.open);
  return { result, observations: built.observations, launches: built.launches, clock: built.clock };
}

async function connected(scenario: string, extra: Partial<AcpOpenOptions> = {}) {
  const opened = await openWith(scenario, extra);
  if (!opened.result.ok) throw new Error(`open refused: ${opened.result.refusal}`);
  const { connection } = opened.result;
  expect(await connection.newSession(process.cwd())).toEqual({ ok: true, sessionId: SESSION });
  return { ...opened, connection };
}

function prompt(attemptId = 'attempt-1') {
  return { sessionId: SESSION, attemptId, rootId: 'root-1', blocks: [{ type: 'text', text: 'hello' }] } as const;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ACP runtime acceptance', () => {
  it('AC-01: refuses unqualified, version 2 and a silent initialize before any session request', async () => {
    const unqualified = await openWith('basic', { profile: { ...PROFILE, qualification: 'unqualified' } });
    expect(unqualified.result).toMatchObject({ ok: false, refusal: 'profile-unqualified' });
    expect(unqualified.launches.count).toBe(0);

    const version2 = await openWith('version-2');
    expect(version2.result).toMatchObject({ ok: false, refusal: 'protocol-version-unsupported' });
    expect(version2.launches.count).toBe(1);
    await waitFor(() => version2.launches.closes === 1);

    const silent = options('silent');
    const pending = openAcpConnection(silent.open);
    await waitFor(() => silent.launches.count === 1);
    await flush();
    silent.clock.advance(5_000);
    expect(await pending).toMatchObject({ ok: false, refusal: 'handshake-deadline' });
    await waitFor(() => silent.launches.closes === 1);
    expect(silent.launches.count).toBe(1);
  }, WAIT_MS);

  it('AC-02 and AC-08: a prompt keeps the host identities, F02 accepts every envelope, end_turn needs validation', async () => {
    const { connection, observations } = await connected('basic');
    expect(await connection.prompt(prompt())).toEqual({
      kind: 'completed',
      turnId: 'turn-7-1',
      stopReason: 'end_turn',
      hostValidationRequired: true
    });
    expect(observations.map((observation) => observation.kind)).toContain('usage');
    const ledger = createObservationLedgerState();
    for (const observation of observations) {
      expect(observation).toMatchObject({ generation: 7, origin: 'live', attemptId: 'attempt-1' });
      const outcome = normalizeAcpEventToDomainFixtures(toSharedAcpEnvelope(observation, PROFILE), {
        workspaceId: 'ws-1',
        queueId: 'default',
        rootExecutionId: 'root-1',
        invocationId: 'inv-1',
        attemptId: 'attempt-1',
        activeConnectionGeneration: 7,
        hostResultValidated: false,
        ledger
      });
      expect(outcome.status).toBe('accepted');
    }
    const projection = JSON.stringify(connection.describe());
    for (const launchValue of [AGENT, process.execPath, 'fake-acp-agent-bin']) {
      expect(projection.includes(launchValue)).toBe(false);
    }
    await connection.close();
  }, WAIT_MS);

  it('AC-03: a session/load replay is history, unattributed, and replayed usage', async () => {
    const opened = await openWith('history');
    if (!opened.result.ok) throw new Error('open refused');
    const loaded = await opened.result.connection.loadSession(SESSION, process.cwd(), { mayLoad: true });
    expect(loaded).toEqual({ ok: true, sessionId: SESSION });
    expect(opened.observations.length).toBeGreaterThan(0);
    for (const observation of opened.observations) {
      expect(observation).toMatchObject({ origin: 'history', attemptId: null, binding: null });
    }
    const usage = opened.observations.find((observation) => observation.kind === 'usage');
    expect(usage?.kind === 'usage' && usage.usage.replayed).toBe(true);
    await opened.result.connection.close();
  }, WAIT_MS);

  it('AC-04: refuses filesystem and terminal requests and denies permission by default', async () => {
    const { connection } = await connected('permission');
    expect(await connection.prompt(prompt())).toMatchObject({ kind: 'completed', stopReason: 'refusal' });
    expect(connection.describe().counters).toMatchObject({ refusedAgentRequests: 2, permissionRequests: 1 });
    await connection.close();
  }, WAIT_MS);

  it('AC-04: a cancel the agent ignores tears down on the bound, killing an agent that ignores SIGTERM', async () => {
    const { connection, clock, observations, launches } = await connected('hang');
    const outcome = connection.prompt(prompt());
    await waitFor(() => observations.some((observation) => observation.kind === 'display'));
    connection.cancel(SESSION);
    clock.advance(4_999);
    await flush();
    expect(launches.closes).toBe(0);
    const started = Date.now();
    clock.advance(1);
    expect(await outcome).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason: 'cancel-bound-elapsed' });
    await connection.close();
    await waitFor(() => launches.closes === 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(connection.describe()).toMatchObject({ lastFailure: 'cancel-bound-elapsed' });
  }, WAIT_MS);

  it.each([
    ['oversized', 'frame-oversized'],
    ['malformed', 'malformed-frame']
  ] as const)('AC-05 and AC-07: a %s frame fails the connection with %s', async (scenario, reason) => {
    const { connection, launches } = await connected(scenario);
    expect(await connection.prompt(prompt())).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: reason });
    await waitFor(() => launches.closes === 1);
  }, WAIT_MS);

  it('AC-06: the release matrix names the qualified darwin/arm64 profiles and unqualified platform boundary', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8');
    expect(runbook).toContain('Qualified profiles on `darwin/arm64`: 3');
    for (const profileId of ['claude-acp-bridge', 'codex-acp-bridge', 'agy-acp-native']) {
      expect(runbook).toMatch(new RegExp(`^\\| \`${profileId}\` \\| \`(bridge|native)\` \\| \`qualified\` \\|`, 'm'));
    }
    expect(runbook).toContain('profile-unqualified');
  });

  it('AC-07: stderr is never protocol, and the kept tail is sanitized', async () => {
    const { connection } = await connected('stderr-noise');
    expect(connection.describe().capabilities).toMatchObject({ protocolVersion: 1 });
    expect(await connection.prompt(prompt())).toMatchObject({ kind: 'completed', stopReason: 'end_turn' });
    await waitFor(() => connection.stderrTail().includes('warn'));
    const tail = connection.stderrTail();
    expect(tail.includes(BEL)).toBe(false);
    expect(tail.includes(ESC)).toBe(false);
    await connection.close();
  }, WAIT_MS);

  it('AC-07: repeated request ids on a new generation stay separate', async () => {
    const first = await connected('basic', { generation: 1 });
    const second = await connected('basic', { generation: 2 });
    expect(await first.connection.prompt(prompt('attempt-a'))).toMatchObject({ kind: 'completed', turnId: 'turn-1-1' });
    expect(await second.connection.prompt(prompt('attempt-b'))).toMatchObject({ kind: 'completed', turnId: 'turn-2-1' });
    const startOf = (observations: readonly AcpObservation[]) =>
      observations.find((observation) => observation.kind === 'turn-started');
    const a = startOf(first.observations);
    const b = startOf(second.observations);
    expect(a?.kind === 'turn-started' && b?.kind === 'turn-started' && a.requestId === b.requestId).toBe(true);
    expect(first.observations.every((observation) => observation.generation === 1 && observation.attemptId === 'attempt-a')).toBe(true);
    expect(second.observations.every((observation) => observation.generation === 2 && observation.attemptId === 'attempt-b')).toBe(true);
    await Promise.all([first.connection.close(), second.connection.close()]);
  }, WAIT_MS);

  it('AC-08: a required capability the agent did not grant refuses, and the agent is closed', async () => {
    const opened = await openWith('no-load', { profile: { ...PROFILE, requiredCapabilities: ['load-session'] } });
    expect(opened.result).toMatchObject({ ok: false, refusal: 'capability-missing' });
    await waitFor(() => opened.launches.closes === 1);
  }, WAIT_MS);

  it('AC-09: a crash after the prompt write is uncertain, and nothing is re-sent', async () => {
    const { connection, launches } = await connected('crash-after-prompt');
    expect(await connection.prompt(prompt())).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason: 'transport-closed' });
    expect(await connection.prompt(prompt())).toEqual({ kind: 'refused', reason: 'connection-not-ready' });
    expect(launches.count).toBe(1);
  }, WAIT_MS);

  // Review R-3. The clock is fake and never advanced, so no deadline can end this request:
  // only the lost stdin can.
  it('AC-09: an agent that closes its stdin and lives on fails the connection, with no deadline', async () => {
    const closes: number[] = [];
    const launch = (): AcpTransport => {
      const transport = spawnStdioTransport({ command: '/bin/sh', args: ['-c', CLOSES_STDIN_AND_LIVES], cwd: process.cwd(), env: {} });
      transport.onClose(() => closes.push(1));
      return transport;
    };
    const opened = await openWith('closes-stdin', { launch });
    if (!opened.result.ok) throw new Error(`open refused: ${opened.result.refusal}`);
    const { connection } = opened.result;
    expect(await connection.newSession(process.cwd())).toEqual({ ok: false, reason: 'transport-closed' });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: 'transport-closed', sessionCount: 0 });
    expect(closes).toEqual([1]);
    expect(await connection.newSession(process.cwd())).toEqual({ ok: false, reason: 'connection-not-ready' });
  }, WAIT_MS);
});
