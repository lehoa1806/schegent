import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import { AgyCliRunner } from '../../../src/runner/agy-cli';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';
import { runIdOfLogLine } from '../../../src/services/diagnostics-bundle/bundle-collect';

// FR-R4-039: a diagnostics bundle selects runtime lines by their structured runId.
// Use the real logger and the bundle's selector, with overlapping invocations and
// a stdin fault. A window logger or a mutable "current run" loses/misattributed lines.
function failedStdinChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(_chunk, _encoding, done) {
      done(Object.assign(new Error('synthetic delivery failure'), { code: 'EPIPE' }));
    } }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true
  });
  setImmediate(() => {
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  return child as unknown as ChildProcess;
}

const SUBJECTS: Array<{
  name: string;
  make: (spawn: SpawnFn, logger: SanitizedLogger) => BackendRunner;
}> = [
  { name: 'Claude', make: (spawn, logger) => new ClaudeCliRunner(spawn, null, {}, logger) },
  { name: 'Codex', make: (spawn, logger) => new CodexCliRunner(spawn, null, logger) },
  { name: 'Agy', make: (spawn, logger) => new AgyCliRunner(spawn, null, logger) }
];

describe.each(SUBJECTS)('$name runtime correlation', ({ make }) => {
  it('keeps each invocation selectable by its own Run and phase', async () => {
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line) => { lines.push(line); } }]);
    const runner = make(failedStdinChild, logger);
    const cases = [
      { runId: 'run-first', phase: 'speckit-plan' },
      { runId: 'run-second', phase: 'speckit-implement' }
    ];
    const outputs = await Promise.all(cases.map((entry) => runner.invoke({
      ...entry, iteration: 2, prompt: 'synthetic', cliPath: 'fixture', cwd: '/fixture', timeoutMs: 5_000
    })));
    expect(outputs.every((output) => output.stdinDeliveryFailed)).toBe(true);
    for (const entry of cases) {
      const selected = lines.filter((line) => runIdOfLogLine(line) === entry.runId);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.some((line) => /delivery failed/i.test(line))).toBe(true);
      for (const line of selected) expect(line).toContain(`"phase":"${entry.phase}"`);
    }
    expect(lines.every((line) => cases.some((entry) => runIdOfLogLine(line) === entry.runId))).toBe(true);
    logger.info('window-only event');
    expect(runIdOfLogLine(lines.at(-1)!)).toBeNull();
  });
});

describe('monitor runtime correlation', () => {
  it('retains attribution of a rejected append after a later phase starts', async () => {
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line) => { lines.push(line); } }]);
    const monitor = new ClaudeCliMonitor({
      stallThresholdMs: 90_000,
      rateLimitMatchers: [],
      monotonicNow: () => 0,
      now: () => new Date('2026-11-02T00:00:00Z'),
      audit: { append: async () => { throw new Error('synthetic audit failure'); } },
      transport: { record: () => {} },
      activity: { record: () => {} },
      logger
    });
    try {
      monitor.onStart('run-monitor', 'speckit-plan', null);
      monitor.onStart('run-monitor', 'speckit-implement', null);
      await Promise.resolve();
      expect(lines).toHaveLength(2);
      expect(lines.map(runIdOfLogLine)).toEqual(['run-monitor', 'run-monitor']);
      expect(lines[0]).toContain('"phase":"speckit-plan"');
      expect(lines[1]).toContain('"phase":"speckit-implement"');
    } finally {
      monitor.dispose();
    }
  });
});
