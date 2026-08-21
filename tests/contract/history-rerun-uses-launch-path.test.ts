// Feature 103 (T063, T064 — FR-038, FR-039) — re-running from History is a
// launch, and nothing else.
//
// FR-038's claim is negative: a re-run passes *exactly* the gates any other
// launch passes and is audited identically, because there is no second path for
// it to take. Negative claims are the ones that rot quietly — the day someone
// adds a "repeat this run" handler that enqueues directly, every behavioural
// test in this file still passes and the requirement is gone. So the file makes
// the claim twice: behaviourally, by dispatching a re-run-shaped payload and an
// ordinary launch through the same real `MessageRouter` and comparing what
// reaches the queue seam; and structurally, by asserting that exactly one place
// in the host freezes a plan and enqueues it.
//
// The only thing a re-run adds to the wire is `queueId` (FR-059), so every
// assertion below is doubled across "a queue was named" and "none was" — a
// field that softened a gate, or that let a submitted `catalogVersion` through
// the widened allowlist, would be the privileged path this feature must not
// create.
//
// FR-039's half is the other direction: History retains no input port values,
// so a re-run's form is very often incomplete. That incompleteness must arrive
// as a named refusal the operator can act on, never as a plan quietly frozen
// without the port that could not be fulfilled.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  workspaceRoot: '/tmp/schegent-history-rerun-contract' as string | null
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () =>
    mocks.workspaceRoot === null
      ? undefined
      : { uri: { fsPath: mocks.workspaceRoot, scheme: 'file' }, name: 'ws', index: 0 }
}));

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import type { CatalogVersionRef } from '../../src/contracts/catalog-version';
import type { FrozenRunPlan } from '../../src/contracts/run-request';
import { CMD_LAUNCH_PIPELINE } from '../../src/contracts/sidebar-ipc';
import type { LaunchPipelineResult } from '../../src/contracts/sidebar-ipc/run-launcher';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../src/services/guarded-run-service';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALPHA: PhaseDef = { id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.' };

const PIPE_A: PipelineDef = {
  id: 'pipe-a',
  name: 'Pipeline A',
  phases: ['alpha'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

/**
 * The Active version, and deliberately not the one a repeated run would have
 * frozen. FR-034 targets what is published now; if the freeze ever read the
 * submission instead of the host's resolver, this id is what would go missing.
 */
const ACTIVE: CatalogVersionRef = { kind: 'pipeline', id: 'pipe-a', versionId: 'v7' };
/** What the history row recorded — superseded, and never sent (FR-024). */
const HISTORICAL_VERSION_ID = 'v1';

function catalog(): PipelineCatalog {
  return buildCatalog([ALPHA], [PIPE_A], { claude: [], codex: [], agy: [] }, 'pipe-a');
}

/** Untyped so the refusal cases can carry a key the wire type does not declare. */
function runRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    pipelineId: 'pipe-a',
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [{ kind: 'text', text: 'carried over from the run' }],
    outputs: [{ portId: 'report', target: 'out/report.md' }],
    ...overrides
  };
}

interface Harness {
  readonly router: MessageRouter;
  readonly acks: CommandAckMessage[];
  readonly scheduled: GuardedScheduleRequest[];
  readonly versionReads: string[];
}

function buildRouter(): Harness {
  const acks: CommandAckMessage[] = [];
  const scheduled: GuardedScheduleRequest[] = [];
  const versionReads: string[] = [];
  const resolved = catalog();

  const deps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (value: string) => value
    },
    defaultRunnerKind: 'codex',
    getCatalog: () => resolved,
    // The host's own resolver, recorded so "the version came from here" is an
    // assertion rather than an inference from the value.
    resolveCatalogVersion: (pipelineId: string): CatalogVersionRef | undefined => {
      versionReads.push(pipelineId);
      return pipelineId === ACTIVE.id ? ACTIVE : undefined;
    },
    guardedRun: {
      scheduleOrEnqueue: async (request: GuardedScheduleRequest): Promise<GuardedScheduleResult> => {
        scheduled.push(request);
        return { outcome: 'enqueued', queueItemId: 'queue-item-1' };
      }
    }
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, scheduled, versionReads };
}

/** `queueId` omitted rather than sent as `undefined` — see `cmd-launch-pipeline.ts`. */
async function dispatch(harness: Harness, request: unknown, queueId?: string): Promise<void> {
  await harness.router.dispatch(
    {
      type: CMD_LAUNCH_PIPELINE,
      correlationId: 'rerun-1',
      payload: { request, ...(queueId === undefined ? {} : { queueId }) }
    } as unknown as SidebarCommand,
    async (msg) => {
      harness.acks.push(msg);
      return true;
    }
  );
}

function only(harness: Harness): LaunchPipelineResult {
  expect(harness.acks).toHaveLength(1);
  return (harness.acks[0] as { result?: unknown }).result as LaunchPipelineResult;
}

function errorsOf(result: LaunchPipelineResult): readonly { field: string; code: string }[] {
  expect(result.outcome).toBe('rejected-validation');
  return (result as Extract<LaunchPipelineResult, { outcome: 'rejected-validation' }>).errors;
}

/** The plan as the queue seam received it, with the one field that cannot repeat. */
function planWithoutClock(request: GuardedScheduleRequest): Omit<FrozenRunPlan, 'frozenAt'> {
  const plan = request.runPlan as FrozenRunPlan;
  expect(typeof plan.frozenAt).toBe('number');
  const { frozenAt: _frozenAt, ...rest } = plan;
  return rest;
}

// ---------------------------------------------------------------------------
// T063 — the same gates, the same audit, no second path (FR-038)
// ---------------------------------------------------------------------------

describe('a re-run reaches the ordinary launch seam (FR-038)', () => {
  it('enqueues through the same command, attributed the same way', async () => {
    const rerun = buildRouter();
    await dispatch(rerun, runRequest(), 'q-nightly');

    expect(only(rerun)).toMatchObject({ outcome: 'enqueued', requestId: 'queue-item-1' });
    // `via` is the audit field: a re-run that arrived through a handler of its
    // own would be attributable to something other than the webview, and the
    // queue's record of who started the work would stop meaning one thing.
    expect(rerun.scheduled[0]).toMatchObject({ via: 'webview', pipelineId: 'pipe-a' });
  });

  it('freezes the version the host resolved, never one the submission named', async () => {
    const rerun = buildRouter();
    await dispatch(rerun, runRequest(), 'q-nightly');

    expect(rerun.versionReads).toEqual(['pipe-a']);
    const plan = rerun.scheduled[0].runPlan as FrozenRunPlan;
    expect(plan.catalogVersion).toEqual(ACTIVE);
    // FR-034 restated at the seam: the version the repeated run froze is not
    // what this run freezes, and nothing on this path can make it so. Asserted
    // on the field rather than on the serialized plan, which carries unrelated
    // version scalars of its own (`promptVersion`, a Phase's `version`).
    expect(plan.catalogVersion?.versionId).not.toBe(HISTORICAL_VERSION_ID);
  });

  it('freezes an identical plan whether or not a queue was named', async () => {
    const named = buildRouter();
    const unnamed = buildRouter();
    await dispatch(named, runRequest(), 'q-nightly');
    await dispatch(unnamed, runRequest());

    // Everything but the clock, which cannot repeat and is not the claim. If
    // naming a queue changed one frozen field, "exactly the gates any other
    // launch passes" would be false at the only place it is observable.
    expect(planWithoutClock(named.scheduled[0])).toEqual(planWithoutClock(unnamed.scheduled[0]));
    expect(named.scheduled[0].description).toEqual(unnamed.scheduled[0].description);
    expect(named.scheduled[0].via).toEqual(unnamed.scheduled[0].via);
  });

  it('carries the resolved queue verbatim to the queue guards', async () => {
    const rerun = buildRouter();
    await dispatch(rerun, runRequest(), 'q-nightly');
    expect(rerun.scheduled[0].queueId).toBe('q-nightly');
  });

  it('names no queue when the re-run resolved none, leaving the default to the seam', async () => {
    const launch = buildRouter();
    await dispatch(launch, runRequest());
    // Absent, not `undefined`: the seam distinguishes "not named" from "named
    // nothing", and only the first defaults.
    expect('queueId' in launch.scheduled[0]).toBe(false);
  });
});

describe('naming a queue opens no door a launch does not have (FR-038)', () => {
  const withQueue = (request: unknown, extra: Record<string, unknown> = {}): unknown => ({
    type: CMD_LAUNCH_PIPELINE,
    correlationId: 'rerun-1',
    payload: { request, queueId: 'q-nightly', ...extra }
  });

  it('accepts the re-run shape, so the refusals below are about the version', () => {
    expect(validateInboundMessage(withQueue(runRequest()))).toMatchObject({ ok: true });
  });

  it('still refuses a version submitted inside the request', () => {
    expect(
      validateInboundMessage(withQueue(runRequest({ catalogVersion: ACTIVE })))
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('still refuses a version submitted beside the request', () => {
    // The allowlist grew by exactly one key. A payload carrying provenance did
    // not come from this product's surface, and it is refused rather than
    // stripped so the attempt stays visible (FR-024).
    expect(validateInboundMessage(withQueue(runRequest(), { catalogVersion: ACTIVE }))).toMatchObject(
      { ok: false, reason: 'invalid-payload' }
    );
  });

  it.each([[''], [null], [42], ['q'.repeat(257)]])(
    'refuses a malformed queueId %p rather than falling back to the default',
    (queueId) => {
      expect(
        validateInboundMessage({
          type: CMD_LAUNCH_PIPELINE,
          correlationId: 'rerun-1',
          payload: { request: runRequest(), queueId }
        })
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    }
  );
});

describe('no privileged start path exists (FR-038)', () => {
  function sourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...sourceFiles(absolute));
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
    }
    return files;
  }

  const SRC = path.resolve(process.cwd(), 'src');

  it('freezes and enqueues a run plan from exactly one place', () => {
    // Structural, because the behavioural half above can only compare paths
    // that exist. A handler added tomorrow that composes its own plan and calls
    // the queue directly would pass every assertion in this file except this
    // one — and it is precisely the thing FR-038 forbids.
    const freezers = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('scheduleOrEnqueue({') && source.includes('runPlan');
      })
      .map((file) => path.relative(SRC, file));

    expect(freezers).toEqual([path.join('services', 'workflow-execution', 'node-run-starter.ts')]);
  });

  it('is not the one-click repeat History already had', () => {
    // `CMD_RERUN_FROM_HISTORY` enqueues a description and freezes nothing, so a
    // run started through it records no version at all. That is correct for
    // feature 013's one-click repeat and wrong for this surface twice over: it
    // submits without asking (FR-039) and it produces a run whose provenance is
    // unrecoverable. The dashboard's Rerun therefore goes to the launch path,
    // and this line is why the old one may not be reused rather than extended.
    const source = fs.readFileSync(path.join(SRC, 'commands', 'rerun-from-history.ts'), 'utf8');
    expect(source).toContain('scheduleOrEnqueue({');
    expect(source).not.toContain('runPlan');
  });
});

// ---------------------------------------------------------------------------
// T064 — an unfulfillable input is surfaced, never dropped (FR-039)
// ---------------------------------------------------------------------------

describe('an input that can no longer be fulfilled is surfaced (FR-039)', () => {
  /** What a re-run composes against a Pipeline that has since changed shape. */
  function staleRequest(): unknown {
    return runRequest({
      inputs: [
        { portId: 'brief', type: 'text', value: 'ship it' },
        { portId: 'legacy-notes', type: 'text', value: 'from the run being repeated' }
      ]
    });
  }

  it('names the port the Pipeline no longer declares, and enqueues nothing', async () => {
    const rerun = buildRouter();
    await dispatch(rerun, staleRequest(), 'q-nightly');

    expect(errorsOf(only(rerun)).map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([['inputs.legacy-notes', 'unknown-input-port']])
    );
    // The whole of "never quietly dropped": no plan reached the queue, so there
    // is no run that silently omits the input the operator supplied.
    expect(rerun.scheduled).toHaveLength(0);
  });

  it('reports every unfulfillable field at once, not the first', async () => {
    const rerun = buildRouter();
    await dispatch(
      rerun,
      runRequest({
        // The required port dropped and a retired one supplied — the two halves
        // of a stale composition, which arrive together or the operator fixes
        // one and meets the other.
        inputs: [{ portId: 'legacy-notes', type: 'text', value: 'from the run' }],
        outputs: [{ portId: 'report', target: '' }]
      }),
      'q-nightly'
    );

    expect(errorsOf(only(rerun)).map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([
        ['inputs.legacy-notes', 'unknown-input-port'],
        ['inputs.brief', 'missing-required-input'],
        ['outputs.report', 'output-target-missing']
      ])
    );
    expect(rerun.scheduled).toHaveLength(0);
  });

  it('refuses the same way when no queue is named', async () => {
    const launch = buildRouter();
    await dispatch(launch, staleRequest());

    expect(errorsOf(only(launch)).map((e) => [e.field, e.code])).toEqual([
      ['inputs.legacy-notes', 'unknown-input-port']
    ]);
    expect(launch.scheduled).toHaveLength(0);
  });

  it('accepts the same composition once the retired port is removed', async () => {
    // The control that makes the refusals above mean something: the request is
    // otherwise fine, so what was refused was that port and not the shape of a
    // re-run. A validator that dropped the unknown port instead of naming it
    // would make these two cases indistinguishable.
    const rerun = buildRouter();
    await dispatch(rerun, runRequest(), 'q-nightly');

    expect(only(rerun)).toMatchObject({ outcome: 'enqueued' });
    const plan = rerun.scheduled[0].runPlan as FrozenRunPlan;
    expect(plan.inputs.map((input) => input.portId)).toEqual(['brief']);
  });
});
