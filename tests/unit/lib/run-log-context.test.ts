// Feature 251 (FR-R4-F04, contract T22, FR-033, C1 to C3) — a runtime-log line written while a Run
// executes names its Run and phase.
//
// What it pins: `withContext` merges its base under each call's own context, the call winning on a
// clash; the child shares the parent's sinks; the parent writes no base; a Run driven through the real
// phase runner on the fake backend writes lines whose JSON carries `runId` and `phase`; a line the host
// writes itself (activation, wiring) carries neither; and the runtime-log sink still parses each line's
// level, so the severity filter applies to a line with a base.
//
// Why: the filing's finding (O-13) is that with two Runs in one window the log could not say which Run a
// line belonged to. Nothing here infers a Run from timing: the context is attached where the Run's code
// holds the logger.

import { describe, expect, it, vi } from 'vitest';

import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { PhaseRunner } from '../../../src/controller/phase-runner';
import { PromptBuilder } from '../../../src/runner/prompt-builder';
import { phaseLogger, SanitizedLogger, type LogSink } from '../../../src/lib/logger';
import { RuntimeLogSink } from '../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../src/lib/runtime-log/runtime-log-settings';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { InvocationRequest, RawInvocationOutput } from '../../../src/runner/invocation-result';

const RUN_ID = 'run-ctx-251-a';
const OTHER_RUN_ID = 'run-ctx-251-b';
const PHASE = 'speckit-specify';

function recordingSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, appendLine: (line) => void lines.push(line) };
}

/** The JSON object a line carries after its message, or `null` when it carries none. */
function contextOf(line: string): Record<string, unknown> | null {
  const start = line.indexOf(' {');
  if (start < 0) return null;
  return JSON.parse(line.slice(start + 1)) as Record<string, unknown>;
}

describe('withContext (C1)', () => {
  it('merges the base under each call context, and the call wins on a clash', () => {
    const sink = recordingSink();
    const child = new SanitizedLogger([sink]).withContext({ runId: RUN_ID, phase: PHASE });

    child.info('with a clash', { phase: 'overridden', extra: 1 });
    child.warn('without a context');

    expect(contextOf(sink.lines[0]!)).toEqual({ runId: RUN_ID, phase: 'overridden', extra: 1 });
    expect(contextOf(sink.lines[1]!)).toEqual({ runId: RUN_ID, phase: PHASE });
  });

  it('writes the line shape `[ts] LEVEL message {json}` at every level', () => {
    const sink = recordingSink();
    const child = new SanitizedLogger([sink]).withContext({ runId: RUN_ID });

    child.debug('d');
    child.info('i');
    child.warn('w');
    child.error('e');

    expect(sink.lines).toHaveLength(4);
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    sink.lines.forEach((line, index) => {
      expect(line).toMatch(new RegExp(`^\\[[^\\]]+\\] ${levels[index]} ${'diwe'[index]} \\{"runId":"${RUN_ID}"\\}$`));
    });
  });

  it('shares the parent sinks, including one added after the child was made', () => {
    const parentSink = recordingSink();
    const parent = new SanitizedLogger([parentSink]);
    const child = parent.withContext({ runId: RUN_ID });
    const lateSink = recordingSink();
    parent.addSink(lateSink);

    child.info('from the child');

    expect(parentSink.lines).toHaveLength(1);
    expect(lateSink.lines).toHaveLength(1);
  });

  it('leaves the parent writing no base, and two children writing their own', () => {
    const sink = recordingSink();
    const parent = new SanitizedLogger([sink]);
    const first = parent.withContext({ runId: RUN_ID });
    const second = parent.withContext({ runId: OTHER_RUN_ID });

    parent.info('host line');
    first.info('first');
    second.info('second');

    expect(contextOf(sink.lines[0]!)).toBeNull();
    expect(contextOf(sink.lines[1]!)).toEqual({ runId: RUN_ID });
    expect(contextOf(sink.lines[2]!)).toEqual({ runId: OTHER_RUN_ID });
  });

  it('stacks: a child of a child carries both bases, the inner winning', () => {
    const sink = recordingSink();
    const inner = new SanitizedLogger([sink]).withContext({ runId: RUN_ID, phase: 'outer' }).withContext({ phase: PHASE });

    inner.info('stacked');

    expect(contextOf(sink.lines[0]!)).toEqual({ runId: RUN_ID, phase: PHASE });
  });

  it('still redacts a secret in a base value, as it does in a call context', () => {
    const sink = recordingSink();
    const child = new SanitizedLogger([sink]).withContext({ note: 'api_key=abcdefghijklmnopqrstuv' });

    child.info('secret in the base');

    expect(sink.lines[0]).toContain('[REDACTED]');
    expect(sink.lines[0]).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('phaseLogger names the Run and the phase', () => {
    const sink = recordingSink();
    phaseLogger(new SanitizedLogger([sink]), { runId: RUN_ID, phase: PHASE }).info('named');

    expect(contextOf(sink.lines[0]!)).toEqual({ runId: RUN_ID, phase: PHASE });
  });
});

// The phase-runner fixture: the fake backend answers one clean invocation.
const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  `phase: ${PHASE}`,
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock specify"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

function cleanOutput(): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(CLEAN_STDOUT);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.append('');
  stderrBuffer.finalize();
  return { stdoutBuffer, stderrBuffer, exitCode: 0, killed: false, timedOut: false, durationMs: 50 };
}

function fakeCliRunner(): ClaudeCliRunner {
  return {
    invoke: vi.fn(async (_request: InvocationRequest) => cleanOutput()),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

function fakeAuditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
      id: `audit-${++counter}`,
      timestamp: '2026-10-31T00:00:00Z',
      ...entry
    })),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

const INPUTS = {
  phase: PHASE as 'speckit-specify',
  iteration: 1,
  iterationCap: 10,
  featureDescription: 'desc',
  featureDir: 'specs/001-mock',
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 5_000,
  runId: RUN_ID
};

describe('a Run driven through the real phase runner (FR-033)', () => {
  it('writes lines whose JSON carries the Run and the phase, and the host line carries neither', async () => {
    const sink = recordingSink();
    const logger = new SanitizedLogger([sink]);
    const runner = new PhaseRunner(fakeCliRunner(), new PromptBuilder(), fakeAuditWriter(), logger);

    logger.info('activation: ready');
    const hostLines = sink.lines.length;
    await runner.run(INPUTS);
    logger.info('wiring: done');

    const runLines = sink.lines.slice(hostLines, -1);
    // The control: the run wrote at least the `phase-start` line, so "every line" is not vacuous.
    const phaseStart = runLines.find((line) => line.includes(`phase-start ${PHASE} iter=1`));
    expect(phaseStart, 'the run must write its phase-start line').toBeDefined();
    for (const line of runLines) {
      const context = contextOf(line);
      expect(context, `a Run line without context: ${line}`).not.toBeNull();
      expect(context).toMatchObject({ runId: RUN_ID, phase: PHASE });
    }

    expect(contextOf(sink.lines[0]!)).toBeNull();
    expect(contextOf(sink.lines.at(-1)!)).toBeNull();
  });

  it('keeps two Runs apart on one window logger', async () => {
    const sink = recordingSink();
    const logger = new SanitizedLogger([sink]);
    const runner = new PhaseRunner(fakeCliRunner(), new PromptBuilder(), fakeAuditWriter(), logger);

    await runner.run(INPUTS);
    const firstRunLines = sink.lines.length;
    await runner.run({ ...INPUTS, runId: OTHER_RUN_ID });

    for (const line of sink.lines.slice(0, firstRunLines)) expect(contextOf(line)).toMatchObject({ runId: RUN_ID });
    for (const line of sink.lines.slice(firstRunLines)) expect(contextOf(line)).toMatchObject({ runId: OTHER_RUN_ID });
  });
});

describe('the runtime-log sink still parses each line level (C1)', () => {
  it('filters a DEBUG line that carries a base and keeps an INFO one', async () => {
    const written: string[] = [];
    const accessor: RuntimeLogAccessor = {
      read: () => ({ level: 'INFO', path: '/tmp/run-log-context-251.log', maxBytes: 5_242_880, maxGenerations: 3 })
    };
    const sink = new RuntimeLogSink({
      accessor,
      fallbackLogger: new SanitizedLogger([]),
      appendFile: async (_target, data) => void written.push(data),
      mkdir: async () => undefined,
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    });
    const child = new SanitizedLogger([sink]).withContext({ runId: RUN_ID, phase: PHASE });

    child.debug('filtered below INFO');
    child.info('kept at INFO');
    await sink.flushPendingWrites();

    expect(written.join('')).toContain('kept at INFO');
    expect(written.join('')).toContain(`"runId":"${RUN_ID}"`);
    expect(written.join('')).not.toContain('filtered below INFO');
  });
});
