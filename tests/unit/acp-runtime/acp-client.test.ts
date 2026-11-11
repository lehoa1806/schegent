// FR-R6-F13 T017, T023, T026, T029, T030, T031 — the ACP client against an in-memory agent and a
// fake clock: qualification, the prompt lifecycle and attribution, capability refusals,
// cancellation, reconnect, and a hostile transport.
import { describe, expect, it } from 'vitest';

import type {
  AcpObservation,
  AcpOpenOptions,
  AcpPromptRequest,
  AgentProfile
} from '../../../src/contracts/acp-runtime';
import { openAcpConnection } from '../../../src/services/acp-runtime/acp-client';
import { FakeClock, flush, MemoryAgent } from '../../fixtures/acp/memory-agent';

const FIXTURE_PROFILE: AgentProfile = {
  profileId: 'fixture-agent',
  revision: 3,
  kind: 'native',
  executableRef: 'fake-acp-agent-bin',
  attribution: { provider: 'fixture-provider', backend: 'fixture-backend', model: 'fixture-model' },
  requiredCapabilities: [],
  qualification: 'fixture'
};

const FULL_INIT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
  authMethods: []
};
const BARE_INIT = { protocolVersion: 1 };
const START_UTC = '2026-11-11T00:00:00.000Z';
const PERMISSION = {
  sessionId: 'sess-1',
  toolCall: { toolCallId: 'call-9', title: 'Write file' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
  ]
};
const MESSAGE_CHUNK = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } };

function agentWith(init: unknown = FULL_INIT): MemoryAgent {
  return new MemoryAgent()
    .on('initialize', () => ({ result: init }))
    .on('session/new', () => ({ result: { sessionId: 'sess-1' } }));
}

function request(blocks: AcpPromptRequest['blocks'] = [{ type: 'text', text: 'hello' }]): AcpPromptRequest {
  return { sessionId: 'sess-1', attemptId: 'attempt-1', rootId: 'root-1', blocks };
}

interface Harness {
  readonly options: AcpOpenOptions;
  readonly clock: FakeClock;
  readonly observations: AcpObservation[];
  readonly launches: { count: number };
}

function harness(agent: MemoryAgent, extra: Partial<AcpOpenOptions> = {}): Harness {
  const clock = new FakeClock();
  const observations: AcpObservation[] = [];
  const launches = { count: 0 };
  const options: AcpOpenOptions = {
    profile: FIXTURE_PROFILE,
    generation: 7,
    allowFixtureProfiles: true,
    launch: () => {
      launches.count += 1;
      return agent;
    },
    clock,
    onObservation: (observation) => {
      observations.push(observation);
    },
    ...extra
  };
  return { options, clock, observations, launches };
}

async function ready(agent: MemoryAgent, extra: Partial<AcpOpenOptions> = {}) {
  const parts = harness(agent, extra);
  const opened = await openAcpConnection(parts.options);
  if (!opened.ok) throw new Error(`open refused: ${opened.refusal}`);
  return { ...parts, connection: opened.connection };
}

async function withSession(agent: MemoryAgent, extra: Partial<AcpOpenOptions> = {}) {
  const parts = await ready(agent, extra);
  const created = await parts.connection.newSession('/work');
  if (!created.ok) throw new Error('session refused');
  return parts;
}

function lastId(agent: MemoryAgent, method: string): number {
  const message = agent.sent(method).at(-1);
  if (message === undefined || typeof message.id !== 'number') throw new Error(`no ${method} written`);
  return message.id;
}

function answerPrompt(agent: MemoryAgent, stopReason: string): void {
  agent.sendLater({ jsonrpc: '2.0', id: lastId(agent, 'session/prompt'), result: { stopReason } });
}

function displays(observations: readonly AcpObservation[]) {
  return observations.filter((observation) => observation.kind === 'display');
}

describe('openAcpConnection — qualification (US1)', () => {
  it('refuses an unqualified profile without launching', async () => {
    const parts = harness(agentWith(), { profile: { ...FIXTURE_PROFILE, qualification: 'unqualified' } });
    expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'profile-unqualified' });
    expect(parts.launches.count).toBe(0);
  });

  it('refuses a fixture profile unless fixture profiles are allowed', async () => {
    const parts = harness(agentWith(), { allowFixtureProfiles: false });
    expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'profile-unqualified' });
    expect(parts.launches.count).toBe(0);
  });

  it('refuses an invalid profile or generation without launching', async () => {
    for (const extra of [{ profile: { ...FIXTURE_PROFILE, profileId: '' } }, { generation: 0 }, { generation: 1.5 }]) {
      const parts = harness(agentWith(), extra);
      expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'invalid-input' });
      expect(parts.launches.count).toBe(0);
    }
  });

  it('opens a qualified profile without the fixture allowance', async () => {
    const parts = harness(agentWith(), { profile: { ...FIXTURE_PROFILE, qualification: 'qualified' }, allowFixtureProfiles: false });
    expect(await openAcpConnection(parts.options)).toMatchObject({ ok: true });
  });

  it('reports a launch that throws as transport-closed', async () => {
    const parts = harness(agentWith(), {
      launch: () => {
        throw new Error('spawn failed');
      }
    });
    expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'transport-closed' });
  });

  it('advertises no file system and no terminal', async () => {
    const agent = agentWith();
    await ready(agent);
    expect(agent.sent('initialize')).toMatchObject([
      { params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }
    ]);
  });
});

describe('prompt lifecycle (US1)', () => {
  function streamingAgent(): MemoryAgent {
    const agent = agentWith();
    agent.on('session/prompt', () => {
      agent.update('sess-1', MESSAGE_CHUNK);
      agent.update('sess-1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      agent.update('sess-1', { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read file', rawInput: { path: 'a' } });
      agent.update('sess-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
      });
      agent.update('sess-1', { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'high' }] });
      agent.update('sess-1', { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.25, currency: 'USD' } });
      return { result: { stopReason: 'end_turn' } };
    });
    return agent;
  }

  const BINDING = {
    profileId: 'fixture-agent',
    acpSessionId: 'sess-1',
    connectionGeneration: 7,
    turnId: 'turn-7-1',
    rootId: 'root-1',
    attemptId: 'attempt-1'
  };

  it('ends end_turn with host validation still required', async () => {
    const agent = streamingAgent();
    const { connection } = await withSession(agent);
    expect(await connection.prompt(request())).toEqual({
      kind: 'completed',
      turnId: 'turn-7-1',
      stopReason: 'end_turn',
      hostValidationRequired: true
    });
    expect(agent.sent('session/new')).toMatchObject([{ params: { cwd: '/work', mcpServers: [] } }]);
    expect(agent.sent('session/prompt')).toMatchObject([{ params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hello' }] } }]);
  });

  it('attributes every observation to the attempt, turn and generation, in receive order', async () => {
    const agent = streamingAgent();
    const { connection, observations } = await withSession(agent);
    await connection.prompt(request());
    expect(observations.map((observation) => observation.kind)).toEqual([
      'turn-started',
      'display',
      'display',
      'display',
      'display',
      'display',
      'usage',
      'turn-completed'
    ]);
    expect(observations.map((observation) => observation.hostReceiveSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        generation: 7,
        origin: 'live',
        acpSessionId: 'sess-1',
        turnId: 'turn-7-1',
        attemptId: 'attempt-1',
        binding: BINDING,
        observedAtUtc: START_UTC
      });
    }
    expect(displays(observations).map((observation) => observation.event.kind)).toEqual([
      'message',
      'status',
      'tool-call',
      'tool-result',
      'plan'
    ]);
    expect(displays(observations).at(0)).toMatchObject({
      event: { connectionGeneration: '7', attemptId: 'attempt-1', origin: 'live', kind: 'message', text: 'Hello' }
    });
  });

  it('emits usage as an F06 update carrying the binding identities', async () => {
    const agent = streamingAgent();
    const { connection, observations } = await withSession(agent);
    await connection.prompt(request());
    const usage = observations.find((observation) => observation.kind === 'usage');
    expect(usage).toMatchObject({
      binding: BINDING,
      usage: {
        profileId: 'fixture-agent',
        acpSessionId: 'sess-1',
        connectionGeneration: 7,
        turnId: 'turn-7-1',
        hostReceiveSeq: 7,
        eventUtc: START_UTC,
        replayed: false,
        used: 1200,
        size: 200000,
        cost: { amount: '0.25', currency: 'USD' },
        hasQualifiedSessionBaseline: false
      }
    });
  });

  it('keeps an observer that throws from breaking the turn', async () => {
    const agent = streamingAgent();
    const { connection } = await withSession(agent, {
      onObservation: () => {
        throw new Error('observer bug');
      }
    });
    expect(await connection.prompt(request())).toMatchObject({ kind: 'completed' });
  });

  it('numbers turns per connection', async () => {
    const agent = streamingAgent();
    const { connection } = await withSession(agent);
    await connection.prompt(request());
    expect(await connection.prompt(request())).toMatchObject({ turnId: 'turn-7-2' });
  });
});

describe('projection (US1)', () => {
  it('shows capabilities, qualification, attribution and counters, and no launch value', async () => {
    const agent = agentWith();
    const { connection } = await withSession(agent);
    agent.stderr('agent warning\n');
    const projection = connection.describe();
    expect(projection).toEqual({
      profileId: 'fixture-agent',
      profileRevision: 3,
      profileKind: 'native',
      qualification: 'fixture',
      attribution: { provider: 'fixture-provider', backend: 'fixture-backend', model: 'fixture-model' },
      generation: 7,
      state: 'ready',
      capabilities: { protocolVersion: 1, loadSession: true, image: false, audio: false, embeddedContext: true, authMethodCount: 0 },
      lastRefusal: null,
      lastFailure: null,
      sessionCount: 1,
      counters: {
        unknownResponses: 0,
        duplicateResponses: 0,
        staleUpdates: 0,
        ignoredUpdates: 0,
        unknownNotifications: 0,
        refusedAgentRequests: 0,
        permissionRequests: 0
      }
    });
    expect(JSON.stringify(projection)).not.toContain('fake-acp-agent-bin');
    expect(JSON.stringify(projection)).not.toContain('agent warning');
    expect(connection.stderrTail()).toBe('agent warning\n');
  });
});

describe('capability refusals (US2)', () => {
  it('refuses protocol version 2 before any session request', async () => {
    const agent = agentWith({ protocolVersion: 2 });
    const parts = harness(agent);
    expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'protocol-version-unsupported' });
    expect(agent.sent('session/new')).toHaveLength(0);
    expect(agent.closeCalls).toBe(1);
  });

  it('refuses a profile requirement the agent did not grant, with no session/new written', async () => {
    const agent = agentWith(BARE_INIT);
    const parts = harness(agent, { profile: { ...FIXTURE_PROFILE, requiredCapabilities: ['load-session'] } });
    expect(await openAcpConnection(parts.options)).toEqual({ ok: false, refusal: 'capability-missing', detail: 'load-session' });
    expect(agent.sent('session/new')).toHaveLength(0);
    expect(agent.closeCalls).toBe(1);
  });

  it('refuses an initialize error answer as a protocol violation', async () => {
    const agent = new MemoryAgent().on('initialize', () => ({ error: { code: -32603, message: 'boom' } }));
    expect(await openAcpConnection(harness(agent).options)).toMatchObject({ ok: false, refusal: 'protocol-violation' });
    expect(agent.closeCalls).toBe(1);
  });

  it('refuses an embedded resource without embeddedContext, writing nothing', async () => {
    const agent = agentWith(BARE_INIT);
    const { connection } = await withSession(agent);
    const before = agent.written.length;
    expect(await connection.prompt(request([{ type: 'embedded-resource', uri: 'file:///a', text: 'x' }]))).toEqual({
      kind: 'refused',
      reason: 'capability-missing',
      detail: 'embedded-context'
    });
    expect(agent.written).toHaveLength(before);
    expect(connection.describe().lastRefusal).toBe('capability-missing');
  });

  it('refuses a resource link the resolver does not accept', async () => {
    const agent = agentWith();
    const { connection } = await withSession(agent, { verifyResourceLink: () => false });
    expect(await connection.prompt(request([{ type: 'resource-link', uri: 'file:///a', name: 'a' }]))).toEqual({
      kind: 'refused',
      reason: 'resource-inaccessible'
    });
  });

  it('refuses an unknown session, a bad identity and a second prompt in flight', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const { connection } = await withSession(agent);
    expect(await connection.prompt({ ...request(), sessionId: 'nope' })).toEqual({ kind: 'refused', reason: 'session-unknown' });
    expect(await connection.prompt({ ...request(), attemptId: '' })).toEqual({ kind: 'refused', reason: 'invalid-input' });
    void connection.prompt(request());
    expect(await connection.prompt(request())).toEqual({ kind: 'refused', reason: 'prompt-in-flight' });
    expect(agent.sent('session/prompt')).toHaveLength(1);
  });
});

describe('cancellation (US3)', () => {
  it('answers permission by policy, then cancelled after cancel, and still maps the turn', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    let asked = 0;
    const { connection, observations, clock } = await withSession(agent, {
      permissionPolicy: () => {
        asked += 1;
        return { optionId: 'allow' };
      }
    });
    const outcome = connection.prompt(request());
    agent.request(100, 'session/request_permission', PERMISSION);
    await flush();
    expect(agent.answersTo(100)).toMatchObject([{ result: { outcome: { outcome: 'selected', optionId: 'allow' } } }]);
    connection.cancel('sess-1');
    connection.cancel('sess-1');
    agent.request(101, 'session/request_permission', PERMISSION);
    agent.update('sess-1', MESSAGE_CHUNK);
    await flush();
    expect(agent.sent('session/cancel')).toMatchObject([{ params: { sessionId: 'sess-1' } }]);
    expect(agent.answersTo(101)).toMatchObject([{ result: { outcome: { outcome: 'cancelled' } } }]);
    const cancelAt = agent.written.findIndex((message) => message.method === 'session/cancel');
    const answerAt = agent.written.findIndex((message) => message.method === undefined && message.id === 101);
    expect(cancelAt).toBeLessThan(answerAt);
    expect(asked).toBe(1);
    expect(displays(observations).at(-1)).toMatchObject({ attemptId: 'attempt-1', turnId: 'turn-7-1' });
    answerPrompt(agent, 'cancelled');
    expect(await outcome).toEqual({ kind: 'cancelled', turnId: 'turn-7-1', hostValidationRequired: true });
    expect(clock.pendingTimers).toBe(0);
    expect(connection.describe()).toMatchObject({ state: 'ready', counters: { permissionRequests: 2 } });
  });

  it('tears down once and fails cancel-bound-elapsed when the agent never answers', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const { connection, clock } = await withSession(agent);
    const outcome = connection.prompt(request());
    connection.cancel('sess-1');
    clock.advance(4_999);
    await flush();
    expect(agent.closeCalls).toBe(0);
    clock.advance(1);
    expect(await outcome).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason: 'cancel-bound-elapsed' });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: 'cancel-bound-elapsed' });
    clock.advance(10_000);
    await flush();
    expect(agent.closeCalls).toBe(1);
  });

  it('writes nothing when cancelling a session with no prompt', async () => {
    const agent = agentWith();
    const { connection } = await withSession(agent);
    connection.cancel('sess-1');
    connection.cancel('nope');
    expect(agent.sent('session/cancel')).toHaveLength(0);
  });
});

describe('reconnect (US4)', () => {
  it('reports a crash after the prompt write as uncertain and re-sends nothing', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const { connection } = await withSession(agent);
    const outcome = connection.prompt(request());
    agent.closeFromAgent();
    expect(await outcome).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason: 'transport-closed' });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: 'transport-closed' });
    expect(await connection.prompt(request())).toEqual({ kind: 'refused', reason: 'connection-not-ready' });
    expect(agent.sent('session/prompt')).toHaveLength(1);
    expect(agent.closeCalls).toBe(1);
  });

  it('keeps a new generation separate when request ids repeat', async () => {
    const first = agentWith().on('session/prompt', () => 'silent');
    const old = await withSession(first);
    const lost = old.connection.prompt(request());
    first.closeFromAgent();
    expect(await lost).toMatchObject({ kind: 'uncertain' });
    const second = agentWith().on('session/prompt', () => 'silent');
    const fresh = await withSession(second, { generation: 8 });
    const outcome = fresh.connection.prompt(request());
    expect(lastId(second, 'session/prompt')).toBe(lastId(first, 'session/prompt'));
    second.sendLater({ jsonrpc: '2.0', id: 99, result: { stopReason: 'end_turn' } });
    answerPrompt(second, 'end_turn');
    expect(await outcome).toMatchObject({ kind: 'completed', turnId: 'turn-8-1' });
    answerPrompt(second, 'end_turn');
    await flush();
    expect(fresh.connection.describe().counters).toMatchObject({ unknownResponses: 1, duplicateResponses: 1 });
  });

  it('refuses session/load without permission to load or without the capability', async () => {
    const loading = await ready(agentWith());
    expect(await loading.connection.loadSession('old-1', '/work', { mayLoad: false })).toEqual({
      ok: false,
      reason: 'fresh-session-required'
    });
    const bare = agentWith(BARE_INIT);
    const plain = await ready(bare);
    expect(await plain.connection.loadSession('old-1', '/work', { mayLoad: true })).toEqual({
      ok: false,
      reason: 'capability-missing',
      detail: 'load-session'
    });
    expect(bare.sent('session/load')).toHaveLength(0);
  });

  it('marks updates during a load as history, unattributed and replayed', async () => {
    const agent = agentWith();
    agent.on('session/load', () => {
      agent.update('old-1', MESSAGE_CHUNK);
      agent.update('old-1', { sessionUpdate: 'usage_update', used: 50, size: 100 });
      return { result: null };
    });
    const { connection, observations } = await ready(agent);
    expect(await connection.loadSession('old-1', '/work', { mayLoad: true })).toEqual({ ok: true, sessionId: 'old-1' });
    agent.update('old-1', MESSAGE_CHUNK);
    await flush();
    expect(observations).toMatchObject([
      { kind: 'display', origin: 'history', turnId: 'history-7', attemptId: null, binding: null, event: { origin: 'history', attemptId: null } },
      { kind: 'usage', origin: 'history', usage: { replayed: true, turnId: 'history-7' } },
      { kind: 'display', origin: 'live', turnId: 'idle-7', attemptId: null, binding: null }
    ]);
    expect(agent.sent('session/load')).toMatchObject([{ params: { sessionId: 'old-1', cwd: '/work', mcpServers: [] } }]);
  });

  it('counts an update for an unknown session as stale', async () => {
    const agent = agentWith();
    const { connection, observations } = await ready(agent);
    agent.update('ghost', MESSAGE_CHUNK);
    await flush();
    expect(observations).toHaveLength(0);
    expect(connection.describe().counters.staleUpdates).toBe(1);
  });
});

describe('hostile transport (US5)', () => {
  async function failsWith(send: (agent: MemoryAgent) => void, reason: string): Promise<void> {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const { connection } = await withSession(agent);
    const outcome = connection.prompt(request());
    send(agent);
    expect(await outcome).toEqual({ kind: 'uncertain', turnId: 'turn-7-1', reason });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: reason });
    expect(agent.closeCalls).toBe(1);
  }

  it('fails on a malformed line', async () => {
    await failsWith((agent) => agent.rawLater('{not json\n'), 'malformed-frame');
  });

  it('fails on an oversized frame', async () => {
    await failsWith((agent) => agent.rawLater('x'.repeat(2 * 1024 * 1024 + 1)), 'frame-oversized');
  });

  it('fails on a message that is not JSON-RPC', async () => {
    await failsWith((agent) => agent.sendLater({ hello: 'world' }), 'protocol-violation');
  });

  it('fails on an invalid stop reason', async () => {
    await failsWith((agent) => answerPrompt(agent, 'shrug'), 'protocol-violation');
  });

  it('fails request-limit-exceeded on the 65th outstanding request', async () => {
    const agent = agentWith().on('session/new', () => 'silent');
    const { connection } = await ready(agent);
    const pending = Array.from({ length: 64 }, () => connection.newSession('/work'));
    agent.request(500, 'session/request_permission', PERMISSION);
    const settled = await Promise.all(pending);
    expect(settled.every((result) => !result.ok && result.reason === 'request-limit-exceeded')).toBe(true);
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: 'request-limit-exceeded' });
    expect(agent.closeCalls).toBe(1);
  });

  it('fails a silent initialize at the 5 s deadline', async () => {
    const agent = new MemoryAgent().on('initialize', () => 'silent');
    const parts = harness(agent);
    const pending = openAcpConnection(parts.options);
    await flush();
    parts.clock.advance(4_999);
    await flush();
    expect(agent.closeCalls).toBe(0);
    parts.clock.advance(1);
    expect(await pending).toEqual({ ok: false, refusal: 'handshake-deadline' });
    expect(agent.closeCalls).toBe(1);
    expect(agent.sent('session/new')).toHaveLength(0);
  });

  it('refuses file system and terminal requests and counts unknown traffic', async () => {
    const agent = agentWith();
    const { connection } = await ready(agent);
    agent.request(201, 'fs/read_text_file', { sessionId: 'sess-1', path: '/etc/hosts' });
    agent.request(202, 'terminal/create', { sessionId: 'sess-1', command: 'sh' });
    agent.notify('x/unknown', {});
    agent.sendLater({ jsonrpc: '2.0', id: 1, result: FULL_INIT });
    agent.update('sess-1', { sessionUpdate: 'mystery' });
    await flush();
    expect(agent.answersTo(201)).toMatchObject([{ error: { code: -32601 } }]);
    expect(agent.answersTo(202)).toMatchObject([{ error: { code: -32601 } }]);
    expect(connection.describe()).toMatchObject({
      state: 'ready',
      counters: { refusedAgentRequests: 2, unknownNotifications: 1, duplicateResponses: 1, staleUpdates: 1 }
    });
  });

  it('answers a malformed permission request with invalid params', async () => {
    const agent = agentWith();
    const { connection } = await withSession(agent);
    agent.request(300, 'session/request_permission', { sessionId: 'sess-1' });
    await flush();
    expect(agent.answersTo(300)).toMatchObject([{ error: { code: -32602 } }]);
    expect(connection.describe().state).toBe('ready');
  });

  it('closes on request and refuses later work', async () => {
    const agent = agentWith();
    const { connection } = await withSession(agent);
    await connection.close();
    expect(connection.describe().state).toBe('closed');
    expect(agent.closeCalls).toBe(1);
    expect(await connection.newSession('/work')).toEqual({ ok: false, reason: 'connection-not-ready' });
  });
});

// Review R-1: a pipe read can hold several messages. Each one must see the state the message
// before it left behind, so an answer is applied before the next line of its chunk is routed.
describe('messages that share one stdout chunk', () => {
  function line(message: unknown): string {
    return `${JSON.stringify(message)}\n`;
  }

  function updateLine(sessionId: string, update: Record<string, unknown> = MESSAGE_CHUNK): string {
    return line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  function resultLine(agent: MemoryAgent, method: string, result: unknown): string {
    return line({ jsonrpc: '2.0', id: lastId(agent, method), result });
  }

  it('observes turn-completed before an update that follows the prompt response', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const { connection, observations } = await withSession(agent);
    const outcome = connection.prompt(request());
    agent.rawLater(resultLine(agent, 'session/prompt', { stopReason: 'end_turn' }) + updateLine('sess-1'));
    expect(await outcome).toMatchObject({ kind: 'completed', turnId: 'turn-7-1' });
    await flush();
    expect(observations.map((observation) => observation.kind)).toEqual(['turn-started', 'turn-completed', 'display']);
    expect(observations.map((observation) => observation.hostReceiveSeq)).toEqual([1, 2, 3]);
    expect(observations.at(2)).toMatchObject({ origin: 'live', turnId: 'idle-7', attemptId: null, binding: null });
  });

  it('ties a permission request that follows the prompt response to no attempt', async () => {
    const agent = agentWith().on('session/prompt', () => 'silent');
    const attempts: (string | null)[] = [];
    const { connection } = await withSession(agent, {
      permissionPolicy: (permission) => {
        attempts.push(permission.attemptId);
        return { optionId: 'reject' };
      }
    });
    const outcome = connection.prompt(request());
    const permission = line({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: PERMISSION });
    agent.rawLater(resultLine(agent, 'session/prompt', { stopReason: 'end_turn' }) + permission);
    expect(await outcome).toMatchObject({ kind: 'completed' });
    await flush();
    expect(attempts).toEqual([null]);
  });

  it('observes an update that follows the session/new response', async () => {
    const agent = new MemoryAgent().on('initialize', () => ({ result: FULL_INIT })).on('session/new', () => 'silent');
    const { connection, observations } = await ready(agent);
    const created = connection.newSession('/work');
    agent.rawLater(resultLine(agent, 'session/new', { sessionId: 'sess-1' }) + updateLine('sess-1'));
    expect(await created).toEqual({ ok: true, sessionId: 'sess-1' });
    await flush();
    expect(connection.describe().counters.staleUpdates).toBe(0);
    expect(observations).toMatchObject([{ kind: 'display', origin: 'live', turnId: 'idle-7', attemptId: null }]);
  });

  it('marks updates that follow the session/load response as live, and their usage as new', async () => {
    const agent = agentWith().on('session/load', () => 'silent');
    const { connection, observations } = await ready(agent);
    const loaded = connection.loadSession('old-1', '/work', { mayLoad: true });
    const usage = updateLine('old-1', { sessionUpdate: 'usage_update', used: 50, size: 100 });
    agent.rawLater(updateLine('old-1') + resultLine(agent, 'session/load', null) + updateLine('old-1') + usage);
    expect(await loaded).toEqual({ ok: true, sessionId: 'old-1' });
    await flush();
    expect(observations).toMatchObject([
      { kind: 'display', origin: 'history', turnId: 'history-7' },
      { kind: 'display', origin: 'live', turnId: 'idle-7' },
      { kind: 'usage', origin: 'live', usage: { replayed: false, turnId: 'idle-7' } }
    ]);
  });
});

// Review S-1 and S-2: what an agent may put in an identifier, and how deep its data may nest.
describe('hostile agent data', () => {
  const UNSAFE_IDENTIFIERS: readonly (readonly [string, string])[] = [
    ['an escape', `sess${String.fromCodePoint(0x1b)}[2J`],
    ['a newline', `sess${String.fromCodePoint(0x0a)}forged`],
    ['a C1 control', `sess${String.fromCodePoint(0x9b)}`],
    ['a bidi override', `sess${String.fromCodePoint(0x202e)}`],
    ['a line separator', `sess${String.fromCodePoint(0x2028)}`]
  ];

  it.each(UNSAFE_IDENTIFIERS)('fails protocol-violation on a session id that carries %s', async (_label, sessionId) => {
    const agent = new MemoryAgent().on('initialize', () => ({ result: FULL_INIT })).on('session/new', () => ({ result: { sessionId } }));
    const { connection } = await ready(agent);
    expect(await connection.newSession('/work')).toEqual({ ok: false, reason: 'protocol-violation' });
    expect(connection.describe()).toMatchObject({ state: 'failed', lastFailure: 'protocol-violation', sessionCount: 0 });
  });

  it.each(UNSAFE_IDENTIFIERS)('refuses to load a session id that carries %s', async (_label, sessionId) => {
    const agent = agentWith();
    const { connection } = await ready(agent);
    expect(await connection.loadSession(sessionId, '/work', { mayLoad: true })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(agent.sent('session/load')).toEqual([]);
  });

  it('hands on a tool argument nested 500,000 deep and stays ready', async () => {
    const depth = 500_000;
    const agent = agentWith();
    const { connection, observations } = await withSession(agent);
    const head = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":';
    const update = `{"sessionUpdate":"tool_call","toolCallId":"c1","title":"t","rawInput":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    agent.rawLater(`${head}${update}}}\n`);
    await flush();
    expect(observations.map((observation) => observation.kind)).toEqual(['display']);
    expect(connection.describe()).toMatchObject({ state: 'ready', lastFailure: null });
  });
});
