#!/usr/bin/env node
// FR-R3-061 & FR-R7-14 (14-10) — the runner around `backend-canary.mjs`'s pure decisions.
//
// Separated so the decisions are unit-testable without a CLI, a network, or
// credentials. This half performs the shipped-transport ACP probe and writes
// the v2 `.backend-qualification.json` record.
//
// Modes:
//   - default (live): exercises the shipped ACP stdio bridge (`dist/acp-stdio-bridge.js`) for
//     `claude` and `codex`, and native ACP / CLI stream-json for `agy`, against installed CLIs
//     inside a neutral empty git temp directory (`LIVE_CWD`).
//   - `--fixture`: deterministic credential-free verification of the shipped transport path for
//     all three advertised backends (`claude` and `codex` through `dist/acp-stdio-bridge.js`
//     driving disposable CLI stand-ins; `agy` through a deterministic native ACP v1 responder).
//     Writes `mode: 'fixture'` (never accepted as live release qualification).

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_BACKEND_PROFILES,
  EXPECTED_BACKEND_TRANSPORTS,
  QUALIFICATION_PATH,
  computeQualificationSourceFingerprint,
  readHeadCommit,
  recordFromCanaryResults,
  summarizeBehaviorEvalManifest,
  versionToken
} from './backend-qualification.mjs';
import {
  runnerBackendResult,
  formatReport,
  canaryExitCode,
  saysNotAuthenticated,
  answerEstablishesPrompt,
  liveArgsFor,
  redactLiveEnvelope,
  stdinPayloadFor,
  LIVE_PROMPT,
  CANARY_CASES
} from './backend-canary.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SCRIPT_PATH = resolve(REPO_ROOT, 'dist', 'acp-stdio-bridge.js');

/** The hard wall-clock deadline on the live turn. */
const LIVE_TIMEOUT_MS = 120_000;

// FR-R3-084 — the smallest invocation that establishes the shipped transport still works:
// one turn, a fixed trivial prompt, no workspace mutation, no network target other than the
// provider. NO auth proxy check and no API-key env inspection.
const BACKENDS = [
  { backend: 'claude', command: 'claude' },
  { backend: 'codex', command: 'codex' },
  { backend: 'agy', command: 'agy' }
];

function flagValueFromArgv(argv, flagName) {
  const flag = argv.indexOf(flagName);
  if (flag === -1) return null;
  const val = argv[flag + 1];
  if (!val || val.startsWith('--')) {
    console.error(`[backend-canary] ${flagName} needs a value`);
    process.exit(2);
  }
  return resolve(val);
}

function initProbeDir(dir) {
  const init = spawnSync('git', ['init', '--quiet'], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000
  });
  if (init.error || init.status !== 0) {
    console.error(
      `[backend-canary] could not git-init the probe directory (${init.error?.message ?? `exit ${init.status}`}); ` +
        'a backend that requires a trusted directory will report drifted'
    );
  }
}

function plantedProbeDir(files) {
  const dir = mkdtempSync(resolve(tmpdir(), 'schegent-canary-'));
  initProbeDir(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(dir, name), content, 'utf8');
  }
  return dir;
}

function probeDirSpellings(dir) {
  return [dir, realpathSync(dir)];
}

function versionProbe(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: result.error?.message ?? `exit ${result.status}` };
  }
  return { ok: true, version: versionToken(result.stdout) ?? 'unknown' };
}

/**
 * Execute one ACP v1 JSON-RPC 2.0 handshake + session/new + session/prompt turn over stdio
 * against either `dist/acp-stdio-bridge.js` (for Claude/Codex) or a native ACP executable (Agy).
 */
export function runAcpJsonRpcTurn({ command, args, cwd, prompt = LIVE_PROMPT, timeoutMs = LIVE_TIMEOUT_MS }) {
  return new Promise((resolveTurn) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    let settled = false;
    let stdoutBuf = '';
    let rawStdout = '';
    let stderrText = '';
    let collectedText = '';
    let sessionId = null;
    let step = 'initialize';

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // Ignore pipe teardown error.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited process.
      }
      resolveTurn({ ...outcome, stdout: rawStdout });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: `ACP turn timed out after ${timeoutMs}ms during ${step}` });
    }, timeoutMs);

    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        finish({ ok: false, detail: `ACP stdin write failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    };

    child.on('error', (err) => {
      finish({ ok: false, detail: err.message });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 16_384) stderrText += chunk;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (rawStdout.length < 262_144) rawStdout += chunk;
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (line.length === 0) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          finish({ ok: false, detail: `malformed JSON-RPC line from ACP process during ${step}` });
          return;
        }
        if (msg.method === 'session/update' && msg.params?.update) {
          const update = msg.params.update;
          if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
            collectedText += update.content.text;
          }
          continue;
        }
        if (msg.id === 1 && step === 'initialize') {
          if (msg.error) {
            finish({ ok: false, detail: `initialize error: ${msg.error.message ?? msg.error.code}` });
            return;
          }
          if (msg.result?.protocolVersion !== 1) {
            finish({ ok: false, detail: `unexpected ACP protocolVersion: ${String(msg.result?.protocolVersion)}` });
            return;
          }
          step = 'session/new';
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
          continue;
        }
        if (msg.id === 2 && step === 'session/new') {
          if (msg.error || typeof msg.result?.sessionId !== 'string') {
            finish({ ok: false, detail: `session/new failed: ${msg.error?.message ?? 'missing sessionId'}` });
            return;
          }
          sessionId = msg.result.sessionId;
          step = 'session/prompt';
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/prompt',
            params: { sessionId, prompt: [{ type: 'text', text: prompt }] }
          });
          continue;
        }
        if (msg.id === 3 && step === 'session/prompt') {
          if (msg.error) {
            const errText = `${msg.error.message ?? ''} ${stderrText}`;
            if (saysNotAuthenticated(collectedText, errText)) {
              finish({ ok: false, notAuthenticated: true, detail: 'not signed in' });
              return;
            }
            finish({ ok: false, detail: `session/prompt error: ${msg.error.message ?? msg.error.code}` });
            return;
          }
          const stopReason = msg.result?.stopReason;
          if (stopReason !== 'end_turn') {
            finish({ ok: false, detail: `unexpected stopReason: ${String(stopReason)}` });
            return;
          }
          const answer = collectedText.trim();
          if (answer.length === 0) {
            if (saysNotAuthenticated(answer, stderrText)) {
              finish({ ok: false, notAuthenticated: true, detail: 'not signed in' });
              return;
            }
            finish({ ok: false, detail: 'empty ACP response' });
            return;
          }
          if (!answerEstablishesPrompt(answer, prompt)) {
            finish({
              ok: false,
              detail:
                'the turn completed but its answer does not carry the token the prompt asked for, ' +
                'so the prompt did not reach the model as sent'
            });
            return;
          }
          finish({ ok: true, detail: `answered via ACP (${answer.length} chars)`, text: answer });
          return;
        }
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      if (saysNotAuthenticated(collectedText, stderrText)) {
        finish({ ok: false, notAuthenticated: true, detail: 'not signed in' });
        return;
      }
      const tail = stderrText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(-1)[0];
      finish({
        ok: false,
        detail: `ACP process exited (${String(code)}) during ${step}${tail ? `: ${tail.slice(0, 200)}` : ''}`
      });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} }
    });
  });
}

function createFixtureCli(dir, kind) {
  const scriptPath = resolve(dir, `fake-${kind}.mjs`);
  if (kind === 'claude') {
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.302 (Claude Code fixture)\\n');
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-fixture-sess-1' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'canary' }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-fixture-sess-1' }) + '\\n');
});
`,
      'utf8'
    );
  } else if (kind === 'codex') {
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.159.2\\n');
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-fixture-thread-1' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'canary' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }) + '\\n');
});
`,
      'utf8'
    );
  } else {
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('1.4.2\\n');
  process.exit(0);
}
if (!process.argv.includes('acp') || !process.argv.includes('--stdio')) {
  process.stderr.write('expected native ACP stdio flags (acp --stdio)\\n');
  process.exit(2);
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-fixture-sess-1' } }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'canary' } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }
  }
});
`,
      'utf8'
    );
  }
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Run deterministic credential-free qualification through the shipped transport for all three
 * advertised backends (`claude`/`codex` through `dist/acp-stdio-bridge.js`, `agy` through native
 * ACP v1 JSON-RPC). Produces a v2 record with `mode: 'fixture'`.
 */
export async function runFixtureQualification({ repoRoot = REPO_ROOT, now = new Date().toISOString() } = {}) {
  const bridgePath = resolve(repoRoot, 'dist', 'acp-stdio-bridge.js');
  if (!existsSync(bridgePath)) {
    throw new Error(`Shipped ACP bridge not built at ${bridgePath}; run \`npm run build\` first.`);
  }
  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'schegent-canary-fixture-'));
  initProbeDir(fixtureDir);
  try {
    const results = [];
    for (const { backend } of BACKENDS) {
      const cliPath = createFixtureCli(fixtureDir, backend);
      const version = versionProbe(cliPath);
      const isBridge = EXPECTED_BACKEND_TRANSPORTS[backend] === 'acp-stdio-bridge';
      const probe =
        version.ok === true
          ? await runAcpJsonRpcTurn({
              command: isBridge ? process.execPath : cliPath,
              args: isBridge
                ? [bridgePath, '--backend', backend, '--cli', cliPath]
                : ['acp', '--stdio', '--disable-telemetry'],
              cwd: fixtureDir,
              prompt: LIVE_PROMPT,
              timeoutMs: 30_000
            })
          : undefined;
      results.push({
        ...runnerBackendResult({ backend, versionProbe: version, liveProbe: probe }),
        transport: EXPECTED_BACKEND_TRANSPORTS[backend],
        profileId: EXPECTED_BACKEND_PROFILES[backend],
        executable: cliPath
      });
    }
    const manifestPath = resolve(
      repoRoot,
      'tests',
      'evals',
      'fixtures',
      'backend-behavior',
      'manifest.json'
    );
    const manifestExists = existsSync(manifestPath);
    const behaviorEvals = manifestExists ? summarizeBehaviorEvalManifest(manifestPath) : undefined;
    const record = recordFromCanaryResults(results, {
      commit: readHeadCommit(),
      platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
      now,
      mode: 'fixture',
      sourceFingerprint: computeQualificationSourceFingerprint(repoRoot),
      ...(manifestExists ? { behaviorEvals } : {})
    });
    return { results, record };
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

const isEntryPoint = invokedAsScript(import.meta.url);

if (!isEntryPoint) {
  console.error(
    '[backend-canary] imported rather than executed; no probe was run. ' +
      'Run `npm run canary` to spend the live turns deliberately.'
  );
} else {
  const argv = process.argv.slice(2);
  const fixtureMode = argv.includes('--fixture');
  const outPath = flagValueFromArgv(argv, '--out') ?? QUALIFICATION_PATH;
  const recordDir = flagValueFromArgv(argv, '--record');
  if (recordDir) mkdirSync(recordDir, { recursive: true });

  if (fixtureMode) {
    const { results, record } = await runFixtureQualification();
    console.log(formatReport(results));
    if (argv.includes('--out')) {
      writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      console.log(`[backend-canary] fixture qualification record written to ${outPath}`);
    } else {
      console.log('[backend-canary] fixture mode complete (pass --out <path> to persist record).');
    }
    process.exit(results.every((r) => r.state === 'ok') ? 0 : 1);
  }

  const LIVE_CWD = mkdtempSync(resolve(tmpdir(), 'schegent-canary-'));
  initProbeDir(LIVE_CWD);

  const liveProbe = async (backend, command) => {
    const expectedTransport = EXPECTED_BACKEND_TRANSPORTS[backend];
    const expectedProfile = EXPECTED_BACKEND_PROFILES[backend];
    if (expectedTransport === 'acp-stdio-bridge') {
      if (!existsSync(BRIDGE_SCRIPT_PATH)) {
        return {
          ok: false,
          transport: 'unbuilt-bridge',
          profileId: 'unbuilt-bridge',
          detail: `shipped ACP bridge not built at ${BRIDGE_SCRIPT_PATH}; run \`npm run build\` first`
        };
      }
      const result = await runAcpJsonRpcTurn({
        command: process.execPath,
        args: [BRIDGE_SCRIPT_PATH, '--backend', backend, '--cli', command],
        cwd: LIVE_CWD,
        prompt: LIVE_PROMPT,
        timeoutMs: LIVE_TIMEOUT_MS
      });
      if (recordDir && (result.stdout ?? '').length > 0) {
        writeFileSync(
          resolve(recordDir, `${backend}-live.jsonl`),
          redactLiveEnvelope(result.stdout, probeDirSpellings(LIVE_CWD)),
          'utf8'
        );
      }
      return { ...result, transport: expectedTransport, profileId: expectedProfile };
    }
    if (expectedTransport === 'acp-native') {
      const result = await runAcpJsonRpcTurn({
        command,
        args: ['acp', '--stdio', '--disable-telemetry'],
        cwd: LIVE_CWD,
        prompt: LIVE_PROMPT,
        timeoutMs: LIVE_TIMEOUT_MS
      });
      if (recordDir && (result.stdout ?? '').length > 0) {
        writeFileSync(
          resolve(recordDir, `${backend}-live.jsonl`),
          redactLiveEnvelope(result.stdout, probeDirSpellings(LIVE_CWD)),
          'utf8'
        );
      }
      return { ...result, transport: expectedTransport, profileId: expectedProfile };
    }
    return { ok: false, transport: 'unsupported', profileId: 'unsupported', detail: 'unsupported transport' };
  };

  const recordCorpus = (backend, command) => {
    const args = liveArgsFor(backend);
    if (!args || !recordDir) return;
    const cases = CANARY_CASES.filter((c) => c.backend === backend && c.cadence === 'record-only');
    for (const scenario of cases) {
      const cwd = scenario.files ? plantedProbeDir(scenario.files) : LIVE_CWD;
      const result = spawnSync(command, args, {
        input: stdinPayloadFor(backend, scenario.prompt),
        cwd,
        encoding: 'utf8',
        shell: false,
        timeout: LIVE_TIMEOUT_MS
      });
      if ((result.stdout ?? '').length === 0) {
        console.error(`[backend-canary] ${backend}: ${scenario.id} produced no output, not recorded`);
        continue;
      }
      writeFileSync(
        resolve(recordDir, `${backend}-${scenario.stem}.jsonl`),
        redactLiveEnvelope(result.stdout, probeDirSpellings(cwd)),
        'utf8'
      );
    }
  };

  const results = [];
  for (const { backend, command } of BACKENDS) {
    const version = versionProbe(command);
    const liveResult = await (version.ok === true ? liveProbe(backend, command) : Promise.resolve(undefined));
    if (version.ok === true && recordDir) recordCorpus(backend, command);
    results.push({
      ...runnerBackendResult({ backend, versionProbe: version, liveProbe: liveResult }),
      transport: liveResult?.transport ?? 'not-run',
      profileId: liveResult?.profileId ?? 'not-run',
      executable: command
    });
  }

  console.log(formatReport(results));

  const liveManifestPath = resolve(
    REPO_ROOT,
    'tests',
    'evals',
    'fixtures',
    'backend-behavior',
    'manifest.json'
  );
  const liveManifestExists = existsSync(liveManifestPath);
  const behaviorEvals = liveManifestExists ? summarizeBehaviorEvalManifest(liveManifestPath) : undefined;
  const qualificationRecord = recordFromCanaryResults(results, {
    commit: readHeadCommit(),
    platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
    now: new Date().toISOString(),
    mode: 'live',
    sourceFingerprint: computeQualificationSourceFingerprint(REPO_ROOT),
    ...(liveManifestExists ? { behaviorEvals } : {})
  });
  writeFileSync(outPath, `${JSON.stringify(qualificationRecord, null, 2)}\n`, 'utf8');
  console.log(`[backend-canary] qualification record written to ${outPath}`);

  process.exit(canaryExitCode(results));
}
