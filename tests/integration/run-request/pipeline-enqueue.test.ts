// Feature 087 (T043, US3, FR-029, SC-002) — a submission is all-or-nothing.
//
// This drives the real submission path end to end: `validateRunRequest()` →
// `GuardedRunService.scheduleOrEnqueue()` → `QueueManager.enqueue()` → the
// backing `WorkspaceStateStore`. Nothing is faked below the validator, because
// the invariant being pinned is about *what reaches storage*, and a fake store
// would be pinning the fake.
//
// Two halves, from plan.md D2:
//
//   Failing validation → nothing durable. SC-002 says "byte-for-byte", so the
//   assertion is byte-for-byte: the whole backing store is serialized before and
//   after and compared as a string. A field that appeared, moved, or was
//   re-stamped fails it, which a structural comparison would forgive.
//
//   Passing validation → exactly one durable write: the queue insertion carrying
//   the frozen plan. The run store is never touched at submission — the
//   `WorkflowRun` materializes later, at drain, from that plan — so FR-029's "no
//   Run without a queue position and no queue position lacking its frozen plan"
//   holds by construction rather than by transaction.
//
// One honest caveat, asserted rather than hidden: feature 065's start-intent
// policy writes the queue key a second time to move the lifecycle into
// `idle-pending`. That write carries no record — it adds no queue row and no run
// — so the submission's *record* count is still one. The test therefore counts
// row-adding writes, and separately pins that the extra write adds nothing.

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { RunRequest } from '../../../src/contracts/run-request';
import type { QueueState } from '../../../src/queue/feature-request';
import { KEYS } from '../../../src/state/workspace-state';
import {
  validateRunRequest,
  type EffectivePipelineSource
} from '../../../src/services/run-request/run-request-validator';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';

const NOW = 1_700_000_000_000;

const COMPOSE: PhaseDef = {
  id: 'compose', name: 'Compose', version: 1, instruction: 'Compose the thing.',
  sourceScope: 'built-in'
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)', sourceScope: 'built-in'
};

const COMPOSE_FLOW: PipelineDef = {
  id: 'compose-flow',
  name: 'Compose Flow',
  phases: ['compose'],
  sourceScope: 'workspace',
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: []
};

function catalog(): PipelineCatalog {
  return buildCatalog(
    [COMPOSE, DONE], [COMPOSE_FLOW], { claude: [], codex: [], agy: [] }, 'compose-flow'
  );
}

const SOURCE: EffectivePipelineSource = {
  definition: COMPOSE_FLOW,
  phases: [COMPOSE],
  defaultRunnerKind: 'claude'
};

/** Accepting probes: this suite's refusal is driven by the request, not the disk. */
const PORTS = {
  localInputs: {
    checkFile: async () => ({ ok: true }) as const,
    checkFolder: async () => ({ ok: true }) as const
  },
  outputProbe: { exists: async () => false },
  priorOutputs: { outputsFor: () => [] as const }
};

const VALID: RunRequest = {
  pipelineId: 'compose-flow',
  inputs: [{ portId: 'brief', type: 'text', value: 'ship the composer' }],
  supplemental: [],
  outputs: [],
  instructions: 'ship the composer'
};

/** The required `brief` port is left unsupplied, so validation refuses. */
const INVALID: RunRequest = { ...VALID, inputs: [] };

interface Writes {
  /** Every `Memento.update` this submission performed, in order. */
  readonly keys: string[];
  /** The subset that grew `schegent.queue.requests` — the durable records. */
  rowAdding: number;
  /** Whether the run store was written at all. */
  touchedRun: boolean;
}

/**
 * Runs the whole submission path against a real store, recording what it wrote.
 * Returns the validation outcome so a caller can assert the refusal too.
 */
async function submit(
  harness: Harness,
  request: RunRequest
): Promise<{
  readonly accepted: boolean;
  readonly writes: Writes;
  readonly before: string;
  readonly after: string;
}> {
  const snapshot = (): string =>
    JSON.stringify(Object.values(KEYS).map((key) => [key, harness.memento.get(key)]));

  const writes: Writes = { keys: [], rowAdding: 0, touchedRun: false };
  const originalUpdate = harness.memento.update.bind(harness.memento);
  // Feature 092 — `KEYS.queue` holds `Record<queueId, QueueState>`, so a row
  // count is a count across every queue. The claim under test is "exactly one
  // durable row was added", which is a statement about the whole store and not
  // about the queue the row happened to land in.
  const requestCount = (): number =>
    Object.values(harness.memento.get<Record<string, QueueState>>(KEYS.queue) ?? {}).reduce(
      (total, queue) => total + (queue?.requests?.length ?? 0),
      0
    );

  harness.memento.update = (key: string, value: unknown): Thenable<void> => {
    const rowsBefore = requestCount();
    writes.keys.push(key);
    if (key === KEYS.run) writes.touchedRun = true;
    const done = originalUpdate(key, value);
    if (requestCount() > rowsBefore) writes.rowAdding += 1;
    return done;
  };

  const before = snapshot();
  try {
    const outcome = await validateRunRequest(request, {
      pipeline: SOURCE,
      workspaceRoot: harness.workspaceRoot,
      now: NOW,
      ...PORTS
    });
    if (!outcome.ok) {
      return { accepted: false, writes, before, after: snapshot() };
    }
    const result = await harness.service.scheduleOrEnqueue({
      description: outcome.plan.instructions ?? 'composed run',
      scheduledAt: NOW,
      via: 'webview',
      pipelineId: outcome.plan.pipeline.id,
      runPlan: outcome.plan
    });
    expect(result.outcome).toBe('enqueued');
    return { accepted: true, writes, before, after: snapshot() };
  } finally {
    harness.memento.update = originalUpdate;
  }
}

describe('a submission that fails validation leaves nothing behind (SC-002)', () => {
  it('leaves the backing store byte-for-byte unchanged', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const { accepted, before, after } = await submit(harness, INVALID);

      expect(accepted).toBe(false);
      expect(after).toBe(before);
    } finally {
      harness.cleanup();
    }
  });

  it('performs no write at all — not to the queue, the run store, or anything else', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const { writes } = await submit(harness, INVALID);

      expect(writes.keys).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('leaves the catalog untouched', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const pristine = JSON.stringify(catalog().pipelines);

      await submit(harness, INVALID);

      expect(JSON.stringify(catalog().pipelines)).toBe(pristine);
    } finally {
      harness.cleanup();
    }
  });

  it('refuses before the queue is consulted, so a paused queue reports the same thing', async () => {
    // Ordering guard: were the enqueue attempted first, a paused queue would
    // mask the field error and the operator would correct the wrong thing.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await harness.store.setQueue({ ...harness.store.getQueue('default'), paused: true });

      const { accepted, before, after } = await submit(harness, INVALID);

      expect(accepted).toBe(false);
      expect(after).toBe(before);
    } finally {
      harness.cleanup();
    }
  });
});

describe('a submission that passes validation performs exactly one durable write (FR-029)', () => {
  it('adds exactly one queue row', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const { accepted, writes } = await submit(harness, VALID);

      expect(accepted).toBe(true);
      expect(writes.rowAdding).toBe(1);
      expect(harness.store.getQueue('default').requests).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });

  it('never writes the run store — the Run materializes at drain (D2)', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const { writes } = await submit(harness, VALID);

      expect(writes.touchedRun).toBe(false);
      // Feature 093 (T027) — `KEYS.run` holds a `Record<queueId, WorkflowRun>`
      // now, and the v10 → v11 reshape writes the empty record during
      // `initialize()`, before `submit()` installs the write tracker. So the key
      // is present and the claim is about its contents: no Run. The submission's
      // own behaviour is `writes.touchedRun` above, and that is unchanged — one
      // queue row written, the run store untouched.
      expect(harness.memento.get(KEYS.run)).toEqual({});
    } finally {
      harness.cleanup();
    }
  });

  it('leaves no queue position lacking the frozen plan its Run will execute', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await submit(harness, VALID);

      const [row] = harness.store.getQueue('default').requests;
      expect(row?.runPlan?.pipeline.id).toBe('compose-flow');
      expect(row?.runPlan?.pipeline.phases.map((phase) => phase.id)).toEqual(['compose']);
      expect(row?.runPlan?.inputs).toEqual([
        { portId: 'brief', type: 'text', value: 'ship the composer' }
      ]);
      expect(row?.runPlan?.frozenAt).toBe(NOW);
    } finally {
      harness.cleanup();
    }
  });

  it('survives the round trip through storage rather than only through the manager', async () => {
    // `getQueue()` reads back out of the memento, but a plan that failed to
    // serialize would still be visible on the in-memory object the manager
    // returned. This reads the raw stored value instead.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      await submit(harness, VALID);

      const stored = harness.memento.get<Record<string, QueueState>>(KEYS.queue);
      const raw = JSON.parse(
        JSON.stringify(Object.values(stored ?? {}).flatMap((queue) => queue?.requests ?? []))
      );
      expect(raw[0]?.runPlan?.pipeline?.phases?.[0]?.instruction).toBe('Compose the thing.');
    } finally {
      harness.cleanup();
    }
  });

  it('writes the queue key only for the row and the pre-existing lifecycle move', async () => {
    // Feature 065's start-intent policy makes a second queue-key write to enter
    // `idle-pending`. Pinned explicitly so it stays a lifecycle move: it adds no
    // row and no run, so the submission still commits exactly one record.
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const { writes } = await submit(harness, VALID);

      expect(new Set(writes.keys)).toEqual(new Set([KEYS.queue]));
      expect(writes.rowAdding).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('leaves the catalog untouched on the accepting path too', async () => {
    const harness = await makeHarness({ initialNow: NOW, catalog: catalog() });
    try {
      const pristine = JSON.stringify(catalog().pipelines);

      await submit(harness, VALID);

      expect(JSON.stringify(catalog().pipelines)).toBe(pristine);
    } finally {
      harness.cleanup();
    }
  });
});
