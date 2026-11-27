// FR-R6-F13 T021 (FR-002, FR-019, research R7) — the stdio transport against the synthetic
// child-process agent: one initialize round trip, stderr kept apart from stdout, and an
// idempotent close that ends the child. The SIGKILL escalation against an agent that ignores
// SIGTERM is in the acceptance tier, because it waits the real 2 s.
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AcpTransport } from '../../../src/contracts/acp-runtime';
import { FrameDecoder } from '../../../src/services/acp-runtime/frame-decoder';
import { spawnStdioTransport } from '../../../src/services/acp-runtime/stdio-transport';

const AGENT = resolve(__dirname, '..', '..', 'fixtures', 'acp', 'fake-acp-agent.mjs');
const INITIALIZE = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`;
const WAIT = { timeout: 5_000, interval: 10 };

/**
 * A shell agent that reads the first line, closes its own stdin, answers and lives on. A Node
 * agent cannot be used here: Node keeps descriptor 0 open after `process.stdin.destroy()`, and
 * libuv aborts the process on an explicit close of it.
 *
 * It closes stdin BEFORE it answers, so the answer's arrival proves the read end is gone. Answering
 * first raced (review gap GC-18, Linux leg 2026-11-12, under load): a second write that reached the
 * pipe before `exec 0<&-` ran was buffered, never failed, and no close was ever reported.
 */
const INIT_ANSWER = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
const CLOSES_STDIN_AND_LIVES = `IFS= read -r _line; exec 0<&-; printf '%s\\n' '${INIT_ANSWER}'; exec sleep 30`;

interface Captured {
  readonly transport: AcpTransport;
  readonly messages: unknown[];
  readonly stderr: string[];
  readonly closes: number[];
}

function launch(scenario: string, command = process.execPath, args: readonly string[] = [AGENT, scenario]): Captured {
  const transport = spawnStdioTransport({ command, args, cwd: process.cwd(), env: {} });
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  const stderr: string[] = [];
  const closes: number[] = [];
  transport.onStdout((chunk) => {
    const decoded = decoder.push(chunk);
    if (decoded.ok) messages.push(...decoded.messages);
  });
  transport.onStderr((chunk) => stderr.push(Buffer.from(chunk).toString('utf8')));
  transport.onClose(() => closes.push(1));
  return { transport, messages, stderr, closes };
}

describe('spawnStdioTransport', () => {
  it('round-trips initialize with the child agent and ends it on close', async () => {
    const run = launch('basic');
    run.transport.write(INITIALIZE);
    await vi.waitFor(() => expect(run.messages).toHaveLength(1), WAIT);
    expect(run.messages.at(0)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await run.transport.close();
    await vi.waitFor(() => expect(run.closes).toEqual([1]), WAIT);
  });

  it('delivers stderr apart from stdout, and reassembles stdout split across writes', async () => {
    const run = launch('stderr-noise');
    run.transport.write(INITIALIZE);
    await vi.waitFor(() => expect(run.messages).toHaveLength(1), WAIT);
    expect(run.messages.at(0)).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    await vi.waitFor(() => expect(run.stderr.join('')).toContain('warn'), WAIT);
    await run.transport.close();
  });

  it('is idempotent: every close returns the same promise and the close is reported once', async () => {
    const run = launch('basic');
    const first = run.transport.close();
    expect(run.transport.close()).toBe(first);
    await first;
    await vi.waitFor(() => expect(run.closes).toEqual([1]), WAIT);
    expect(() => run.transport.write(INITIALIZE)).toThrow('agent stdin');
  });

  it('reports a launch failure as a close, and close still resolves', async () => {
    const run = launch('basic', 'schegent-acp-no-such-agent-binary');
    await vi.waitFor(() => expect(run.closes).toEqual([1]), WAIT);
    expect(() => run.transport.write(INITIALIZE)).toThrow('agent stdin');
    await run.transport.close();
    expect(run.closes).toEqual([1]);
  });

  // Review R-3: a write the agent's stdin did not take must not look written.
  // The agent process stays alive here, so the close below comes from the lost stdin alone. The
  // stream takes the first line after the agent closed its end; the error arrives afterwards.
  it('reports a stdin the agent closed as one close, and throws on every later write', async () => {
    const run = launch('closes-stdin', '/bin/sh', ['-c', CLOSES_STDIN_AND_LIVES]);
    run.transport.write(INITIALIZE);
    await vi.waitFor(() => expect(run.messages).toHaveLength(1), WAIT);
    expect(run.closes).toEqual([]);
    expect(() => run.transport.write(INITIALIZE)).not.toThrow();
    await vi.waitFor(() => expect(run.closes).toEqual([1]), WAIT);
    expect(() => run.transport.write(INITIALIZE)).toThrow('agent stdin');
    await run.transport.close();
    expect(run.closes).toEqual([1]);
  });

  it('reports an agent that exits on its own as a close', async () => {
    const run = launch('crash-after-prompt');
    run.transport.write(INITIALIZE);
    await vi.waitFor(() => expect(run.messages).toHaveLength(1), WAIT);
    const session = { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } };
    run.transport.write(`${JSON.stringify(session)}\n`);
    await vi.waitFor(() => expect(run.messages).toHaveLength(2), WAIT);
    const prompt = { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'x', prompt: [] } };
    run.transport.write(`${JSON.stringify(prompt)}\n`);
    await vi.waitFor(() => expect(run.closes).toEqual([1]), WAIT);
    await run.transport.close();
  });
});
