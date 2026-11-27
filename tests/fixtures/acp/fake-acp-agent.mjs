// SYNTHETIC ACP AGENT. FR-R6-F13 (T003). This is not a recording of any real agent and does not
// front any provider. It reads newline-delimited JSON-RPC 2.0 from stdin and answers on stdout
// with the subset of ACP protocol version 1 the host runtime speaks. Nothing is written to disk
// and nothing is read from the network.
//
// Usage: node fake-acp-agent.mjs <scenario>
//
//   basic               version 1, load and embedded context granted; a prompt streams one update
//                       of each kind and ends `end_turn`.
//   no-load             as basic, but `loadSession` is not granted.
//   version-2           answers initialize with protocol version 2.
//   silent              reads everything and answers nothing.
//   crash-after-prompt  exits with status 1 as soon as a prompt arrives.
//   stderr-noise        writes JSON-looking text and control characters to stderr, and splits
//                       each stdout message across several writes.
//   oversized           answers a prompt with one line over 2 MiB.
//   malformed           answers a prompt with a line that is not JSON.
//   permission          a prompt first sends `fs/read_text_file` and `terminal/create`, then asks
//                       permission; the answer decides the stop reason. A cancel ends it
//                       `cancelled`.
//   history             session/load replays an earlier message and usage before answering.
//   hang                a prompt sends one chunk, never answers, and ignores cancel and SIGTERM.

const scenario = process.argv[2] ?? 'basic';
const SESSION_ID = 'fixture-session-1';
const OVERSIZED_BYTES = 3 * 1024 * 1024;

let pendingPrompt = null;
let buffered = '';

function send(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (scenario !== 'stderr-noise') {
    process.stdout.write(line);
    return;
  }
  const third = Math.max(1, Math.floor(line.length / 3));
  process.stdout.write(line.slice(0, third));
  process.stdout.write(line.slice(third, third * 2));
  process.stdout.write(line.slice(third * 2));
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function update(sessionId, value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
}

function initialize(id) {
  if (scenario === 'stderr-noise') {
    process.stderr.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":9}}\n');
    process.stderr.write('warn\u0007\u001b[31m red \u001b[0m\n');
  }
  result(id, {
    protocolVersion: scenario === 'version-2' ? 2 : 1,
    agentCapabilities: {
      loadSession: scenario !== 'no-load',
      promptCapabilities: { image: false, audio: false, embeddedContext: true }
    },
    authMethods: []
  });
}

function streamTurn(sessionId) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture reply' } });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read fixture',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'fixture.txt' }
  });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'fixture contents' } }]
  });
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] });
  update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
}

function prompt(id, params) {
  const sessionId = params.sessionId;
  switch (scenario) {
    case 'crash-after-prompt':
      process.exit(1);
      return;
    case 'oversized':
      process.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"pad":"${'x'.repeat(OVERSIZED_BYTES)}"}}\n`);
      return;
    case 'malformed':
      process.stdout.write('{not json\n');
      return;
    case 'permission':
      pendingPrompt = id;
      send({ jsonrpc: '2.0', id: 'fs-1', method: 'fs/read_text_file', params: { sessionId, path: '/etc/hosts' } });
      send({ jsonrpc: '2.0', id: 'term-1', method: 'terminal/create', params: { sessionId, command: 'true' } });
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'call-1', title: 'Edit fixture' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        }
      });
      return;
    case 'hang':
      pendingPrompt = id;
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
      return;
    default:
      streamTurn(sessionId);
      result(id, { stopReason: 'end_turn' });
  }
}

function answerPermission(message) {
  if (pendingPrompt === null) return;
  const outcome = message.result?.outcome;
  const selected = outcome?.outcome === 'selected' ? outcome.optionId : null;
  update(SESSION_ID, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: selected === 'allow' ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: `permission ${selected ?? 'cancelled'}` } }]
  });
  if (outcome?.outcome === 'cancelled') return;
  result(pendingPrompt, { stopReason: selected === 'allow' ? 'end_turn' : 'refusal' });
  pendingPrompt = null;
}

function cancel() {
  if (scenario === 'hang' || pendingPrompt === null) return;
  result(pendingPrompt, { stopReason: 'cancelled' });
  pendingPrompt = null;
}

function handle(message) {
  if (scenario === 'silent') return;
  if (message.method === undefined) {
    if (message.id === 'perm-1') answerPermission(message);
    return;
  }
  switch (message.method) {
    case 'initialize':
      initialize(message.id);
      return;
    case 'session/new':
      result(message.id, { sessionId: SESSION_ID });
      return;
    case 'session/load':
      if (scenario === 'history') {
        update(message.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier ask' } });
        update(message.params.sessionId, { sessionUpdate: 'usage_update', used: 900, size: 200000 });
      }
      result(message.id, null);
      return;
    case 'session/prompt':
      prompt(message.id, message.params);
      return;
    case 'session/cancel':
      cancel();
      return;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
}

// A hang agent ignores SIGTERM and keeps its event loop alive, so only SIGKILL ends it.
if (scenario === 'hang') {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 60_000);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf('\n');
  while (newline !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
    newline = buffered.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (scenario !== 'hang') process.exit(0);
});
