// A failing snapshot projection stays quiet (FR-R4-F08, contract F: F-T1 to F-T7).
//
// WHAT THIS PINS. The sidebar's debug-log sink kicks the projector on every line
// it appends (`live-picture-wiring.ts:281`), and the composer used to write a
// WARN line each time a catalog or trust projection failed. A projection that
// kept failing therefore wrote a line, which kicked a projection, which failed
// again and wrote another: about one of each per 100 ms debounce window, for as
// long as the failure lasted. A failure episode now writes its first line only,
// so the loop ends after one warning-caused projection (FR-001 to FR-005).
//
// FIXTURE. A real `StateProjector` over a real `WorkspaceStateStore`, a virtual
// clock for its timer and monotonic clock, a real `SanitizedLogger` writing to a
// real `WebviewLogSink` (the kicker) and to a counting sink (the WARN census,
// since the ring buffer holds only 200 lines). `sink.setOnAppend(() => kick())`
// is set before `start()`, exactly as the live wiring does. A compose is counted
// by `getGeneralSettings`, which the composer calls once per compose.
//
// The token in F-T7 is assembled at run time so no secret-shaped literal sits in
// the tracked source.
//
// F-T9 is not one of the contract's cases. The close audit of 2026-11-01 (G8) found a source the cycle
// did not audit: `WorkspaceStateStore.getConnectedRuns()` wrote a WARN on every read while a persisted
// connected-run record was being dropped, and the composer reads it on every compose, so the same loop
// ran there. F-T9 runs it with the store given the fixture's logger.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger, type LogSink } from '../../../../src/lib/logger';
import { WebviewLogSink } from '../../../../src/lib/webview-log-sink';
import { StateProjector, type ProjectorTimer } from '../../../../src/ui/sidebar/state-projector';
import { IDLE_GENERAL_SETTINGS, type WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import type { FeatureRequest, QueueState } from '../../../../src/queue/feature-request';

const trustControl = vi.hoisted(() => ({ fail: false, message: 'trust resolver failed' }));

vi.mock('../../../../src/state/capability-trust-resolver', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/state/capability-trust-resolver')>();
  return {
    ...original,
    getResolvedCapabilities: () => {
      if (trustControl.fail) throw new Error(trustControl.message);
      return original.getResolvedCapabilities();
    }
  };
});

const IDLE_SECONDS = 600;
const SETTLE_SECONDS = 5;
const DEBOUNCE_MS = 100;
const PIPELINE_WARNING = 'failed to resolve pipeline catalog';
const WORKFLOW_WARNING = 'failed to resolve workflow catalog';
const TRUST_WARNING = 'failed to resolve trust capabilities';
const DROPPED_RUN_WARNING = 'dropped 1 connected run(s) failing persisted invariants';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

/** A virtual clock that runs due timers in order; nothing waits in real time. */
class VirtualClock implements ProjectorTimer {
  public now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  public setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  public advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const due = this.timers.get(dueId);
      this.timers.delete(dueId);
      if (due === undefined) break;
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = target;
  }
}

class CountingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
  public countWarn(fragment: string): number {
    return this.lines.filter((line) => line.includes(' WARN ') && line.includes(fragment)).length;
  }
}

interface Control {
  pipelineFails: boolean;
  workflowFails: boolean;
  pipelineMessage: () => string;
  composes: number;
  pipelineCalls: number;
}

interface Fixture {
  readonly clock: VirtualClock;
  readonly store: WorkspaceStateStore;
  readonly projector: StateProjector;
  readonly webviewSink: WebviewLogSink;
  readonly counting: CountingSink;
  readonly logger: SanitizedLogger;
  readonly control: Control;
  readonly received: WorkflowSnapshot[];
}

const live: StateProjector[] = [];

afterEach(() => {
  for (const projector of live.splice(0)) projector.dispose();
  trustControl.fail = false;
});

interface FixtureOptions {
  /**
   * F-T9. Persist a connected-run record the migrator drops, hand the store the fixture's logger, and
   * have the composer read the store's collection on each compose, as the live wiring does through
   * `ConnectedRunService.listProjections` (`ui-wiring.ts`). Off in every other case, so they are unchanged.
   */
  readonly droppedConnectedRun?: boolean;
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const droppedConnectedRun = options.droppedConnectedRun === true;
  const memento = new FakeMemento();
  if (droppedConnectedRun) {
    await memento.update(KEYS.connectedRuns, { 'cr-bad': { connectedRunId: 'cr-bad', status: 'running' } });
  }
  const clock = new VirtualClock();
  const webviewSink = new WebviewLogSink();
  const counting = new CountingSink();
  const logger = new SanitizedLogger([webviewSink, counting]);
  const store = new WorkspaceStateStore(memento, droppedConnectedRun ? logger : undefined);
  await store.initialize();
  const control: Control = {
    pipelineFails: false,
    workflowFails: false,
    pipelineMessage: () => 'pipeline catalog cause',
    composes: 0,
    pipelineCalls: 0
  };
  let projectorRef: StateProjector | null = null;
  webviewSink.setOnAppend(() => {
    if (projectorRef !== null) projectorRef.kick();
  });
  const projector = new StateProjector({
    store,
    ownerId: 'this-window',
    debounceMs: DEBOUNCE_MS,
    timer: clock,
    monotonicNow: () => clock.now,
    now: () => new Date(1_700_000_000_000 + clock.now),
    logger,
    getDebugLogTail: () => webviewSink.getEntries(),
    getGeneralSettings: () => {
      control.composes += 1;
      return IDLE_GENERAL_SETTINGS;
    },
    getPipelineCatalog: () => {
      control.pipelineCalls += 1;
      if (control.pipelineFails) throw new Error(control.pipelineMessage());
      return undefined;
    },
    getWorkflowCatalog: () => {
      if (control.workflowFails) throw new Error('workflow catalog cause');
      return undefined;
    },
    ...(droppedConnectedRun
      ? {
          getConnectedRuns: () => {
            store.getConnectedRuns();
            return [];
          }
        }
      : {})
  });
  projectorRef = projector;
  live.push(projector);
  projector.start();
  const received: WorkflowSnapshot[] = [];
  projector.subscribe((snapshot) => received.push(snapshot));
  return { clock, store, projector, webviewSink, counting, logger, control, received };
}

function pendingRequest(index: number): FeatureRequest {
  const at = 1_000_000 + index;
  return {
    id: `req-${index}`,
    description: `request ${index}`,
    enqueuedAt: at,
    createdAt: at,
    startedAt: null,
    updatedAt: at,
    completedAt: null,
    status: 'pending',
    position: index,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

function queueWithPending(count: number): QueueState {
  return {
    requests: Array.from({ length: count }, (_, index) => pendingRequest(index)),
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

/** A store change that is a real change: the queue gains `count` pending requests. */
async function changeStore(fixture: Fixture, count: number): Promise<void> {
  await fixture.store.setQueue(queueWithPending(count));
}

function idle(fixture: Fixture, seconds: number): void {
  fixture.clock.advance(seconds * 1_000);
}

function report(label: string, fixture: Fixture, warnings: Record<string, number>): void {
  process.stdout.write(
    `PROJECTION_FEEDBACK ${JSON.stringify({ case: label, composes: fixture.control.composes, ...warnings })}\n`
  );
}

describe('F-T1 a failing Pipeline projection', () => {
  it(`causes at most 2 composes and 1 warning over ${IDLE_SECONDS} idle seconds`, async () => {
    const fixture = await buildFixture();
    const composesBefore = fixture.control.composes;
    fixture.control.pipelineFails = true;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = fixture.counting.countWarn(PIPELINE_WARNING);
    report('F-T1 pipeline', fixture, { composesAfterChange: composes, warnings });
    expect(composes, 'composes after the failing change').toBeLessThanOrEqual(2);
    expect(composes, 'the change itself was projected').toBeGreaterThanOrEqual(1);
    expect(warnings, 'WARN lines for the Pipeline source').toBe(1);
  });
});

describe('F-T2 a cause message that changes on every call', () => {
  it('keeps the same bound, because the source is the identity, not the text', async () => {
    const fixture = await buildFixture();
    let counter = 0;
    fixture.control.pipelineMessage = () => `cause number ${++counter}`;
    const composesBefore = fixture.control.composes;
    fixture.control.pipelineFails = true;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = fixture.counting.countWarn(PIPELINE_WARNING);
    report('F-T2 varying cause', fixture, { composesAfterChange: composes, warnings });
    expect(composes).toBeLessThanOrEqual(2);
    expect(warnings).toBe(1);
  });
});

describe('F-T3 the other sources', () => {
  it('the Workflow source alone has the same bound', async () => {
    const fixture = await buildFixture();
    const composesBefore = fixture.control.composes;
    fixture.control.workflowFails = true;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = fixture.counting.countWarn(WORKFLOW_WARNING);
    report('F-T3 workflow', fixture, { composesAfterChange: composes, warnings });
    expect(composes).toBeLessThanOrEqual(2);
    expect(warnings).toBe(1);
  });

  it('the trust source alone has the same bound', async () => {
    const fixture = await buildFixture();
    const composesBefore = fixture.control.composes;
    trustControl.fail = true;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = fixture.counting.countWarn(TRUST_WARNING);
    report('F-T3 trust', fixture, { composesAfterChange: composes, warnings });
    expect(composes).toBeLessThanOrEqual(2);
    expect(warnings).toBe(1);
  });

  it('all three failing in one compose write 3 warnings and cause at most 2 composes', async () => {
    const fixture = await buildFixture();
    const composesBefore = fixture.control.composes;
    fixture.control.pipelineFails = true;
    fixture.control.workflowFails = true;
    trustControl.fail = true;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = {
      pipeline: fixture.counting.countWarn(PIPELINE_WARNING),
      workflow: fixture.counting.countWarn(WORKFLOW_WARNING),
      trust: fixture.counting.countWarn(TRUST_WARNING)
    };
    report('F-T3 all three', fixture, { composesAfterChange: composes, ...warnings });
    expect(composes).toBeLessThanOrEqual(2);
    expect(warnings).toEqual({ pipeline: 1, workflow: 1, trust: 1 });
  });
});

describe('F-T4 recovery ends an episode', () => {
  it('fail, recover, fail writes 2 warnings, and the snapshot after recovery is the recovered projection', async () => {
    const fixture = await buildFixture();
    fixture.control.pipelineFails = true;
    await changeStore(fixture, 1);
    idle(fixture, SETTLE_SECONDS);
    const failing = fixture.received.at(-1);
    if (failing === undefined) throw new Error('no snapshot was delivered');
    expect(failing.pipelineCatalog?.state, 'the failing projection').toBe('error');
    expect(fixture.counting.countWarn(PIPELINE_WARNING), 'one warning so far').toBe(1);

    fixture.control.pipelineFails = false;
    await changeStore(fixture, 2);
    idle(fixture, SETTLE_SECONDS);
    const recovered = fixture.received.at(-1);
    if (recovered === undefined) throw new Error('no snapshot was delivered');
    expect(recovered.pipelineCatalog, 'the recovered projection carries no error state').toBeUndefined();
    expect(fixture.counting.countWarn(PIPELINE_WARNING), 'recovery writes nothing').toBe(1);

    fixture.control.pipelineFails = true;
    await changeStore(fixture, 3);
    idle(fixture, SETTLE_SECONDS);
    const warnings = fixture.counting.countWarn(PIPELINE_WARNING);
    report('F-T4 fail-recover-fail', fixture, { warnings });
    expect(warnings, 'a new episode opens after recovery').toBe(2);
  });
});

describe('F-T5 an open episode never suppresses a projection', () => {
  it('a store change during an episode is projected and every listener receives it', async () => {
    const fixture = await buildFixture();
    const second: WorkflowSnapshot[] = [];
    fixture.projector.subscribe((snapshot) => second.push(snapshot));
    fixture.control.pipelineFails = true;
    await changeStore(fixture, 1);
    idle(fixture, SETTLE_SECONDS);
    expect(fixture.counting.countWarn(PIPELINE_WARNING), 'the episode is open').toBe(1);
    // The planted control: before the change below, no delivered snapshot carries 3 pending requests.
    const pendingBefore = fixture.received.at(-1)?.queue.pending.length;
    expect(pendingBefore, 'the control: the change is absent beforehand').toBe(1);

    await changeStore(fixture, 3);
    idle(fixture, SETTLE_SECONDS);
    expect(fixture.received.at(-1)?.queue.pending.length, 'listener one').toBe(3);
    expect(second.at(-1)?.queue.pending.length, 'listener two').toBe(3);
    expect(fixture.counting.countWarn(PIPELINE_WARNING), 'still one warning').toBe(1);
  });
});

describe('F-T6 an ordinary line still refreshes the debug tail', () => {
  it('an info line kicks exactly one compose and appears in that snapshot', async () => {
    const fixture = await buildFixture();
    // The planted control: with no line written, no compose happens.
    const composesIdle = fixture.control.composes;
    idle(fixture, 60);
    expect(fixture.control.composes - composesIdle, 'the control: nothing composes when nothing is logged').toBe(0);

    const composesBefore = fixture.control.composes;
    fixture.logger.info('an ordinary operator-visible line');
    idle(fixture, SETTLE_SECONDS);
    const snapshot = fixture.received.at(-1);
    if (snapshot === undefined) throw new Error('no snapshot was delivered');
    report('F-T6 info line', fixture, { composesAfterLine: fixture.control.composes - composesBefore });
    expect(fixture.control.composes - composesBefore, 'composes caused by one info line').toBe(1);
    expect(
      snapshot.debugLogTail.some((entry) => entry.message.includes('an ordinary operator-visible line')),
      'the line is in the debug tail of that snapshot'
    ).toBe(true);
  });
});

describe('F-T7 a secret-shaped cause reaches the sink redacted', () => {
  it('writes the sanitized cause, not the raw token', async () => {
    const fixture = await buildFixture();
    // Assembled at run time: no secret-shaped literal in the tracked source.
    const rawToken = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
    expect(fixture.logger.sanitize(rawToken), 'the control: the token is one the logger redacts').not.toBe(rawToken);
    fixture.control.pipelineMessage = () => `registry rejected credential ${rawToken}`;
    fixture.control.pipelineFails = true;
    await changeStore(fixture, 1);
    idle(fixture, SETTLE_SECONDS);
    const written = fixture.counting.lines.filter((line) => line.includes(PIPELINE_WARNING));
    expect(written.length, 'the warning was written once').toBe(1);
    expect(written.every((line) => !line.includes(rawToken)), 'the raw token never reaches a sink').toBe(true);
    expect(written.every((line) => line.includes('[REDACTED]')), 'the sink holds the redaction sentinel').toBe(true);
    expect(
      fixture.webviewSink.getEntries().every((entry) => !entry.message.includes(rawToken)),
      'the debug tail holds no raw token either'
    ).toBe(true);
  });
});

describe('F-T9 a persisted connected run the migrator drops', () => {
  it(`is named once and causes at most 2 composes over ${IDLE_SECONDS} idle seconds`, async () => {
    const fixture = await buildFixture({ droppedConnectedRun: true });
    const composesBefore = fixture.control.composes;
    await changeStore(fixture, 1);
    idle(fixture, IDLE_SECONDS);
    const composes = fixture.control.composes - composesBefore;
    const warnings = fixture.counting.countWarn(DROPPED_RUN_WARNING);
    const inDebugTail = fixture.webviewSink
      .getEntries()
      .filter((entry) => entry.message.includes(DROPPED_RUN_WARNING)).length;
    report('F-T9 dropped connected run', fixture, { composesAfterChange: composes, warnings, inDebugTail });
    expect(warnings, 'the control: the record is dropped and the warning does reach the sink').toBeGreaterThanOrEqual(1);
    expect(composes, 'the change itself was projected').toBeGreaterThanOrEqual(1);
    expect(composes, 'composes after the change').toBeLessThanOrEqual(2);
    expect(warnings, 'WARN lines for the dropped record').toBe(1);
    expect(inDebugTail, 'the sidebar debug tail holds it once').toBe(1);
  });
});
