// Feature 087 (T010, T047) — IPC contract tests for CMD_LAUNCH_PIPELINE.
//
// Covers the ordered gate table in
// `specs/087-pipeline-run-composition/contracts/run-launcher-ipc.md`:
//   gate 1  envelope shape             dropped
//   gate 2  ingress validator          `invalid-payload`, dropped at the boundary
//   gate 3  trust                      refused — untrusted workspace
//   gate 4  primary instance           refused — secondary window
//   gate 5  definition resolution      `rejected-definition`
//   gate 6  request validation         `rejected-validation` (every field at once)
//   gate 7  queue guards               `rejected-queue`
//   gate 8  enqueue                    `enqueued`
//
// Gates 1 and 2 are asserted against `validateInboundMessage` **directly**,
// because a payload that fails there never reaches the router — which is exactly
// how bulk-0 ledger entry B0-P01 stayed invisible: feature 085's handler and
// emitter were both correct, and the envelope was dropped one layer earlier by
// an ingress validator nobody had a test pointed at.
//
// What gate 2 is NOT: field-level validation. An unknown port, a missing
// required input, an over-long instruction — all of those must reach gate 6 so
// FR-013 can report every failing field in one response. A payload that is
// structurally a `RunRequest` passes gate 2 even when every value in it is wrong.
//
// Gates 3-8 go through a real `MessageRouter.dispatch`, so their ORDER is
// exercised and not just each gate in isolation. That ordering is the contract,
// not an implementation detail: each pair below is asserted with both gates
// failing at once, because a case where only one gate can fail cannot tell which
// one answered.
//
//   3 before 4  an untrusted workspace cannot probe primary status
//   5 before 6  a missing Pipeline is not reported as N bad fields
//   6 before 7  a paused queue does not mask a typo the operator must fix

import { describe, expect, it, vi } from 'vitest';

// `null` is "no folder open" — the gate-5 `no-workspace-root` case. The root is
// deliberately specific to this suite: the handler's output probe really does
// `lstat` the resolved target, so sharing a root another suite might write into
// would make the overwrite gate non-deterministic.
const WORKSPACE_ROOT = '/tmp/schegent-launch-pipeline-contract';

const mocks = vi.hoisted(() => ({
  workspaceRoot: '/tmp/schegent-launch-pipeline-contract' as string | null
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
import { CMD_LAUNCH_PIPELINE } from '../../src/contracts/sidebar-ipc';
import type { LaunchPipelineResult } from '../../src/contracts/sidebar-ipc/run-launcher';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { MAX_DESCRIPTION_LENGTH } from '../../src/queue/feature-request';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../src/services/guarded-run-service';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../src/ui/sidebar/commands/constants';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

// Overrides are deliberately untyped: several cases assert that a key the wire
// type does not declare is refused, which a `Partial<RunRequest>` could not express.
function runRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    pipelineId: 'ab-flow',
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [{ kind: 'text', text: 'extra context' }],
    outputs: [{ portId: 'report', target: 'out/report.md' }],
    ...overrides
  };
}

function envelope(request: unknown): unknown {
  return { type: CMD_LAUNCH_PIPELINE, correlationId: 'launch-1', payload: { request } };
}

describe('gate 1 — envelope shape', () => {
  it.each([[null], [42], ['a string']])('drops a non-envelope %p', (raw) => {
    expect(validateInboundMessage(raw)).toMatchObject({ ok: false });
  });

  it('drops an envelope with no command type', () => {
    expect(validateInboundMessage({ correlationId: 'launch-1', payload: {} })).toMatchObject({
      ok: false,
      reason: 'missing-or-non-string-type'
    });
  });

  it.each([[''], [undefined], [7]])('drops a malformed correlationId %p', (correlationId) => {
    expect(
      validateInboundMessage({
        type: CMD_LAUNCH_PIPELINE,
        correlationId,
        payload: { request: runRequest() }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-correlationId' });
  });

  it('drops an unregistered command type', () => {
    expect(
      validateInboundMessage({ type: 'schegent.notACommand', correlationId: 'launch-1' })
    ).toMatchObject({ ok: false, reason: 'unknown-type' });
  });
});

describe('gate 2 — envelope validation at the transport boundary', () => {
  it('accepts a well-formed run request', () => {
    const valid = envelope(runRequest());
    expect(validateInboundMessage(valid)).toMatchObject({ ok: true, command: valid });
  });

  it('accepts the optional instructions field', () => {
    expect(
      validateInboundMessage(envelope(runRequest({ instructions: 'prefer small commits' })))
    ).toMatchObject({ ok: true });
  });

  it('accepts a request with every collection empty', () => {
    expect(
      validateInboundMessage(
        envelope({ pipelineId: 'ab-flow', inputs: [], supplemental: [], outputs: [] })
      )
    ).toMatchObject({ ok: true });
  });

  it('rejects a missing payload', () => {
    expect(
      validateInboundMessage({ type: CMD_LAUNCH_PIPELINE, correlationId: 'launch-1' })
    ).toMatchObject({ ok: false, reason: 'missing-payload' });
  });

  it('rejects a payload that is not wrapped in `request`', () => {
    expect(
      validateInboundMessage({
        type: CMD_LAUNCH_PIPELINE,
        correlationId: 'launch-1',
        payload: runRequest()
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each(['pipelineId', 'inputs', 'supplemental', 'outputs'])(
    'rejects a request missing %s',
    (key) => {
      const request = runRequest() as Record<string, unknown>;
      delete request[key];
      expect(validateInboundMessage(envelope(request))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it('rejects undeclared request keys', () => {
    expect(
      validateInboundMessage(envelope(runRequest({ runId: 'not-the-webviews-to-assign' })))
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('rejects undeclared payload keys alongside `request`', () => {
    expect(
      validateInboundMessage({
        type: CMD_LAUNCH_PIPELINE,
        correlationId: 'launch-1',
        payload: { request: runRequest(), queueId: 'not-the-webviews-to-choose' }
      })
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each([[''], [null], [42], ['x'.repeat(65)]])(
    'rejects a malformed pipelineId %p',
    (pipelineId) => {
      expect(validateInboundMessage(envelope(runRequest({ pipelineId })))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it.each([['inputs'], ['supplemental'], ['outputs']])(
    'rejects a non-array %s',
    (key) => {
      expect(validateInboundMessage(envelope(runRequest({ [key]: {} })))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    }
  );

  it.each([
    { portId: '', type: 'text', value: 'v' },
    { portId: 'brief', type: 'not-a-port-type', value: 'v' },
    { portId: 'brief', type: 'text', value: 7 },
    { portId: 'brief', type: 'text' },
    { portId: 'brief', type: 'text', value: 'v', extra: true }
  ])('rejects a malformed input value %o', (input) => {
    expect(validateInboundMessage(envelope(runRequest({ inputs: [input] })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  it.each([
    { kind: 'unknown-kind', text: 'x' },
    { kind: 'local-file' },
    { kind: 'local-file', path: '' },
    { kind: 'local-file', path: 'a.md', url: 'https://example.com' },
    { kind: 'url', url: '' },
    { kind: 'text', text: 7 },
    { kind: 'prior-output', reference: { sourceRunId: 'r1' } },
    { kind: 'prior-output', reference: { sourceRunId: 'r1', outputName: '' } },
    { kind: 'prior-output', reference: 'run-1/report' }
  ])('rejects a malformed supplemental input %o', (supplemental) => {
    expect(
      validateInboundMessage(envelope(runRequest({ supplemental: [supplemental] })))
    ).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it.each([
    { kind: 'local-file', path: 'notes/brief.md' },
    { kind: 'local-folder', path: 'notes' },
    { kind: 'url', url: 'https://example.com/spec' },
    { kind: 'text', text: '' },
    { kind: 'instruction', text: 'keep the diff small' },
    { kind: 'prior-output', reference: { sourceRunId: 'run-1', outputName: 'report' } }
  ])('accepts a well-formed supplemental input %o', (supplemental) => {
    expect(
      validateInboundMessage(envelope(runRequest({ supplemental: [supplemental] })))
    ).toMatchObject({ ok: true });
  });

  it.each([
    { portId: '', target: 'out.md' },
    { portId: 'report', target: 7 },
    { portId: 'report' },
    { portId: 'report', target: 'out.md', overwriteConfirmed: 'yes' },
    { portId: 'report', target: 'out.md', force: true }
  ])('rejects a malformed output target %o', (output) => {
    expect(validateInboundMessage(envelope(runRequest({ outputs: [output] })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  it('rejects non-string instructions', () => {
    expect(validateInboundMessage(envelope(runRequest({ instructions: 7 })))).toMatchObject({
      ok: false,
      reason: 'invalid-payload'
    });
  });

  // FR-012 wants the limit AND the actual length reported, and FR-013 wants
  // every failing field in one response. A transport-level length cap would
  // drop the message instead of reporting it, so the bound lives at gate 6.
  it('lets an over-long instruction through to field validation', () => {
    expect(
      validateInboundMessage(envelope(runRequest({ instructions: 'x'.repeat(32_001) })))
    ).toMatchObject({ ok: true });
  });

  // Same reason, for the field errors an operator is far likelier to hit: a
  // request whose every value is wrong is still structurally a request.
  it('lets an unknown port and a missing target through to field validation', () => {
    expect(
      validateInboundMessage(
        envelope(
          runRequest({
            inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }],
            outputs: [{ portId: 'report', target: '' }]
          })
        )
      )
    ).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Gates 3-8, through a real router.
// ---------------------------------------------------------------------------

const ALPHA: PhaseDef = {
  id: 'alpha',
  name: 'Alpha',
  version: 1,
  instruction: 'Alpha prompt.',
  sourceScope: 'workspace'
};
const BETA: PhaseDef = {
  id: 'beta',
  name: 'Beta',
  version: 1,
  instruction: 'Beta prompt.',
  sourceScope: 'workspace'
};

const AB_FLOW: PipelineDef = {
  id: 'ab-flow',
  name: 'A then B',
  phases: ['alpha', 'beta'],
  sourceScope: 'workspace',
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'text' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

/** A Pipeline naming a Phase the catalog does not hold — gate 5's `pipeline-invalid`. */
const BROKEN_FLOW: PipelineDef = {
  id: 'broken-flow',
  name: 'Broken',
  phases: ['alpha', 'ghost'],
  sourceScope: 'workspace',
  inputs: [],
  outputs: []
};

function catalog(): PipelineCatalog {
  return buildCatalog(
    [ALPHA, BETA],
    [AB_FLOW, BROKEN_FLOW],
    { claude: [], codex: [], agy: [] },
    'ab-flow'
  );
}

interface Harness {
  readonly router: MessageRouter;
  readonly acks: CommandAckMessage[];
  readonly scheduled: GuardedScheduleRequest[];
  readonly reads: { catalog: number };
  readonly warnings: string[];
}

function buildRouter(
  opts: {
    isTrusted?: boolean;
    isPrimary?: boolean;
    omitCatalog?: boolean;
    omitGuardedRun?: boolean;
    scheduleResult?: GuardedScheduleResult;
    scheduleThrows?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const scheduled: GuardedScheduleRequest[] = [];
  const reads = { catalog: 0 };
  const warnings: string[] = [];
  const resolved = catalog();

  const guardedRun = {
    scheduleOrEnqueue: async (request: GuardedScheduleRequest): Promise<GuardedScheduleResult> => {
      scheduled.push(request);
      if (opts.scheduleThrows) throw new Error('enqueue exploded: SECRET');
      return opts.scheduleResult ?? { outcome: 'enqueued', queueItemId: 'queue-item-1' };
    }
  };

  const deps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    isPrimary: () => opts.isPrimary ?? true,
    isTrusted: () => opts.isTrusted ?? true,
    notifyWarning: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: (message: string) => {
        warnings.push(message);
      },
      error: vi.fn(),
      debug: vi.fn(),
      // Marker-based sanitizer: any host->UI string that reaches an ack must
      // have passed through this exactly once.
      sanitize: (value: string) => value.replaceAll('SECRET', '[redacted]')
    },
    // `codex` is chosen deliberately: it is not `DEFAULT_BACKEND`, so a frozen
    // Phase carrying it proves the host's configured backend reached the
    // snapshot rather than the fallback (FR-037).
    defaultRunnerKind: 'codex',
    ...(opts.omitCatalog
      ? {}
      : {
          getCatalog: () => {
            reads.catalog += 1;
            return resolved;
          }
        }),
    ...(opts.omitGuardedRun ? {} : { guardedRun })
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, scheduled, reads, warnings };
}

async function dispatch(
  harness: Harness,
  request: unknown,
  correlationId = 'launch-1'
): Promise<void> {
  await harness.router.dispatch(
    { type: CMD_LAUNCH_PIPELINE, correlationId, payload: { request } } as unknown as SidebarCommand,
    async (msg) => {
      harness.acks.push(msg);
      return true;
    }
  );
}

/** The single ack a dispatch produced, with its `result` narrowed to the wire union. */
function only(harness: Harness): {
  readonly ack: CommandAckMessage;
  readonly result: LaunchPipelineResult;
} {
  expect(harness.acks).toHaveLength(1);
  const ack = harness.acks[0] as CommandAckMessage;
  return { ack, result: (ack as { result?: unknown }).result as LaunchPipelineResult };
}

function errorsOf(
  result: LaunchPipelineResult
): readonly { field: string; code: string; limit?: number; actual?: number }[] {
  expect(result.outcome).toBe('rejected-validation');
  return (result as Extract<LaunchPipelineResult, { outcome: 'rejected-validation' }>).errors;
}

describe('gate 3 — workspace trust', () => {
  it('refuses an untrusted workspace', async () => {
    const harness = buildRouter({ isTrusted: false });

    await dispatch(harness, runRequest());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: UNTRUSTED_REJECT });
  });

  it('reads neither the catalog nor the queue when trust fails', async () => {
    const harness = buildRouter({ isTrusted: false });

    await dispatch(harness, runRequest());

    expect(harness.reads.catalog).toBe(0);
    expect(harness.scheduled).toEqual([]);
  });

  // Ordering, asserted with both gates failing: an untrusted workspace must not
  // be able to tell primary from secondary, or it has a probe.
  it('answers trust before primary when both fail', async () => {
    const harness = buildRouter({ isTrusted: false, isPrimary: false });

    await dispatch(harness, runRequest());

    expect(only(harness).ack.reason).toBe(UNTRUSTED_REJECT);
  });
});

describe('gate 4 — primary instance', () => {
  it('refuses a secondary window', async () => {
    const harness = buildRouter({ isPrimary: false });

    await dispatch(harness, runRequest());

    expect(only(harness).ack).toMatchObject({ status: 'rejected', reason: SECONDARY_REJECT });
  });

  it('reads neither the catalog nor the queue when the primary gate fails', async () => {
    const harness = buildRouter({ isPrimary: false });

    await dispatch(harness, runRequest());

    expect(harness.reads.catalog).toBe(0);
    expect(harness.scheduled).toEqual([]);
  });
});

describe('gate 5 — definition resolution', () => {
  it('reports an unknown Pipeline as pipeline-not-found', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest({ pipelineId: 'no-such-pipeline' }));

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'pipeline-not-found'
    });
  });

  it('reports a host with no catalog as pipeline-not-found', async () => {
    const harness = buildRouter({ omitCatalog: true });

    await dispatch(harness, runRequest());

    expect(only(harness).result).toMatchObject({ reason: 'pipeline-not-found' });
  });

  // FR-033. `WorkflowRunFactory.resolvePipeline()` used to drop a Phase the
  // catalog lost; a composed run refuses instead, because a shorter sequence than
  // the one the operator read is not the run they submitted. Feature 098 (T025)
  // made the resolver refuse as well, so the two paths agree now.
  it('refuses a Pipeline whose Phase the catalog no longer holds', async () => {
    const harness = buildRouter();

    await dispatch(harness, {
      pipelineId: 'broken-flow',
      inputs: [],
      supplemental: [],
      outputs: []
    });

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'pipeline-invalid'
    });
    expect(harness.scheduled).toEqual([]);
  });

  it('refuses once with no workspace root rather than per path-bearing field', async () => {
    const harness = buildRouter();
    mocks.workspaceRoot = null;
    try {
      await dispatch(harness, runRequest());
    } finally {
      mocks.workspaceRoot = WORKSPACE_ROOT;
    }

    expect(only(harness).result).toEqual({
      outcome: 'rejected-definition',
      reason: 'no-workspace-root'
    });
  });

  // Ordering, with both gates failing: a missing Pipeline reported as a list of
  // bad fields would send the operator to fix the composer, not the catalog.
  it('answers definition before field validation when both fail', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      runRequest({
        pipelineId: 'no-such-pipeline',
        inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }],
        outputs: []
      })
    );

    expect(only(harness).result.outcome).toBe('rejected-definition');
  });
});

describe('gate 6 — request validation', () => {
  // FR-013: one response carries every failing field. The alternative is an
  // operator fixing a composed request one round trip at a time.
  it('reports every failing field in one response', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      runRequest({
        // `brief` is required and unsupplied; `no-such-port` is undeclared.
        inputs: [{ portId: 'no-such-port', type: 'text', value: 'v' }],
        supplemental: [{ kind: 'url', url: 'file:///etc/passwd' }],
        // `nope` is undeclared; `report` is declared and left untargeted.
        outputs: [{ portId: 'nope', target: 'out/x.md' }],
        instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)
      })
    );

    expect(errorsOf(only(harness).result).map((e) => [e.field, e.code])).toEqual(
      expect.arrayContaining([
        ['inputs.no-such-port', 'unknown-input-port'],
        ['inputs.brief', 'missing-required-input'],
        ['supplemental[0]', 'url-scheme-not-allowed'],
        ['outputs.nope', 'unknown-output-port'],
        ['outputs.report', 'output-target-missing'],
        ['instructions', 'instructions-too-long']
      ])
    );
  });

  // FR-012 — a bound is only actionable when the operator can see how far over
  // they are, so a length error carries `limit` and `actual`.
  it('carries the limit and the actual length on a bounded field', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest({ instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 5) }));

    expect(errorsOf(only(harness).result)).toContainEqual(
      expect.objectContaining({
        field: 'instructions',
        code: 'instructions-too-long',
        limit: MAX_DESCRIPTION_LENGTH,
        actual: MAX_DESCRIPTION_LENGTH + 5
      })
    );
  });

  // FR-020 — no refusal names a location. The resolved absolute path exists only
  // long enough to decide containment, and is never what the composer is told.
  it('names no absolute path in a refusal', async () => {
    const harness = buildRouter();

    await dispatch(
      harness,
      runRequest({ outputs: [{ portId: 'report', target: '../outside-the-workspace.md' }] })
    );

    const { ack, result } = only(harness);
    expect(errorsOf(result)).toContainEqual(
      expect.objectContaining({ field: 'outputs.report', code: 'path-escapes-workspace' })
    );
    expect(JSON.stringify(ack)).not.toContain(WORKSPACE_ROOT);
  });

  // Ordering, with both gates failing: a paused queue answered first would send
  // the operator away to wait, and the typo would still be there when they came
  // back.
  it('answers field validation before the queue when both would refuse', async () => {
    const harness = buildRouter({
      scheduleResult: { outcome: 'rejected-paused', reason: 'queue-paused' }
    });

    await dispatch(harness, runRequest({ inputs: [], outputs: [] }));

    expect(only(harness).result.outcome).toBe('rejected-validation');
    expect(harness.scheduled).toEqual([]);
  });
});

describe('gate 7 — queue guards', () => {
  it.each([
    { outcome: 'rejected-paused', reason: 'queue-paused' },
    { outcome: 'rejected-foreign-lock', reason: 'foreign-lock' },
    { outcome: 'rejected-validation', reason: 'description-empty' },
    { outcome: 'rejected-horizon-exceeded', reason: 'horizon-exceeded' }
  ] as GuardedScheduleResult[])('reports %o as one refusal family', async (scheduleResult) => {
    const harness = buildRouter({ scheduleResult });

    await dispatch(harness, runRequest());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: scheduleResult.reason
    });
  });

  it('refuses when the host wired no launcher at all', async () => {
    const harness = buildRouter({ omitGuardedRun: true });

    await dispatch(harness, runRequest());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    // Refused before the catalog is read: with nowhere to submit, there is
    // nothing worth resolving.
    expect(harness.reads.catalog).toBe(0);
  });

  it('turns an unexpected enqueue failure into a refusal, not an unhandled rejection', async () => {
    const harness = buildRouter({ scheduleThrows: true });

    await dispatch(harness, runRequest());

    expect(only(harness).result).toEqual({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'enqueue-failed'
    });
    // The thrown message is logged, sanitized on the way — never raw.
    expect(harness.warnings.join('\n')).toContain('[redacted]');
    expect(harness.warnings.join('\n')).not.toContain('SECRET');
  });

  it('sanitizes and bounds a guard reason before it reaches the composer', async () => {
    const harness = buildRouter({
      scheduleResult: { outcome: 'rejected-paused', reason: `SECRET ${'y'.repeat(300)}` }
    });

    await dispatch(harness, runRequest());

    const result = only(harness).result as Extract<
      LaunchPipelineResult,
      { outcome: 'rejected-queue' }
    >;
    expect(result.detail).toHaveLength(120);
    expect(result.detail).not.toContain('SECRET');
  });

  // An `enqueued` outcome with no id is not an enqueue this handler can report:
  // there is nothing for the composer to correlate the run with.
  it('refuses an enqueued outcome that carries no queue item id', async () => {
    const harness = buildRouter({ scheduleResult: { outcome: 'enqueued' } });

    await dispatch(harness, runRequest());

    expect(only(harness).result).toMatchObject({
      outcome: 'rejected-queue',
      reason: 'queue-refused'
    });
  });
});

describe('gate 8 — enqueue', () => {
  it('accepts and returns the queue item id', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest());

    const { ack, result } = only(harness);
    expect(ack.status).toBe('accepted');
    expect(ack.reason).toBeUndefined();
    expect(result).toEqual({ outcome: 'enqueued', requestId: 'queue-item-1' });
  });

  // FR-029/FR-030: submission performs exactly one durable write, and the plan
  // it carries was frozen at validation — not resolved again later, at drain.
  it('submits exactly once, carrying the frozen plan', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest({ instructions: 'prefer small commits' }));

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]).toMatchObject({
      via: 'webview',
      pipelineId: 'ab-flow',
      description: 'prefer small commits'
    });
    expect(typeof harness.scheduled[0]?.runPlan?.frozenAt).toBe('number');
  });

  it('freezes the resolved Phase sequence with the host backend (FR-037)', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest());

    const pipeline = harness.scheduled[0]?.runPlan?.pipeline;
    expect(pipeline?.phases.map((phase) => phase.id)).toEqual(['alpha', 'beta']);
    expect(pipeline?.phases.map((phase) => phase.runner)).toEqual(['codex', 'codex']);
  });

  it('freezes the bindings the operator supplied', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest());

    expect(harness.scheduled[0]?.runPlan?.inputs).toEqual([
      { portId: 'brief', type: 'text', value: 'ship it' }
    ]);
    expect(harness.scheduled[0]?.runPlan?.outputs).toEqual([
      { portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: false }
    ]);
  });

  // The queue row is what the operator reads in the list: their own words when
  // they wrote any, otherwise the Pipeline's catalog-authored name — which is
  // always present, so the guarded service's non-empty-description gate cannot
  // be reached by an operator who simply had nothing to add.
  it('labels the queue row with the Pipeline name when no instructions were given', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest());

    expect(harness.scheduled[0]?.description).toBe('A then B');
  });

  it('labels the queue row with the Pipeline name when instructions are blank', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest({ instructions: '   ' }));

    expect(harness.scheduled[0]?.description).toBe('A then B');
  });

  // FR-020, on the success path too: an accepted launch tells the composer an
  // identifier and nothing about where anything lives.
  it('names no absolute path in the accepted ack', async () => {
    const harness = buildRouter();

    await dispatch(harness, runRequest());

    expect(JSON.stringify(only(harness).ack)).not.toContain(WORKSPACE_ROOT);
  });
});
