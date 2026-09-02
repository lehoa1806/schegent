// Bug "there is no way to start a pending task" (2026-09-02), first finding —
// the badge that said Running over a queue that was not.
//
// The operator's dashboard read "Default queue: Running — 0 completed, 0 failed,
// 21 pending" while nothing executed and nothing was going to. That badge is the
// only thing on the surface that claims to say whether a queue is working, and it
// was reporting `QueueLifecycle`, which does not answer that question:
// `'running'` is the lifecycle's UNHELD-WITH-WORK member — "the drain may visit
// this queue" — and the host writes it as a promise that a start will be
// attempted, one statement before the attempt. Every way the drain can decline
// (the workspace is at its concurrency ceiling, the execution lease went to
// another window, the admission threw) leaves the promise standing over an empty
// engine.
//
// So the badge needs the same split the surfaces below it already made:
// `queue-runtime-view.ts`'s `isWorkingARun` (liveness) against `ownsRun`
// (presence). `queueLifecycleLabel` keeps naming the lifecycle, because the
// lifecycle is a real thing a surface may want named; `queueRuntimeLabel` is what
// a badge over a live queue asks, and it consults both.

import { describe, expect, it } from 'vitest';

import { queueLifecycleLabel, queueRuntimeLabel } from '../queue-lifecycle-label';
import type { QueueLifecycle } from '../snapshot-types';
import { buildInFlightRun, buildQueueRuntime } from './queue-runtime-fixture';

const EVERY_LIFECYCLE: readonly QueueLifecycle[] = [
  'running',
  'operator-paused',
  'idle-pending',
  'active-empty'
];

describe('queueLifecycleLabel — the lifecycle, named', () => {
  it('names every member of the union', () => {
    // Unchanged by this bug. The lifecycle map is still exhaustive and still
    // says `Running` for the unheld-with-work member, because that IS the name
    // of that lifecycle. What changed is which surfaces ask it.
    expect(EVERY_LIFECYCLE.map(queueLifecycleLabel)).toEqual([
      'Running',
      'Paused',
      'Idle (pending)',
      'Active (empty)'
    ]);
  });
});

describe('queueRuntimeLabel — what the queue is actually doing', () => {
  it('says Running only when a Run is executing', () => {
    const runtime = buildQueueRuntime({
      lifecycle: 'running',
      inFlightRun: buildInFlightRun({ status: 'running' }),
      pendingCount: 20
    });

    expect(queueRuntimeLabel(runtime)).toBe('Running');
  });

  it('says Active (waiting) for the wedged queue the bug report describes', () => {
    // The reported state, exactly: unheld, twenty-one rows pending, no Run.
    const runtime = buildQueueRuntime({
      lifecycle: 'running',
      inFlightRun: null,
      pendingCount: 21
    });

    expect(queueRuntimeLabel(runtime)).toBe('Active (waiting)');
  });

  it('says Active (waiting) when the queue owns a Run that has ended', () => {
    // Presence is not liveness — the reading `inFlightRun !== null` publishes and
    // all it publishes. A queue whose Run failed still carries the record, and
    // that record is what a badge reading presence mistook for work in progress.
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const runtime = buildQueueRuntime({
        lifecycle: 'running',
        inFlightRun: buildInFlightRun({ status }),
        pendingCount: 3
      });

      expect(queueRuntimeLabel(runtime), `a ${status} Run is not work in progress`).toBe(
        'Active (waiting)'
      );
    }
  });

  it('is distinguishable from the held lifecycle that also has pending work', () => {
    // The two states an operator has to tell apart to know what to do next.
    // `idle-pending` is HELD: it waits for the operator or for a schedule, and
    // the FR-018 chooser is how it is released. The wedged queue is UNHELD: it
    // needs nobody's permission and is waiting on a drain that has not come. One
    // reads Idle, the other Active — and neither reads Running.
    const held = buildQueueRuntime({ lifecycle: 'idle-pending', pendingCount: 21 });
    const unheld = buildQueueRuntime({ lifecycle: 'running', pendingCount: 21 });

    expect(queueRuntimeLabel(held)).toBe('Idle (pending)');
    expect(queueRuntimeLabel(unheld)).toBe('Active (waiting)');
    expect(queueRuntimeLabel(held)).not.toBe(queueRuntimeLabel(unheld));
  });

  it('reports every other lifecycle exactly as the lifecycle map does', () => {
    // The liveness reading is a refinement of ONE member, not a second
    // vocabulary. A held queue holds whether or not a Run is executing on it —
    // `operator-paused` with a Run mid-phase is a queue whose current Run
    // finishes and whose successors wait — so those labels must not move.
    for (const lifecycle of EVERY_LIFECYCLE) {
      if (lifecycle === 'running') continue;
      const idle = buildQueueRuntime({ lifecycle });
      const busy = buildQueueRuntime({
        lifecycle,
        inFlightRun: buildInFlightRun({ status: 'running' })
      });
      expect(queueRuntimeLabel(idle)).toBe(queueLifecycleLabel(lifecycle));
      expect(queueRuntimeLabel(busy)).toBe(queueLifecycleLabel(lifecycle));
    }
  });
});
