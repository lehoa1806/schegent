// Feature 087 (T015, US2) — the contract-input half of request validation.
//
// FR-010 (required), FR-011 (structural type match, no coercion), FR-001a
// (a port an earlier Phase feeds is not the operator's to supply), FR-012 (the
// instruction bound), and FR-013 (every failing field in one response).
//
// The accumulation rule is the one worth a test of its own: a validator that
// returns at the first bad field makes the operator fix a request one round
// trip at a time, and the failure is invisible until a request has two faults.

import { describe, expect, it } from 'vitest';
import type { PipelineInputPort, PipelineOutputPort } from '../../../../src/contracts/pipeline-definitions';
import type { RunRequest } from '../../../../src/contracts/run-request';
import { MAX_DESCRIPTION_LENGTH } from '../../../../src/queue/feature-request';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../../src/config/pipeline-snapshot';
import {
  validateRunRequest,
  type EffectivePipelineSource,
  type RunRequestValidationContext
} from '../../../../src/services/run-request/run-request-validator';

const WORKSPACE_ROOT = '/workspace';

// The effective-catalog rows, not a snapshot: expanding them into the durable
// snapshot is what validation does (T039, FR-030).
function pipeline(
  inputs: readonly PipelineInputPort[],
  outputs: readonly PipelineOutputPort[] = []
): EffectivePipelineSource {
  return {
    definition: { id: 'ab-flow', name: 'A then B', phases: ['alpha'], inputs, outputs },
    phases: [{ id: 'alpha', name: 'Alpha', instruction: 'Do the thing.', sourceScope: 'built-in' }]
  };
}

// The filesystem, existence, and prior-Run seams are injected. This suite covers
// the contract half — required/type/phase-fed/instructions — so the default ports
// accept whatever reaches them; the suites that exercise those seams (T021, T027,
// T029) inject their own and assert on the refusals.
const ACCEPTING_PORTS = {
  localInputs: {
    checkFile: async () => ({ ok: true }) as const,
    checkFolder: async () => ({ ok: true }) as const
  },
  outputProbe: { exists: async () => false },
  priorOutputs: { outputsFor: () => [] as const }
};

function context(
  overrides: Partial<RunRequestValidationContext> = {}
): RunRequestValidationContext {
  return {
    pipeline: pipeline([]),
    workspaceRoot: WORKSPACE_ROOT,
    now: 1,
    ...ACCEPTING_PORTS,
    ...overrides
  };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return { pipelineId: 'ab-flow', inputs: [], supplemental: [], outputs: [], ...overrides };
}

function codesFor(
  outcome: Awaited<ReturnType<typeof validateRunRequest>>
): ReadonlyArray<{ field: string; code: string }> {
  if (outcome.ok) return [];
  return outcome.errors.map(({ field, code }) => ({ field, code }));
}

const TEXT_PORT: PipelineInputPort = { portId: 'brief', label: 'Brief', type: 'text', required: true };
const OPTIONAL_PORT: PipelineInputPort = { portId: 'notes', label: 'Notes', type: 'text' };

describe('required input ports (FR-010)', () => {
  it('accepts a request that supplies every required port', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }] }),
      context({ pipeline: pipeline([TEXT_PORT]) })
    );
    expect(outcome.ok).toBe(true);
  });

  it('refuses a request that omits a required port', async () => {
    const outcome = await validateRunRequest(request(), context({ pipeline: pipeline([TEXT_PORT]) }));
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.brief', code: 'missing-required-input' }]);
  });

  it('treats a required port supplied as whitespace as omitted', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'brief', type: 'text', value: '   ' }] }),
      context({ pipeline: pipeline([TEXT_PORT]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.brief', code: 'missing-required-input' }]);
  });

  it('allows an optional port to be omitted, and to be supplied empty', async () => {
    const withPorts = context({ pipeline: pipeline([OPTIONAL_PORT]) });
    expect((await validateRunRequest(request(), withPorts)).ok).toBe(true);
    expect(
      (
        await validateRunRequest(
          request({ inputs: [{ portId: 'notes', type: 'text', value: '' }] }),
          withPorts
        )
      ).ok
    ).toBe(true);
  });

  it('refuses a value for a port the Pipeline does not declare', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'ghost', type: 'text', value: 'v' }] }),
      context({ pipeline: pipeline([OPTIONAL_PORT]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.ghost', code: 'unknown-input-port' }]);
  });

  it('refuses the same port supplied twice', async () => {
    const outcome = await validateRunRequest(
      request({
        inputs: [
          { portId: 'brief', type: 'text', value: 'one' },
          { portId: 'brief', type: 'text', value: 'two' }
        ]
      }),
      context({ pipeline: pipeline([TEXT_PORT]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.brief', code: 'unknown-input-port' }]);
  });
});

describe('structural type match (FR-011)', () => {
  it('refuses a value whose declared type differs from the port', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'brief', type: 'web-url', value: 'https://example.com' }] }),
      context({ pipeline: pipeline([TEXT_PORT]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.brief', code: 'type-mismatch' }]);
  });

  // "No coercion" is the point: a `local-file` port does not quietly accept a
  // string because a path happens to be one.
  it.each([
    ['local-file', 'text'],
    ['local-folder', 'text'],
    ['web-url', 'text'],
    ['source', 'source-list'],
    ['repository-context', 'source']
  ])('refuses a %s port supplied as %s', async (portType, suppliedType) => {
    const port = { portId: 'in', label: 'In', type: portType } as PipelineInputPort;
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'in', type: suppliedType, value: 'v' } as never] }),
      context({ pipeline: pipeline([port]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.in', code: 'type-mismatch' }]);
  });
});

describe('phase-fed input ports (FR-001a)', () => {
  const FED: PipelineInputPort = { portId: 'draft', label: 'Draft', type: 'pipeline-output', required: true };

  it('does not require a phase-fed port even when it is marked required', async () => {
    const outcome = await validateRunRequest(request(), context({ pipeline: pipeline([FED]) }));
    expect(outcome.ok).toBe(true);
  });

  it('refuses a value supplied for a phase-fed port', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'draft', type: 'pipeline-output', value: 'v' }] }),
      context({ pipeline: pipeline([FED]) })
    );
    expect(codesFor(outcome)).toEqual([{ field: 'inputs.draft', code: 'phase-fed-input-port' }]);
  });

  it('keeps a phase-fed port out of the frozen bindings', async () => {
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }] }),
      context({ pipeline: pipeline([TEXT_PORT, FED]) })
    );
    expect(outcome.ok && outcome.plan.inputs.map((binding) => binding.portId)).toEqual(['brief']);
  });
});

describe('free-form instructions (FR-012)', () => {
  it('accepts instructions at exactly the limit', async () => {
    const outcome = await validateRunRequest(
      request({ instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH) }),
      context()
    );
    expect(outcome.ok).toBe(true);
  });

  it('refuses instructions one character over, reporting the limit and the actual', async () => {
    const outcome = await validateRunRequest(
      request({ instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }),
      context()
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.errors[0]).toMatchObject({
      field: 'instructions',
      code: 'instructions-too-long',
      limit: MAX_DESCRIPTION_LENGTH,
      actual: MAX_DESCRIPTION_LENGTH + 1
    });
  });
});

describe('all failing fields in one response (FR-013)', () => {
  it('reports every fault rather than stopping at the first', async () => {
    const outcome = await validateRunRequest(
      request({
        inputs: [
          { portId: 'brief', type: 'web-url', value: 'https://example.com' },
          { portId: 'ghost', type: 'text', value: 'v' }
        ],
        instructions: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)
      }),
      context({ pipeline: pipeline([TEXT_PORT, { portId: 'also', label: 'Also', type: 'text', required: true }]) })
    );
    expect(codesFor(outcome)).toEqual([
      { field: 'inputs.brief', code: 'type-mismatch' },
      { field: 'inputs.ghost', code: 'unknown-input-port' },
      { field: 'inputs.also', code: 'missing-required-input' },
      { field: 'instructions', code: 'instructions-too-long' }
    ]);
  });

  it('returns rather than throws on a validation failure', async () => {
    await expect(
      validateRunRequest(request({ inputs: [{ portId: 'ghost', type: 'text', value: 'v' }] }), context())
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('the frozen plan (FR-009, FR-030)', () => {
  it('carries the pipeline snapshot, the bindings, and the freeze time', async () => {
    const source = pipeline([TEXT_PORT]);
    const outcome = await validateRunRequest(
      request({ inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }], instructions: 'go' }),
      context({ pipeline: source, now: 1_700_000_000_000 })
    );
    expect(outcome).toEqual({
      ok: true,
      plan: {
        // Produced by the same two helpers the drain path uses, so a composed Run
        // and a legacy resolve-at-drain Run snapshot the same catalog identically.
        pipeline: snapshotPipelineContract(
          source.definition,
          source.phases.map((phase) => snapshotPhaseDef(phase))
        ),
        inputs: [{ portId: 'brief', type: 'text', value: 'ship it' }],
        supplemental: [],
        outputs: [],
        instructions: 'go',
        frozenAt: 1_700_000_000_000
      }
    });
  });

  // The point of freezing *here* rather than accepting a snapshot from the
  // caller: the expansion is part of validation's output, not its input.
  it('expands the Phase definitions rather than passing the authored rows through', async () => {
    const source = pipeline([]);
    const outcome = await validateRunRequest(request(), context({ pipeline: source }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.pipeline.phases).not.toEqual(source.phases);
    expect(outcome.plan.pipeline.phases[0]).toMatchObject({ id: 'alpha', version: 1, runner: 'claude' });
  });

  it('freezes the Phase list the caller resolved, substituting nothing (FR-033)', async () => {
    // `WorkflowRunFactory.resolvePipeline()` appends `done` and substitutes it
    // for a Phase the catalog no longer has. Neither happens here: what the
    // effective catalog yielded is what freezes.
    const source: EffectivePipelineSource = {
      definition: { id: 'ab-flow', name: 'A then B', phases: ['alpha', 'gone'] },
      phases: [{ id: 'alpha', name: 'Alpha', instruction: 'Do the thing.', sourceScope: 'built-in' }]
    };
    const outcome = await validateRunRequest(request(), context({ pipeline: source }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.pipeline.phases.map((phase) => phase.id)).toEqual(['alpha']);
  });

  it('omits instructions entirely when none were supplied', async () => {
    const outcome = await validateRunRequest(request(), context());
    expect(outcome.ok && 'instructions' in outcome.plan).toBe(false);
  });
});
