// Feature FR-R3-007 (T367) — the two live surfaces do not move.
//
// Removing the per-line audit writer is only safe if nothing was reading it, so
// this is the negative half of the feature's evidence: the `monitor` projection
// and the `debugLogTail` projection answer exactly what they answered before,
// because neither ever sourced anything from `audit.log`.
//
//   - `monitor` is `projectMonitor(ctx.monitor)`, and its only input is
//     `Pick<ClaudeCliMonitor, 'getCurrentState'>` — the live state machine. The
//     readings an operator watches (`stdoutLines`, `lastStdoutAt`,
//     `msSinceLastStdout`) are moved by the same chunk handlers that used to
//     write the audit entries, and they still move with nothing being written.
//   - `debugLogTail` is `deps.getDebugLogTail?.()`, which the host wires to
//     `webviewLogSink.getEntries()` — a ring buffer of `SanitizedLogger` lines,
//     unrelated to the audit tier.
//
// Both are asserted through the real `composeWorkflowSnapshot` rather than
// through the two accessors alone: the claim is about the projection the webview
// receives, and the composer is where a stray audit read would have to appear.
//
// The third describe is the projection that DID change, recorded here so that
// "unchanged" is not read as a claim about all three. `AuditTailState` filters
// nothing and caps at `AUDIT_TAIL_MAX`, so a phase emitting hundreds of lines
// used to evict every workflow event from that tail before an operator could
// read one. Those tests measure the improvement instead of asserting stasis.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { WebviewLogSink, type DebugLogEntry } from '../../../src/lib/webview-log-sink';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import { CliTransportSink, type CliTransportRecorder } from '../../../src/monitor/cli-transport-sink';
import type { QueueState } from '../../../src/queue/feature-request';
import { AuditTailState } from '../../../src/ui/sidebar/audit-tail-state';
import { ProjectorBookkeepingRegistry } from '../../../src/ui/sidebar/projector-bookkeeping-registry';
import { AUDIT_TAIL_MAX, type WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';
import { composeWorkflowSnapshot } from '../../../src/ui/sidebar/snapshot-composer';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const IDLE_QUEUE: QueueState = {
  requests: [],
  inFlightId: null,
  paused: false,
  pausedReason: null,
  updatedAt: 0,
  queueLifecycle: 'active-empty',
  pauseSource: null,
  scheduledStartAt: null,
  scheduledStartSource: null
};

/** The monitor requires an audit writer; nothing here reads what it wrote. */
const AUDIT_STUB: Pick<AuditLogWriter, 'append'> = {
  append: async (entry) => ({
    ...entry,
    id: 'stub-entry',
    timestamp: '2026-05-10T12:00:00.000Z',
    schemaVersion: 3
  })
};

/** A monitor with no transport destination — the recorder is required, not the sink. */
const NULL_RECORDER: CliTransportRecorder = { record: () => {} };

/** Warnings this feature's sink emits, separated from anything else logged. */
function transportWarnings(tail: readonly DebugLogEntry[]): readonly DebugLogEntry[] {
  return tail.filter((entry) => entry.level === 'WARN' && entry.message.includes('[cli-transport]'));
}

interface Harness {
  readonly monitor: ClaudeCliMonitor;
  readonly logger: SanitizedLogger;
  readonly logSink: WebviewLogSink;
  readonly advance: (ms: number) => void;
  compose(): WorkflowSnapshot;
}

/**
 * A live monitor plus the real composer over it, on one injected clock.
 *
 * `recorderFor` receives the harness's own logger so a sink under test warns
 * into the very `debugLogTail` the assertions read.
 */
function harness(recorderFor?: (logger: SanitizedLogger) => CliTransportRecorder): Harness {
  let elapsed = 0;
  const wallStart = Date.parse('2026-05-10T12:00:00.000Z');
  const now = (): Date => new Date(wallStart + elapsed);
  const logSink = new WebviewLogSink();
  const logger = new SanitizedLogger([logSink]);
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: [],
    monotonicNow: () => 1_000 + elapsed,
    now,
    audit: AUDIT_STUB,
    transport: recorderFor ? recorderFor(logger) : NULL_RECORDER,
    activity: { record: () => {} },
    logger,
    setTimeout: () => 0,
    clearTimeout: () => {}
  });

  return {
    monitor,
    logger,
    logSink,
    advance: (ms) => {
      elapsed += ms;
    },
    compose: () =>
      composeWorkflowSnapshot({
        deps: { getDebugLogTail: () => logSink.getEntries() },
        store: {
          getRunMap: () => ({}),
          // Named parameter even though the stub answers the same for every
          // queue: `getQueue: () => …` is the shape FR-R3-002's lint gate
          // refuses, because it is indistinguishable from an ambient read.
          getQueue: (_queueId: string) => IDLE_QUEUE,
          getLock: () => null,
          subscribe: () => ({ dispose: () => {} })
        },
        runs: {},
        ownerId: 'this-window',
        forcedIsPrimary: true,
        now,
        logger,
        externalSanitize: null,
        monitor,
        history: null,
        defaultRunnerKind: 'claude',
        auditTail: [],
        bookkeepers: new ProjectorBookkeepingRegistry(() => 1_000 + elapsed),
        telemetry: null
      })
  };
}

/** One archived per-line entry, in the shape the removed writer produced. */
function legacyLineEntry(index: number): AuditEntry {
  return {
    id: `line-${index}`,
    timestamp: '2026-05-10T12:00:03.000Z',
    runId: 'run-1',
    phase: 'speckit-implement',
    iteration: 0,
    eventType: 'monitor-stdout-line',
    outcome: 'info',
    payload: { line: `chunk ${index} of the model's reply` },
    schemaVersion: 3,
    correlationId: 'run-1'
  };
}

function workflowEntry(id: string, eventType: AuditEntry['eventType']): AuditEntry {
  return {
    id,
    timestamp: '2026-05-10T12:00:04.000Z',
    runId: 'run-1',
    phase: 'speckit-implement',
    iteration: 0,
    eventType,
    outcome: 'success',
    payload: { pipelineId: 'default', phaseId: 'speckit-implement' },
    schemaVersion: 3,
    correlationId: 'run-1'
  };
}

/** A sink whose every append fails, so the failure path lands in the log tail. */
function failingSink(logger: SanitizedLogger, target: string, root: string): CliTransportSink {
  return new CliTransportSink({
    settings: { read: () => ({ root, path: target, maxBytes: 1024 * 1024, maxGenerations: 3 }) },
    sanitize: (line) => logger.sanitize(line),
    logger,
    appendFile: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
    writeFile: async () => {},
    mkdir: async () => undefined,
    stat: async () => ({ size: 0 }),
    realpath: async (candidate: string) => candidate
  });
}

describe('FR-R3-007 — the monitor projection is unchanged', () => {
  it('carries the live output volume the per-line entries used to duplicate', () => {
    const h = harness();
    h.monitor.onStart('run-1', 'speckit-implement', 4_242);
    h.advance(2_000);
    h.monitor.onStdoutChunk('run-1', 'alpha\nbeta\ngamma\n');
    h.advance(1_000);
    h.monitor.onStderrChunk('run-1', 'a warning\n');

    const monitor = h.compose().monitor;
    expect(monitor).not.toBeNull();
    expect(monitor).toMatchObject({
      runId: 'run-1',
      phase: 'speckit-implement',
      status: 'running',
      pid: 4_242,
      startedAt: '2026-05-10T12:00:00.000Z',
      lastStdoutAt: '2026-05-10T12:00:02.000Z',
      lastStderrAt: '2026-05-10T12:00:03.000Z',
      stdoutLines: 3,
      stderrLines: 1,
      exitCode: null,
      signal: null,
      detectedIssues: []
    });
    // The two readings the Monitor pill renders. Both come off the injected
    // monotonic clock, never off a log record's timestamp, which is why they
    // still answer with the audit log holding nothing about this invocation.
    expect(monitor!.msSinceLastStdout).toBe(1_000);
    expect(monitor!.msSinceLastStderr).toBe(0);
  });

  it('publishes the pre-feature fields plus the two aggregate stamps, and nothing else', () => {
    const h = harness();
    h.monitor.onStart('run-1', 'speckit-implement', 1);
    h.monitor.onStdoutChunk('run-1', 'a line\n');

    // Listed rather than derived, so a field added to the projection has to be
    // added here deliberately. The split is the point: everything the webview
    // read before is still here, and the change is strictly additive.
    const PRE_FEATURE_FIELDS = [
      'runId',
      'phase',
      'status',
      'pid',
      'startedAt',
      'lastStdoutAt',
      'lastStderrAt',
      'lastProgressAt',
      'stdoutLines',
      'stderrLines',
      'exitCode',
      'signal',
      'detectedIssues',
      'msSinceLastStdout',
      'msSinceLastStderr'
    ];
    // T353's addition. `stdoutLines`/`stderrLines` already existed; the interval
    // over which they accumulated is what the per-line timestamps used to be the
    // only record of, so removing that writer had to add these two.
    const ADDED_BY_THIS_FEATURE = ['firstOutputAt', 'lastOutputAt'];

    const keys = Object.keys(h.compose().monitor!);
    expect(keys.slice().sort()).toEqual([...PRE_FEATURE_FIELDS, ...ADDED_BY_THIS_FEATURE].sort());
    for (const field of PRE_FEATURE_FIELDS) {
      expect(keys, `${field} is a reading the webview already rendered`).toContain(field);
    }
  });

  it('keeps projecting a paused invocation — only a terminal one drops', () => {
    const h = harness();
    h.monitor.onStart('run-1', 'speckit-implement', 1);
    h.monitor.onStdoutChunk('run-1', 'output\n');
    h.monitor.onWorkflowPaused('run-1');

    const monitor = h.compose().monitor;
    expect(monitor, 'a paused Run is still in flight').not.toBeNull();
    expect(monitor!.status).toBe('paused');
    expect(monitor!.stdoutLines).toBe(1);
    expect(monitor!.msSinceLastStdout, 'the stall clock is not running while paused').toBeNull();
  });

  it('still drops a terminal invocation from the snapshot', () => {
    for (const exit of [
      { exitCode: 0, signal: null, killed: false, timedOut: false },
      { exitCode: 1, signal: null, killed: false, timedOut: false },
      { exitCode: null, signal: 'SIGKILL', killed: true, timedOut: false },
      { exitCode: null, signal: null, killed: false, timedOut: true }
    ]) {
      const h = harness();
      h.monitor.onStart('run-1', 'speckit-implement', 1);
      h.monitor.onStdoutChunk('run-1', 'output\n');
      h.monitor.onExit('run-1', exit);
      expect(h.compose().monitor, 'the snapshot surfaces in-flight activity only').toBeNull();
    }
  });

  it('takes no audit input at all — structurally, not by convention', () => {
    // The seam is the guarantee: `projectMonitor` is handed a `getCurrentState`
    // and nothing else, so there is no audit reader in it to regress. Asserted
    // against the source because a behavioural test cannot show the ABSENCE of
    // a read.
    const source = readFileSync(join(REPO_ROOT, 'src/ui/sidebar/monitor-projector.ts'), 'utf8');
    for (const forbidden of ['audit', 'metrics', 'cli-transport']) {
      expect(
        source.match(new RegExp(`from\\s+['"][^'"]*${forbidden}[^'"]*['"]`)),
        `monitor-projector.ts must not import the ${forbidden} tier`
      ).toBeNull();
    }
    expect(source).toContain('getCurrentState');
  });
});

describe('FR-R3-007 — the debug log tail is unchanged', () => {
  it('passes the log sink through verbatim', () => {
    const h = harness();
    h.logger.warn('projector: something worth seeing');
    h.logger.error('runner: and something worse');

    const tail = h.compose().debugLogTail;
    expect(tail).toEqual(h.logSink.getEntries());
    expect(tail.map((entry) => `${entry.level} ${entry.message}`)).toEqual([
      'WARN projector: something worth seeing',
      'ERROR runner: and something worse'
    ]);
  });

  it('gains nothing from a phase that emits hundreds of lines', () => {
    // The removed writer never logged, and the sink that replaced it must not
    // either: this is the surface an operator reads while a phase runs, and a
    // per-line narration would be the same defect relocated to another tier.
    const h = harness();
    h.monitor.onStart('run-1', 'speckit-implement', 1);
    const before = h.compose().debugLogTail.length;
    for (let index = 0; index < 600; index += 1) {
      h.monitor.onStdoutChunk('run-1', `{"type":"assistant","seq":${index}}\n`);
    }
    h.monitor.onStderrChunk('run-1', 'one line on the other stream\n');

    expect(h.compose().debugLogTail.length, 'transport is not narrated').toBe(before);
    expect(h.monitor.getCurrentState('run-1')!.stdoutLines).toBe(600);
  });

  it('shows a transport failure once, without the line or the path', async () => {
    // The bounded-noise property on the surface it actually lands on. A sink
    // warning per line would push 200 entries through a 200-slot ring buffer and
    // leave an operator with a tail containing nothing else.
    const root = join(REPO_ROOT, 'not-a-real-root');
    const target = join(root, '.schegent', 'cli-transport.log');
    let sink: CliTransportSink | null = null;
    const h = harness((logger) => {
      sink = failingSink(logger, target, root);
      return sink;
    });

    h.monitor.onStart('run-1', 'speckit-implement', 1);
    for (let index = 0; index < 200; index += 1) {
      h.monitor.onStdoutChunk('run-1', `secret-looking content ${index} at ${target}\n`);
    }
    await sink!.flushPendingWrites();

    const warnings = transportWarnings(h.compose().debugLogTail);
    expect(warnings, '200 failed records, one warning').toHaveLength(1);
    expect(warnings[0]!.message).toContain('could not record CLI output (EACCES)');
    expect(warnings[0]!.message, 'the phase is what matters, and it is unaffected').toContain(
      'the phase is unaffected'
    );
    expect(warnings[0]!.message, 'no line content').not.toContain('secret-looking content');
    expect(warnings[0]!.message, 'no destination path').not.toContain('cli-transport.log');
    // The counters the projection publishes are untouched by the write failing:
    // the sink is best-effort, so a phase whose capture is broken still reports
    // its own output volume.
    expect(h.compose().monitor!.stdoutLines).toBe(200);
  });
});

describe('FR-R3-007 — the projection that did change', () => {
  it('no longer evicts every workflow event from the audit tail', () => {
    // Pre-change: one phase's output alone overran the tail. `AuditTailState`
    // filters nothing, so the 50 slots held 50 consecutive CLI lines and the
    // `phase-start` that preceded them was already gone.
    const before = new AuditTailState();
    before.append(workflowEntry('phase-start-1', 'phase-start'));
    for (let index = 0; index < AUDIT_TAIL_MAX * 4; index += 1) {
      before.append(legacyLineEntry(index));
    }
    const beforeTail = before.snapshot();
    expect(beforeTail).toHaveLength(AUDIT_TAIL_MAX);
    expect(
      beforeTail.some((entry) => entry.id === 'phase-start-1'),
      'the workflow event an operator opened the view for'
    ).toBe(false);

    // Post-change: the same phase contributes one summary, so the tail spans the
    // run instead of one moment inside one invocation.
    const after = new AuditTailState();
    after.append(workflowEntry('phase-start-1', 'phase-start'));
    after.append(workflowEntry('summary-1', 'monitor-invocation-summary'));
    after.append(workflowEntry('phase-end-1', 'phase-end'));
    expect(after.snapshot().map((entry) => entry.id)).toEqual([
      'phase-start-1',
      'summary-1',
      'phase-end-1'
    ]);
  });

  it('still projects an archived per-line entry rather than dropping it', () => {
    // Warn-and-preserve reaches this tier too: an operator opening the view on a
    // log an older build wrote sees those entries, they are not filtered out.
    const tail = new AuditTailState();
    const projected = tail.append(legacyLineEntry(0));
    expect(projected.id).toBe('line-0');
    expect(projected.runId).toBe('run-1');
    expect(tail.snapshot()).toHaveLength(1);
  });
});
