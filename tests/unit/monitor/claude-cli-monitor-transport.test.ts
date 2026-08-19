// Feature FR-R3-007 (T362) — the monitor writes no audit entry per line.
//
// This is the acceptance test for blueprint DATA-01, and it is deliberately
// separate from `claude-cli-monitor.test.ts`: that file tests the state machine
// and would treat the audit log as incidental, while the property here *is* the
// audit log's contents. The measurement it stands in for is a byte ratio — 93.2%
// of `.schegent/audit.log` was `monitor-stdout-line` — and the integration test
// checks that ratio end to end. What a unit test can pin is the rate: zero audit
// entries per line, no matter how many lines arrive.
//
// The assertions are written against the *shape* of the audit log rather than
// against the two retired event names, because a regression is at least as
// likely to arrive under a new name. `entriesEndingInLine()` is the check that
// survives a rename; the named-type check is kept alongside it because that is
// the exact writer this feature removed.
//
// The counts do not disappear with the writer. They move to
// `monitor-invocation-summary`, one entry per invocation instead of one per line,
// and gain `firstOutputAt` / `lastOutputAt` so an operator reading an archived
// log can still see when a run was producing output — which is what the per-line
// timestamps were, in practice, ever used for.

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import type { CliTransportRecord } from '../../../src/monitor/cli-transport-sink';
import type { AuditEntry } from '../../../src/audit/audit-entry';

class FakeAudit {
  public entries: Array<Partial<AuditEntry>> = [];
  public append = async (entry: Partial<AuditEntry>): Promise<AuditEntry> => {
    this.entries.push(entry);
    return { ...entry, id: String(this.entries.length) } as AuditEntry;
  };
}

class FakeTransport {
  public records: CliTransportRecord[] = [];
  public record = (entry: CliTransportRecord): void => {
    this.records.push(entry);
  };
}

/**
 * Wall clock and monotonic clock advance together, but only the wall clock is
 * observable in a payload. `firstOutputAt` has to be a stamp taken at the first
 * output rather than at start, so the two must be distinguishable.
 */
function makeMonitor(): {
  monitor: ClaudeCliMonitor;
  audit: FakeAudit;
  transport: FakeTransport;
  advance: (ms: number) => void;
} {
  let elapsed = 0;
  const wallStart = Date.parse('2026-05-10T12:00:00.000Z');
  const audit = new FakeAudit();
  const transport = new FakeTransport();
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: [],
    monotonicNow: () => 1_000 + elapsed,
    now: () => new Date(wallStart + elapsed),
    audit,
    transport,
    activity: { record: () => {} },
    logger: { sanitize: (s: string) => s, warn: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    rateLimitClusterMs: 5_000
  });
  return { monitor, audit, transport, advance: (ms: number) => { elapsed += ms; } };
}

/** Audit entries whose event type looks like a per-line writer, under any name. */
function entriesEndingInLine(audit: FakeAudit): readonly string[] {
  return audit.entries
    .map((entry) => String(entry.eventType ?? ''))
    .filter((eventType) => /-line$/.test(eventType));
}

function summaryPayload(audit: FakeAudit): Record<string, unknown> {
  const summary = audit.entries.find((entry) => entry.eventType === 'monitor-invocation-summary');
  expect(summary, 'monitor-invocation-summary is the aggregate the per-line events became').toBeDefined();
  return (summary!.payload ?? {}) as Record<string, unknown>;
}

describe('FR-R3-007 — CLI output is transport, not an audit event', () => {
  let mc: ReturnType<typeof makeMonitor>;
  beforeEach(() => {
    mc = makeMonitor();
  });

  it('appends no audit entry for stdout lines, however many arrive', () => {
    mc.monitor.onStart('run-1', 'speckit-implement', 42);
    const afterStart = mc.audit.entries.length;

    mc.monitor.onStdoutChunk('run-1', 'one\ntwo\nthree\n');
    mc.monitor.onStdoutChunk('run-1', 'four\nfive\n');

    expect(mc.audit.entries.length, 'stdout must not grow the audit log').toBe(afterStart);
    expect(entriesEndingInLine(mc.audit)).toEqual([]);
    expect(mc.monitor.getCurrentState('run-1')!.stdoutLines).toBe(5);
  });

  it('appends no audit entry for stderr lines either', () => {
    mc.monitor.onStart('run-1', 'speckit-implement', 42);
    const afterStart = mc.audit.entries.length;

    mc.monitor.onStderrChunk('run-1', 'warn one\nwarn two\n');

    expect(mc.audit.entries.length, 'stderr must not grow the audit log').toBe(afterStart);
    expect(entriesEndingInLine(mc.audit)).toEqual([]);
    expect(mc.monitor.getCurrentState('run-1')!.stderrLines).toBe(2);
  });

  it('routes every complete line to the transport sink, in order, tagged by stream', () => {
    mc.monitor.onStart('run-1', 'speckit-plan', 7);
    mc.monitor.onStdoutChunk('run-1', 'alpha\nbeta\n');
    mc.monitor.onStderrChunk('run-1', 'gamma\n');

    expect(mc.transport.records.map((r) => [r.stream, r.line])).toEqual([
      ['stdout', 'alpha'],
      ['stdout', 'beta'],
      ['stderr', 'gamma']
    ]);
    for (const record of mc.transport.records) {
      expect(record.runId).toBe('run-1');
      expect(record.phase).toBe('speckit-plan');
    }
  });

  it('holds a partial line back from the sink until its newline arrives', () => {
    mc.monitor.onStart('run-1', 'speckit-plan', 7);
    mc.monitor.onStdoutChunk('run-1', 'partial');
    expect(mc.transport.records, 'an unterminated line is not a line yet').toEqual([]);

    mc.monitor.onStdoutChunk('run-1', '-line\n');
    expect(mc.transport.records.map((r) => r.line)).toEqual(['partial-line']);
  });

  it('carries the output volume and window in the per-invocation summary', () => {
    mc.monitor.onStart('run-1', 'speckit-implement', 42);
    mc.advance(2_000);
    mc.monitor.onStdoutChunk('run-1', 'a\nb\nc\n');
    mc.advance(3_000);
    mc.monitor.onStderrChunk('run-1', 'e\n');
    mc.advance(1_000);
    mc.monitor.onExit('run-1', { exitCode: 0, signal: null, killed: false, timedOut: false });

    const payload = summaryPayload(mc.audit);
    expect(payload.stdoutLines).toBe(3);
    expect(payload.stderrLines).toBe(1);
    expect(payload.firstOutputAt).toBe('2026-05-10T12:00:02.000Z');
    expect(payload.lastOutputAt, 'the later of the two stream stamps').toBe(
      '2026-05-10T12:00:05.000Z'
    );
  });

  it('stamps firstOutputAt at the first output, not at start, and never rewrites it', () => {
    mc.monitor.onStart('run-1', 'speckit-implement', 42);
    mc.advance(30_000);
    mc.monitor.onStdoutChunk('run-1', 'first\n');
    mc.advance(30_000);
    mc.monitor.onStdoutChunk('run-1', 'second\n');
    mc.monitor.onExit('run-1', { exitCode: 0, signal: null, killed: false, timedOut: false });

    const payload = summaryPayload(mc.audit);
    expect(payload.firstOutputAt, 'a silent startup is visible only if this is not startedAt').toBe(
      '2026-05-10T12:00:30.000Z'
    );
    expect(payload.lastOutputAt).toBe('2026-05-10T12:01:00.000Z');
  });

  it('reports a null output window for an invocation that emitted nothing', () => {
    mc.monitor.onStart('run-1', 'speckit-implement', 42);
    mc.advance(500);
    mc.monitor.onExit('run-1', { exitCode: 1, signal: null, killed: false, timedOut: false });

    const payload = summaryPayload(mc.audit);
    expect(payload.stdoutLines).toBe(0);
    expect(payload.stderrLines).toBe(0);
    expect(payload.firstOutputAt, 'null is the honest answer; startedAt would be a guess').toBeNull();
    expect(payload.lastOutputAt).toBeNull();
  });

  it('still records a rate-limit judgement, which is about the invocation not the line', () => {
    // The line that triggered it is transport; the conclusion Schegent drew from
    // it is evidence. Losing this in the move would be a real regression, so it
    // is pinned here rather than left to the state-machine suite.
    const rateLimited = makeMonitorWithMatcher();
    rateLimited.monitor.onStart('run-1', 'speckit-implement', 42);
    rateLimited.monitor.onStderrChunk('run-1', 'HTTP 429 Too Many Requests\n');

    expect(
      rateLimited.audit.entries.map((entry) => entry.eventType)
    ).toContain('monitor-rate-limited');
    expect(entriesEndingInLine(rateLimited.audit)).toEqual([]);
    expect(rateLimited.transport.records.map((r) => r.line)).toEqual([
      'HTTP 429 Too Many Requests'
    ]);
  });
});

function makeMonitorWithMatcher(): {
  monitor: ClaudeCliMonitor;
  audit: FakeAudit;
  transport: FakeTransport;
} {
  const audit = new FakeAudit();
  const transport = new FakeTransport();
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: [{ regex: /429.*too many requests/i, cause: 'rate-limit-429' }],
    monotonicNow: () => 1_000,
    now: () => new Date('2026-05-10T12:00:00.000Z'),
    audit,
    transport,
    activity: { record: () => {} },
    logger: { sanitize: (s: string) => s, warn: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    rateLimitClusterMs: 5_000
  });
  return { monitor, audit, transport };
}
