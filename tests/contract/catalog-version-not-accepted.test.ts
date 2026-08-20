// Feature 102 (T032, US4 — FR-023, FR-024) — a submission that names its own
// catalog version is refused at the boundary, and nothing is planned for it.
//
// The record of which published version a run froze is resolved host-side
// (FR-022). The submission shape therefore has no field for it (FR-024), and a
// payload that carries one did not come from this product's surface. FR-023
// says such a payload is *refused*, not stripped: a dropped key is a forged
// provenance attempt that leaves no trace, and the run it rides on would still
// be planned — with a version the host resolved, so the tampering would succeed
// at nothing and be visible nowhere. The precedent is
// `isCmdPreflightProcessYaml`, which rejects a payload for carrying a key
// rather than ignoring the key.
//
// The refusal is over the **key**, not the value, which is why every case below
// is asserted twice: once with a well-formed version reference and once with a
// bare string. A check that inspected the value would admit the second, and the
// shape declares no field either way.
//
// Two boundaries answer, and both are asserted, because either alone leaves a
// live path:
//
//   * the `validate*` family in `src/contracts/validators/`, which is what
//     `validateInboundMessage` runs and what the view provider actually calls;
//   * the `is*Payload` guard family registered in `COMMAND_GUARDS`, which is the
//     contract's own statement of what the wire type admits. A guard that said
//     yes to a payload the validator refuses is a contradiction one edit away
//     from being believed.
//
// Scope, stated rather than implied: the matrix covers every nesting **the
// payload shape allows** — the payload object, the nested request, and each
// element type inside its three collections. Envelope depth is a different
// claim and is asserted separately at the end: the validators rebuild the
// command from allowlisted fields, so a key beside `type` and `correlationId`
// cannot reach a handler. That is strip-not-refuse, and it is enough there
// precisely because the handler reads `payload` and nothing else.

import { describe, expect, it, vi } from 'vitest';

// A root specific to this suite: request validation `lstat`s a resolved output
// target, so a root another suite might write into would make the accepted
// control flaky. Nothing here creates it — a target that does not exist is the
// ordinary "no overwrite" case.
const WORKSPACE_ROOT = '/tmp/schegent-catalog-version-contract';

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/schegent-catalog-version-contract', scheme: 'file' },
    name: 'ws',
    index: 0
  })
}));

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import {
  CMD_CONTINUE_WORKFLOW,
  CMD_LAUNCH_PIPELINE,
  CMD_LAUNCH_WORKFLOW,
  COMMAND_GUARDS
} from '../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import type {
  GuardedScheduleRequest,
  GuardedScheduleResult
} from '../../src/services/guarded-run-service';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

// ---------------------------------------------------------------------------
// The poisoned matrix.
// ---------------------------------------------------------------------------

/** What a host-resolved record looks like, so the forgery is a credible one. */
const VERSION_REF = { kind: 'pipeline', id: 'ab-flow', versionId: 'v4' };

/** The same key with a value of an entirely different shape. */
const VERSION_STRING = 'v4';

const VERSIONS: readonly (readonly [string, unknown])[] = [
  ['a version reference', VERSION_REF],
  ['a bare version string', VERSION_STRING]
];

// Untyped on purpose: every case here is a key the wire type does not declare,
// which no `Partial<RunRequest>` can express.
function runRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pipelineId: 'ab-flow',
    inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
    supplemental: [{ kind: 'text', text: 'extra context' }],
    outputs: [{ portId: 'report', target: 'out/report.md' }],
    ...overrides
  };
}

interface Nesting {
  readonly where: string;
  readonly request: Record<string, unknown>;
}

/**
 * Every place inside a `RunRequest` where an object appears, each carrying the
 * key once.
 *
 * `prior-output` is listed separately from the other supplemental kinds because
 * it is the only one with a nested object of its own, and a reference is the
 * most plausible place for a version to look like it belongs.
 */
function requestNestings(version: unknown): readonly Nesting[] {
  return [
    { where: 'request', request: runRequest({ catalogVersion: version }) },
    {
      where: 'request.inputs[0]',
      request: runRequest({
        inputs: [{ portId: 'brief', type: 'text', value: 'ship it', catalogVersion: version }]
      })
    },
    {
      where: 'request.supplemental[0]',
      request: runRequest({
        supplemental: [{ kind: 'text', text: 'extra context', catalogVersion: version }]
      })
    },
    {
      where: 'request.supplemental[0].reference',
      request: runRequest({
        supplemental: [
          {
            kind: 'prior-output',
            reference: { sourceRunId: 'run-1', outputName: 'report', catalogVersion: version }
          }
        ]
      })
    },
    {
      where: 'request.outputs[0]',
      request: runRequest({
        outputs: [{ portId: 'report', target: 'out/report.md', catalogVersion: version }]
      })
    }
  ];
}

/** The clean counterparts, so a green matrix is not a matrix of malformed inputs. */
const CLEAN_REQUESTS: readonly Record<string, unknown>[] = [
  runRequest(),
  runRequest({
    supplemental: [
      { kind: 'prior-output', reference: { sourceRunId: 'run-1', outputName: 'report' } }
    ]
  })
];

function launchPipeline(payload: unknown): unknown {
  return { type: CMD_LAUNCH_PIPELINE, correlationId: 'cv-1', payload };
}

function launchWorkflow(payload: unknown): unknown {
  return { type: CMD_LAUNCH_WORKFLOW, correlationId: 'cv-1', payload };
}

function continueWorkflow(payload: unknown): unknown {
  return { type: CMD_CONTINUE_WORKFLOW, correlationId: 'cv-1', payload };
}

/**
 * The three commands that freeze a plan, each with its payload builder.
 *
 * `CMD_CONTINUE_WORKFLOW` is here because a member run freezes a plan of its
 * own and records its own version (FR-026). A boundary that refused a forged
 * version only on the two starting commands would leave the third open, and it
 * is the one an attacker reaches after a run already exists.
 */
const COMMANDS = [
  {
    name: 'CMD_LAUNCH_PIPELINE',
    type: CMD_LAUNCH_PIPELINE,
    envelope: launchPipeline,
    payload: (request: unknown) => ({ request })
  },
  {
    name: 'CMD_LAUNCH_WORKFLOW',
    type: CMD_LAUNCH_WORKFLOW,
    envelope: launchWorkflow,
    payload: (request: unknown) => ({
      workflowId: 'ab-workflow',
      startNodeId: 'first',
      request
    })
  },
  {
    name: 'CMD_CONTINUE_WORKFLOW',
    type: CMD_CONTINUE_WORKFLOW,
    envelope: continueWorkflow,
    payload: (request: unknown) => ({
      connectedRunId: 'run-1',
      expectedRevision: 3,
      nodeId: 'second',
      request
    })
  }
] as const;

// ---------------------------------------------------------------------------
// The transport boundary.
// ---------------------------------------------------------------------------

describe('the ingress validators refuse a submitted version (FR-023)', () => {
  for (const command of COMMANDS) {
    for (const [label, version] of VERSIONS) {
      it(`${command.name} refuses ${label} on the payload`, () => {
        const payload = { ...command.payload(runRequest()), catalogVersion: version };
        expect(validateInboundMessage(command.envelope(payload))).toMatchObject({
          ok: false,
          reason: 'invalid-payload'
        });
      });

      for (const { where, request } of requestNestings(version)) {
        it(`${command.name} refuses ${label} on ${where}`, () => {
          expect(
            validateInboundMessage(command.envelope(command.payload(request)))
          ).toMatchObject({ ok: false, reason: 'invalid-payload' });
        });
      }
    }

    it(`${command.name} accepts the same submission without it`, () => {
      for (const request of CLEAN_REQUESTS) {
        expect(
          validateInboundMessage(command.envelope(command.payload(request))),
          `${command.name} must accept a clean submission or the matrix proves nothing`
        ).toMatchObject({ ok: true });
      }
    });
  }
});

describe('the command guards refuse it too (FR-023)', () => {
  for (const command of COMMANDS) {
    for (const [label, version] of VERSIONS) {
      it(`${command.name} rejects ${label} on the payload`, () => {
        const payload = { ...command.payload(runRequest()), catalogVersion: version };
        expect(COMMAND_GUARDS[command.type](command.envelope(payload))).toBe(false);
      });

      for (const { where, request } of requestNestings(version)) {
        it(`${command.name} rejects ${label} on ${where}`, () => {
          expect(COMMAND_GUARDS[command.type](command.envelope(command.payload(request)))).toBe(
            false
          );
        });
      }
    }

    it(`${command.name} still admits the same submission without it`, () => {
      for (const request of CLEAN_REQUESTS) {
        expect(
          COMMAND_GUARDS[command.type](command.envelope(command.payload(request))),
          `${command.name}'s guard must admit a clean submission`
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Nothing is planned for a refused submission.
// ---------------------------------------------------------------------------

const ALPHA: PhaseDef = { id: 'alpha', name: 'Alpha', version: 1, instruction: 'Alpha prompt.' };
const BETA: PhaseDef = { id: 'beta', name: 'Beta', version: 1, instruction: 'Beta prompt.' };

const AB_FLOW: PipelineDef = {
  id: 'ab-flow',
  name: 'A then B',
  phases: ['alpha', 'beta'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

function catalog(): PipelineCatalog {
  return buildCatalog([ALPHA, BETA], [AB_FLOW], { claude: [], codex: [], agy: [] }, 'ab-flow');
}

interface Harness {
  readonly router: MessageRouter;
  readonly acks: CommandAckMessage[];
  readonly scheduled: GuardedScheduleRequest[];
}

function buildRouter(): Harness {
  const acks: CommandAckMessage[] = [];
  const scheduled: GuardedScheduleRequest[] = [];
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
    guardedRun: {
      scheduleOrEnqueue: async (request: GuardedScheduleRequest): Promise<GuardedScheduleResult> => {
        scheduled.push(request);
        return { outcome: 'enqueued', queueItemId: 'queue-item-1' };
      }
    }
  } as unknown as RouterDeps;

  return { router: new MessageRouter(deps), acks, scheduled };
}

/**
 * What `SidebarViewProvider.handleInbound` does, and nothing more: validate,
 * drop on failure, dispatch otherwise.
 *
 * Reproduced rather than imported because the provider needs a live webview.
 * The ordering is the point — a payload refused here reaches no handler, which
 * is what "no plan exists afterwards" means at this layer.
 */
async function submit(
  raw: unknown,
  dispatch: (command: SidebarCommand) => Promise<void>
): Promise<'dropped' | 'dispatched'> {
  const result = validateInboundMessage(raw);
  if (!result.ok) return 'dropped';
  await dispatch(result.command);
  return 'dispatched';
}

describe('no plan is frozen for a refused submission (FR-023)', () => {
  function through(harness: Harness) {
    return async (command: SidebarCommand) => {
      await harness.router.dispatch(command, async (msg) => {
        harness.acks.push(msg);
        return true;
      });
    };
  }

  it('plans the clean submission, so the assertions below are about the key', async () => {
    const harness = buildRouter();

    const outcome = await submit(launchPipeline({ request: runRequest() }), through(harness));

    expect(outcome).toBe('dispatched');
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.acks[0]).toMatchObject({ status: 'accepted' });
  });

  for (const [label, version] of VERSIONS) {
    it(`freezes nothing when the payload carries ${label}`, async () => {
      const harness = buildRouter();

      const outcome = await submit(
        launchPipeline({ request: runRequest(), catalogVersion: version }),
        through(harness)
      );

      expect(outcome).toBe('dropped');
      expect(harness.scheduled).toEqual([]);
      expect(harness.acks).toEqual([]);
    });

    for (const { where, request } of requestNestings(version)) {
      it(`freezes nothing when ${where} carries ${label}`, async () => {
        const harness = buildRouter();

        const outcome = await submit(launchPipeline({ request }), through(harness));

        expect(outcome).toBe('dropped');
        expect(harness.scheduled).toEqual([]);
        expect(harness.acks).toEqual([]);
      });
    }
  }

  // The two connected-run commands reach a handler this suite does not stand
  // up. The claim for them is the one the boundary can make on its own and the
  // only one that matters: the command never arrives, so no handler of any kind
  // runs, so nothing is frozen.
  for (const command of COMMANDS.filter((entry) => entry.type !== CMD_LAUNCH_PIPELINE)) {
    it(`${command.name} never reaches a dispatcher`, async () => {
      const dispatched: SidebarCommand[] = [];
      const record = async (value: SidebarCommand) => {
        dispatched.push(value);
      };

      const clean = await submit(
        command.envelope(command.payload(runRequest())),
        record
      );
      expect(clean, 'the clean control must arrive, or the drop below proves nothing').toBe(
        'dispatched'
      );

      for (const [, version] of VERSIONS) {
        const payload = { ...command.payload(runRequest()), catalogVersion: version };
        expect(await submit(command.envelope(payload), record)).toBe('dropped');
        for (const { request } of requestNestings(version)) {
          expect(await submit(command.envelope(command.payload(request)), record)).toBe('dropped');
        }
      }

      expect(dispatched).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Envelope depth.
// ---------------------------------------------------------------------------

/** Every key name anywhere in a value, however deeply nested. */
function keysDeep(value: unknown, found: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    found.push(key);
    keysDeep(nested, found);
  }
  return found;
}

describe('a version beside the discriminator reaches no handler (FR-024)', () => {
  // Not a refusal: `validateInboundMessage` checks `type` and `correlationId`
  // and hands the rest to the command's validator, which rebuilds the command
  // from named fields. Widening that to refuse any undeclared envelope key
  // would be a change to all fifty-odd commands, and the guarantee this layer
  // needs is narrower — the value cannot reach the freeze.
  for (const [label, version] of VERSIONS) {
    it(`drops ${label} carried beside type and correlationId`, () => {
      const result = validateInboundMessage({
        type: CMD_LAUNCH_PIPELINE,
        correlationId: 'cv-1',
        payload: { request: runRequest() },
        catalogVersion: version
      });

      expect(result.ok).toBe(true);
      const command = (result as { command: SidebarCommand }).command;
      expect(keysDeep(command)).not.toContain('catalogVersion');
    });
  }

  it('finds the key when it is there, so the scan is not blind', () => {
    // The same walk over a value that does carry it, at the depth the matrix
    // above uses. A `keysDeep` that returned nothing would pass every case.
    expect(keysDeep({ payload: { request: runRequest({ catalogVersion: VERSION_REF }) } })).toContain(
      'catalogVersion'
    );
    expect(keysDeep({ a: [{ b: { catalogVersion: 'v4' } }] })).toContain('catalogVersion');
  });

  it('names no absolute path in what the accepted command carries', () => {
    const result = validateInboundMessage(launchPipeline({ request: runRequest() }));

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(WORKSPACE_ROOT);
  });
});
