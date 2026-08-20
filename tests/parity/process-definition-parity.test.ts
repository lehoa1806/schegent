// Feature 089 (T031, US1, FR-001, FR-005, SC-001) — definition validation
// through both primary adapters.
//
// **The two entry points, named, because a parity suite that drives one thing
// twice proves nothing** ([plan.md D8](../../../specs/089-headless-parity-qualification/plan.md)):
//
//   1. automation — `validateProcessDefinition` from
//      `src/headless/process-definition-api.ts`
//   2. operator   — `MessageRouter.dispatch` of `CMD_SAVE_DEFINITION_DRAFT` and
//      then `CMD_PUBLISH_DEFINITION`, i.e. the real router running the real
//      lifecycle service and the real `defectsOf` gate
//
// They are compared on all three things SC-001 names: the verdict, the defect
// codes, and the defect *field addresses*. Addresses matter most — `bindings[0]
// .src.phaseIndex` versus `bindings[0].portId` is the difference between an
// automation client that can point its operator at the broken field and one that
// can only say "invalid".
//
// Both surfaces are given the same effective catalog, resolved once by the same
// `resolvePhaseCatalog` / `resolvePipelineCatalog` the sidebar itself calls. The
// headless entrypoint neither resolves nor augments a catalog (FR-001's contract
// row), so handing it the sidebar's own resolution is what makes the comparison
// about validation rather than about catalog assembly.
//
// **Two divergences this suite found, and the fix each forced.** The first pass
// was green on the six cases T031 names, which is exactly when a parity suite is
// least trustworthy, so probe rows were added until something disagreed. Two did,
// both in `src/headless/process-definition-api.ts`, and both are now permanent
// cases below:
//
//   1. the Pipeline arm ran `validatePipelineBindings` alone, where the sidebar's
//      gate 5 runs `unknownPhaseErrors` first — a Pipeline naming a Phase with no
//      effective definition read clean to automation and was refused to an operator
//   2. the Phase arm passed no validator options, where every other call site in
//      the product passes `{ allowLegacyId: true, defaultVersion: 1 }` — and the
//      Phase validator, unlike the Pipeline one, has no internal version fallback,
//      so a `version`-less Phase was accepted by the sidebar and refused headlessly
//
// The second is why both `version`-omitting rows are here and not just the Phase:
// the Pipeline row agreed throughout, which is what let the mismatched call sites
// go unnoticed. A case that passes before and after a fix is still carrying its
// weight when it marks the boundary of the one that did not.
//
// **One asymmetry is by contract, not by drift**: the Workflow arm delegates to
// `validateWorkflowGraph`, which takes an already-typed definition, so the
// headless surface runs the graph pass alone while the sidebar runs shape then
// graph. The Workflow fixtures are therefore shape-valid on both sides and the
// broken one is broken *in the graph* — which is why T031 names a connection to a
// missing node rather than, say, a missing `name`.
//
// Feature 099 (T496f, FR-042) — the parity claim is untouched by the layer
// collapse; only the way each surface is handed a catalog changed. What used to be
// "supporting rows in the user layer, saves aimed at the empty workspace layer" is
// now "supporting rows in the one catalog, and a payload that carries them across
// unchanged alongside the row under test". Both readings make the same case: every
// save is a plain `create`, so the mutation gates — which run after validation —
// stay out of a comparison that is about validation.
//
// Feature 100 (T514, FR-016, FR-019) — the operator surface is two commands now,
// and the second one is the one under test. A draft save validates nothing: the
// store takes a body verbatim (099 FR-010) and the gate that computes defects sits
// on the publish path (`lifecycle-service.ts` `publish`). So the operator arm
// authors the draft and then asks for it to be made live, which is where the verdict
// is — and the refusal is one `validation-failed` carrying every defect rather than
// three `<kind>-validation` literals carrying the first.
//
// That makes this a strictly stronger comparison than the whole-array save it
// replaces: that save reported the defects of a *payload*, and this reports the
// defects of the body the store is holding, so the two surfaces are now compared
// across a round trip through the store rather than on the same message.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  capabilities: new Map<string, boolean>()
}));

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.capabilities.get(capability) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/parity-workspace', scheme: 'file' },
    name: 'parity-workspace',
    index: 0
  })
}));

import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { FakeCatalogStore, tokenFor } from '../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../fixtures/fake-catalog-lifecycle';
import { validateProcessDefinition } from '../../src/headless/process-definition-api';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_PUBLISH_DEFINITION,
  CMD_SAVE_DEFINITION_DRAFT,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';

type Kind = 'phase' | 'pipeline' | 'workflow';
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixtures. The supporting rows are seeded into the one catalog and every save
// under test carries them across untouched, so the diff the mutation gates see is
// a single addition on every case. No fixture id collides with a supporting one,
// which is what keeps the intent a plain `create` and keeps the mutation gates —
// which run after validation — out of the comparison.
// ---------------------------------------------------------------------------

const PHASE_ROWS: readonly Row[] = [
  { id: 'parity-draft', name: 'Parity Draft', version: 1, instruction: 'Draft it.' },
  { id: 'parity-review', name: 'Parity Review', version: 1, instruction: 'Review it.' }
];

/**
 * The bridge port pair. A Phase output consumed by a later Phase needs the same
 * `portId` declared twice: as an output, and as an input typed `pipeline-output`
 * (`pipeline-binding-validator.ts`, research R4).
 */
const BRIDGE_INPUTS = [
  { portId: 'brief', label: 'Brief', type: 'text' },
  { portId: 'draft', label: 'Draft', type: 'pipeline-output' }
];
const BRIDGE_OUTPUTS = [{ portId: 'draft', label: 'Draft', type: 'markdown' }];

const PIPELINE_VALID: Row = {
  id: 'parity-pipeline',
  name: 'Parity Pipeline',
  version: 1,
  phases: ['parity-draft', 'parity-review'],
  inputs: BRIDGE_INPUTS,
  outputs: BRIDGE_OUTPUTS,
  bindings: [
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'brief',
      source: { from: 'pipeline-input', portId: 'brief' }
    },
    { kind: 'output', phaseIndex: 0, portId: 'draft', outputKey: 'draft' },
    {
      kind: 'input',
      phaseIndex: 1,
      inputKey: 'draft',
      source: { from: 'phase-output', phaseIndex: 0, portId: 'draft' }
    }
  ]
};

/**
 * T031's first named case: position 0 reads what position 1 has not produced yet.
 * One binding only, so the address the two surfaces must agree on is unambiguous.
 */
const PIPELINE_FORWARD_BINDING: Row = {
  ...PIPELINE_VALID,
  bindings: [
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'draft',
      source: { from: 'phase-output', phaseIndex: 1, portId: 'draft' }
    }
  ]
};

/** Two Pipelines with a `markdown -> text` edge between them, for the Workflow cases. */
const PIPELINE_ROWS: readonly Row[] = [
  {
    id: 'parity-source',
    name: 'Parity Source',
    version: 1,
    phases: ['parity-draft', 'parity-review'],
    outputs: [{ portId: 'notes', label: 'Notes', type: 'markdown' }]
  },
  {
    id: 'parity-target',
    name: 'Parity Target',
    version: 1,
    phases: ['parity-review'],
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }]
  }
];

const WORKFLOW_VALID: Row = {
  workflowId: 'parity-workflow',
  name: 'Parity Workflow',
  version: 1,
  nodes: [
    { nodeId: 'source', pipelineId: 'parity-source' },
    { nodeId: 'target', pipelineId: 'parity-target' }
  ],
  connections: [
    { from: { nodeId: 'source', portId: 'notes' }, to: { nodeId: 'target', portId: 'brief' } }
  ],
  startNodeIds: ['source']
};

/**
 * A third broken Pipeline, beyond the two cases T031 names. It is here because it
 * is what caught the divergence this task fixed: the sidebar's gate 5 runs
 * `unknownPhaseErrors` *and* `validatePipelineBindings`, and the headless arm ran
 * only the second, so a Pipeline naming a Phase with no effective definition was
 * clean to an automation client and refused to an operator.
 */
const PIPELINE_UNKNOWN_PHASE: Row = {
  ...PIPELINE_VALID,
  phases: ['no-such-phase', 'parity-review']
};

/** T031's second named case: the connection's source names a node the graph never declares. */
const WORKFLOW_MISSING_NODE: Row = {
  ...WORKFLOW_VALID,
  connections: [
    { from: { nodeId: 'ghost', portId: 'notes' }, to: { nodeId: 'target', portId: 'brief' } }
  ]
};

const PHASE_VALID: Row = {
  id: 'parity-publish',
  name: 'Parity Publish',
  version: 1,
  instruction: 'Publish it.'
};

/** Two defects at two addresses, so the comparison is over a set and not a single code. */
const PHASE_BROKEN: Row = {
  id: 'Parity Publish!',
  name: '',
  version: 1,
  instruction: 'Publish it.'
};

/**
 * `version` omitted, which the authored settings schema permits and every sidebar
 * call site supplies a default for. The Phase row is the one that caught the
 * second divergence: `process-definition-validator.ts` has no fallback of its own,
 * so an adapter that passed no `defaultVersion` refused what an operator can save.
 * The Pipeline row is the control — its validator does fall back internally, so it
 * agreed even while the call sites differed, which is exactly why the difference
 * could sit unnoticed.
 */
const PHASE_NO_VERSION: Row = {
  id: 'parity-publish',
  name: 'Parity Publish',
  instruction: 'Publish it.'
};
const PIPELINE_NO_VERSION: Row = (() => {
  const { version: _omitted, ...rest } = PIPELINE_VALID;
  return rest;
})();

// ---------------------------------------------------------------------------
// The catalog both surfaces validate against — resolved once, by the sidebar's
// own resolvers.
// ---------------------------------------------------------------------------

/**
 * The revision every seeded store reports. Feature 099 (FR-044a): seeding rows
 * does not move a revision, so both surfaces and every save agree on it without
 * having to compute a hash of the layer the way `*LayerRevision` once did.
 */
const SEEDED = new FakeCatalogStore();

const EFFECTIVE_PHASES = resolvePhaseCatalog({
  rows: PHASE_ROWS,
  revision: SEEDED.revisionOf('phase')
}).effective;

const PIPELINE_RESOLUTION = resolvePipelineCatalog({
  rows: PIPELINE_ROWS,
  revision: SEEDED.revisionOf('pipeline'),
  phaseCatalog: EFFECTIVE_PHASES
});

/**
 * `validateWorkflowGraph` reads a map of Pipeline id to the reason it is invalid.
 * The fixture has none, and the assertion below proves it rather than assuming
 * it — an invalid support Pipeline would make every Workflow case fail for the
 * wrong reason.
 */
const INVALID_PIPELINES = new Map<string, string>();

// ---------------------------------------------------------------------------
// The two surfaces.
// ---------------------------------------------------------------------------

/** `field|code`, the comparable address-and-kind of one defect. */
type Defect = string;

interface Verdict {
  readonly valid: boolean;
  readonly defects: readonly Defect[];
}

function sorted(defects: readonly Defect[]): readonly Defect[] {
  return [...defects].sort();
}

function headlessVerdict(kind: Kind, row: Row): Verdict {
  const verdict = validateProcessDefinition({
    kind,
    definition: kind === 'workflow' ? (row as unknown as WorkflowDefinition) : row,
    catalog: {
      phases: EFFECTIVE_PHASES,
      pipelines: PIPELINE_RESOLUTION.effective,
      invalidPipelines: INVALID_PIPELINES
    }
  });
  if (!('kind' in verdict)) {
    throw new Error(`headless surface refused the argument itself: ${JSON.stringify(verdict)}`);
  }
  const errors = verdict.kind === 'workflow' ? verdict.errors : verdict.result.errors;
  return {
    valid: errors.length === 0,
    defects: sorted(errors.map((error) => `${error.field}|${error.code}`))
  };
}

interface SidebarOutcome extends Verdict {
  /** The ack's own reason, so a refusal from some gate other than validation is visible. */
  readonly reason: string | undefined;
  /** Whether the publication made the definition live. */
  readonly active: boolean;
  /**
   * The write instructions that reached the store, in order.
   *
   * `['save-draft']` alone is what "refused before the write" looks like: the
   * publish gate computes defects and returns without touching the store, so a
   * refusal has nothing to undo (`lifecycle-service.ts` `publish`).
   */
  readonly ops: readonly string[];
}

/** The rows the catalog already holds for each kind, seeded into every harness. */
const SEED_ROWS: Record<Kind, readonly Row[]> = {
  phase: PHASE_ROWS,
  pipeline: PIPELINE_ROWS,
  workflow: []
};

/**
 * The id the store keys a definition by — the one its body authors.
 *
 * A malformed id is still the id: `PHASE_BROKEN` is stored under `Parity Publish!`,
 * which is what lets its defect be reported against the definition the operator can
 * see rather than under a synthetic name (`definition-semantics.ts` `unresolvable`).
 */
function idOf(row: Row): string {
  return (row.id ?? row.pipelineId ?? row.phaseId ?? row.workflowId) as string;
}

function harnessFor(store: FakeCatalogStore): MessageRouter {
  // The three `read*Config` seams the whole-array saves read are gone with them:
  // a lifecycle operation reads the store itself (`cmd-catalog-lifecycle.ts`
  // `currentRecord`), so a harness that still declared them would be describing a
  // dependency this path does not have.
  const deps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
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
    audit: { append: async () => undefined },
    catalogStore: store,
    catalogLifecycle: fakeCatalogLifecycle(store),
    refreshCatalog: async () => undefined
  } as unknown as RouterDeps;
  return new MessageRouter(deps);
}

async function dispatch(
  router: MessageRouter,
  command: Record<string, unknown>
): Promise<CommandAckMessage | undefined> {
  const acks: CommandAckMessage[] = [];
  await router.dispatch(command as unknown as SidebarCommand, async (message) => {
    acks.push(message);
    return true;
  });
  return acks[0];
}

async function sidebarVerdict(kind: Kind, row: Row): Promise<SidebarOutcome> {
  const store = new FakeCatalogStore({
    phases: SEED_ROWS.phase,
    pipelines: SEED_ROWS.pipeline,
    workflows: SEED_ROWS.workflow
  });
  const router = harnessFor(store);
  const id = idOf(row);
  const ops = (): readonly string[] => store.lifecycleWrites.map((write) => write.op);

  // Authoring comes first because there is nothing to publish otherwise. The
  // supporting rows are already in the store and are not re-sent: an operation
  // addresses one definition, so the only thing this command carries is the row
  // under test.
  const saved = await dispatch(router, {
    type: CMD_SAVE_DEFINITION_DRAFT,
    correlationId: `parity-${kind}-save`,
    payload: { kind, id, expectedDraftVersion: tokenFor(store, kind, id), body: row }
  });
  if (saved?.status !== 'accepted') {
    // The draft never landed, so the publish under test never ran. Reported rather
    // than thrown, so the controls below name the gate that actually refused.
    return { valid: false, defects: [], reason: saved?.reason, active: false, ops: ops() };
  }

  // Read fresh rather than carried across: the save moved this definition's draft
  // pointer, so the token the publish must present is not the one the save did
  // (FR-012).
  const published = await dispatch(router, {
    type: CMD_PUBLISH_DEFINITION,
    correlationId: `parity-${kind}-publish`,
    payload: { kind, id, expectedDraftVersion: tokenFor(store, kind, id) }
  });

  const result = published?.result as
    | { defects?: Array<{ field: string; code: string }> }
    | undefined;
  return {
    valid: published?.status === 'accepted',
    defects: sorted((result?.defects ?? []).map((defect) => `${defect.field}|${defect.code}`)),
    reason: published?.reason,
    active: store.stateOf(kind, id) === 'active',
    ops: ops()
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

interface Case {
  readonly label: string;
  readonly kind: Kind;
  readonly row: Row;
  readonly valid: boolean;
  /** For a broken case, the defect the case exists to produce. */
  readonly defect?: Defect;
}

const CASES: readonly Case[] = [
  { label: 'a valid Phase', kind: 'phase', row: PHASE_VALID, valid: true },
  {
    label: 'a Phase with an illegal id and an empty name',
    kind: 'phase',
    row: PHASE_BROKEN,
    valid: false,
    defect: 'phaseId|invalid-pattern'
  },
  { label: 'a valid Pipeline', kind: 'pipeline', row: PIPELINE_VALID, valid: true },
  {
    label: 'a Pipeline binding that refers forward',
    kind: 'pipeline',
    row: PIPELINE_FORWARD_BINDING,
    valid: false,
    defect: 'bindings[0].src.phaseIndex|binding-forward-reference'
  },
  {
    label: 'a Pipeline naming a Phase with no effective definition',
    kind: 'pipeline',
    row: PIPELINE_UNKNOWN_PHASE,
    valid: false,
    defect: 'phaseIds[0]|unknown-phase'
  },
  { label: 'a valid Workflow', kind: 'workflow', row: WORKFLOW_VALID, valid: true },
  {
    label: 'a Workflow connection naming a missing node',
    kind: 'workflow',
    row: WORKFLOW_MISSING_NODE,
    valid: false,
    defect: 'connections[0].from|unresolved-endpoint'
  },
  { label: 'a Phase that omits version', kind: 'phase', row: PHASE_NO_VERSION, valid: true },
  {
    label: 'a Pipeline that omits version',
    kind: 'pipeline',
    row: PIPELINE_NO_VERSION,
    valid: true
  }
];

const BROKEN = CASES.filter((entry) => !entry.valid);

beforeEach(() => {
  mocks.capabilities.clear();
});

describe('the fixture resolves as intended (positive controls)', () => {
  it('resolves every support Phase and Pipeline, so no case fails for lack of a catalog', () => {
    const phaseIds = new Set(EFFECTIVE_PHASES.map((phase) => phase.phaseId));
    expect(phaseIds).toContain('parity-draft');
    expect(phaseIds).toContain('parity-review');

    const pipelineIds = new Set(
      PIPELINE_RESOLUTION.effective.map((pipeline) => pipeline.pipelineId)
    );
    expect(pipelineIds).toContain('parity-source');
    expect(pipelineIds).toContain('parity-target');
    // The empty invalid-Pipeline map handed to the graph validator is correct
    // only while this holds. Feature 099 (T496f, FR-042) — the `scope` exemption
    // that used to sit here excused built-in rows; with one layer there are no
    // rows to excuse, so every invalid record counts.
    expect(
      PIPELINE_RESOLUTION.records.filter((record) => record.status === 'invalid')
    ).toEqual([]);
  });

  it.each(CASES.filter((entry) => entry.valid))(
    'publishes $label, so an accepted verdict means the gates ran',
    async ({ kind, row }) => {
      // Without this, a save or a publish refused before validation would read as
      // "no defects" on the sidebar side and agree with a headless clean verdict
      // for entirely the wrong reason.
      const outcome = await sidebarVerdict(kind, row);
      expect(outcome.reason).toBeUndefined();
      expect(outcome.active).toBe(true);
    }
  );

  it.each(BROKEN)('refuses $label at the validation gate, not some later gate', async ({ kind, row }) => {
    const outcome = await sidebarVerdict(kind, row);
    // One literal for all three kinds (`catalog-lifecycle-commit.ts`): the three
    // `<kind>-validation` reasons were an artefact of three save commands, and the
    // condition they described was always the same one.
    expect(outcome.reason).toBe('validation-failed');
    // And it refused *before* the write. The draft save is the only instruction that
    // reached the store, so the definition is still a Draft and there is nothing to
    // undo — which is the whole reason validation sits on the publish path rather
    // than after a write to an immutable record.
    expect(outcome.ops).toEqual(['save-draft']);
    expect(outcome.active).toBe(false);
  });
});

describe('both adapters return the same verdict (T031, FR-001, SC-001)', () => {
  it.each(CASES)('agrees on whether $label is valid', async ({ kind, row, valid }) => {
    const headless = headlessVerdict(kind, row);
    const sidebar = await sidebarVerdict(kind, row);

    expect(headless.valid).toBe(valid);
    expect(sidebar.valid).toBe(valid);
  });

  it.each(BROKEN)('agrees on the defect codes and field addresses for $label', async ({ kind, row }) => {
    const headless = headlessVerdict(kind, row);
    const sidebar = await sidebarVerdict(kind, row);

    // A defect is `field|code`, so this one assertion covers both of SC-001's
    // "same defects, same locations".
    expect(sidebar.defects).toEqual(headless.defects);
    // And an empty set on both sides would satisfy the equality above while
    // proving nothing at all.
    expect(headless.defects.length).toBeGreaterThan(0);
  });

  it.each(BROKEN)('reports $label at the expected address on both surfaces', async ({ kind, row, defect }) => {
    // The table above compares the two surfaces to each other. This compares
    // them to the address the requirement names, so a shared regression that
    // moved both cannot pass.
    const headless = headlessVerdict(kind, row);
    const sidebar = await sidebarVerdict(kind, row);

    expect(headless.defects).toContain(defect);
    expect(sidebar.defects).toContain(defect);
  });
});
