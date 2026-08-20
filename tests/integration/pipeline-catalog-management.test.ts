// Feature 082 (US2, T036) — the persisted Phase sequence survives a full
// save-and-reload round trip.
//
// The Phase sequence is positional: a `phaseId` may repeat inside one Pipeline,
// so order is the only thing that distinguishes position 0 from position 2
// (research R3). This exercises the real handler and the real catalog resolver
// end to end — save through the lifecycle, reload the rows the host actually
// wrote through `resolvePipelineCatalog` — and asserts that neither side sorts,
// dedupes, or otherwise normalizes the order, and that a reorder's remapped
// binding `phaseIndex` values are persisted exactly as submitted.
//
// Feature 099 (T496f, FR-042, FR-046) — the layer tier is gone, so a save no
// longer picks a scope and the store is the thing written. Two of this file's
// claims had to find new ground:
//
//   * US7's removal fallback rested on a lower-precedence layer becoming
//     effective. Gate 13 still blocks on the same conjunction, so the arm that
//     survives is the other one: nothing references the id, so the removal
//     lands (FR-022, FR-022a).
//   * The `pipelineOverrides` capability is deleted with the tier it guarded.
//     An untrusted workspace activates no catalog at all now (FR-051), so gate
//     1 refuses the save outright — for every mutation kind alike, `reset`
//     included, since there is no per-mutation capability left to exempt one.
//
// Feature 100 (T514, FR-013, FR-024a, FR-025) — the whole-array save is gone,
// and with it the two concepts this file was organized around. A `mutation` no
// longer declares what a write is for: a per-definition operation *is* its
// intent, so `create` and `edit` are both `CMD_SAVE_DEFINITION_DRAFT` and the
// store decides which one happened by whether it already holds an entry. And a
// `remove` has no successor at all — a definition is taken out of service by
// `CMD_DEACTIVATE_DEFINITION`, which keeps its history and its draft rather than
// dropping the row.
//
// Three claims therefore re-seat rather than re-word:
//
//   * the round trip is now authored → draft record → publication → active row →
//     resolver, which is a longer trip than the single write it replaces: a row
//     becomes effective only by being published, so the order asserted below is
//     the order that survived two writes.
//   * gate 13's conjunction is FR-025's reference scan. It reads the store's own
//     active projection instead of a `readWorkflowPipelineRefs` seam, so the
//     referencing Workflow is *seeded* here rather than declared, and the
//     refusal names the field the reference sits in.
//   * the revision gate survives only for the package publish (FR-036). Per
//     definition, staleness is the draft token, so window B now loses by holding
//     a token the publication cleared rather than a revision a write moved.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { capabilities: new Map<string, boolean>() }
}));

vi.mock('../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));

vi.mock('../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/test-workspace', scheme: 'file' },
    name: 'test-workspace',
    index: 0
  })
}));

import { resolvePipelineCatalog } from '../../src/config/pipeline-catalog';
import type { PipelineDefinition } from '../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { CatalogKind } from '../../src/contracts/catalog-store';
import { NO_DRAFT } from '../../src/contracts/catalog-lifecycle';
import { SanitizedLogger } from '../../src/lib/logger';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import {
  FakeCatalogStore,
  NO_WRITES,
  tokenFor,
  writesOf,
  type FakeStoreSeed
} from '../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../fixtures/fake-catalog-lifecycle';

const PHASE_CATALOG: readonly PhaseDefinition[] = [
  { phaseId: 'speckit-specify', name: 'Specify', version: 1, instruction: 'Specify.' },
  { phaseId: 'speckit-plan', name: 'Plan', version: 1, instruction: 'Plan.' },
  { phaseId: 'done', name: 'Done', version: 1, instruction: 'Done.' }
];

/** The same Phases in authored form, for the store's Phase layer. */
const AUTHORED_PHASE_ROWS: readonly unknown[] = PHASE_CATALOG.map((phase) => ({
  id: phase.phaseId,
  name: phase.name,
  version: phase.version,
  instruction: `${phase.name}.`
}));

// Deliberately not alphabetical, and `speckit-specify` appears twice: any
// sort or dedupe anywhere on the path shows up as a changed sequence.
const AUTHORED_PHASES = ['speckit-specify', 'speckit-plan', 'speckit-specify', 'done'] as const;

// The same rows after moving position 3 to position 1, with every binding
// `phaseIndex` remapped by the same permutation (US2). The host must persist
// this verbatim; it never re-derives the order or the indices.
const REORDERED_PHASES = ['speckit-specify', 'done', 'speckit-plan', 'speckit-specify'] as const;

const AUTHORED_BINDINGS = [
  { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
  { kind: 'output', phaseIndex: 1, portId: 'plan-doc', outputKey: 'plan' },
  { kind: 'input', phaseIndex: 2, inputKey: 'plan', source: { from: 'phase-output', phaseIndex: 1, portId: 'plan-doc' } }
] as const;

const REORDERED_BINDINGS = [
  { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
  { kind: 'output', phaseIndex: 2, portId: 'plan-doc', outputKey: 'plan' },
  { kind: 'input', phaseIndex: 3, inputKey: 'plan', source: { from: 'phase-output', phaseIndex: 2, portId: 'plan-doc' } }
] as const;

const PIPELINE_ID = 'ordered-flow';

// Feature 100 — `version` is no longer threaded through from the stored row. The
// version-must-match gate belonged to the whole-array save (T506); history is
// the store's now, so the authored body carries only what the operator wrote.
function authoredRow(
  phases: readonly string[],
  bindings: readonly unknown[]
): Record<string, unknown> {
  return {
    id: PIPELINE_ID,
    name: 'Ordered Flow',
    version: 1,
    phases: [...phases],
    inputs: [
      { portId: 'brief', label: 'Brief', type: 'text' },
      { portId: 'plan-doc', label: 'Plan document', type: 'pipeline-output' }
    ],
    outputs: [{ portId: 'plan-doc', label: 'Plan document', type: 'markdown' }],
    bindings: [...bindings]
  };
}

interface Harness {
  readonly router: MessageRouter;
  readonly store: FakeCatalogStore;
}

interface HarnessOptions {
  /**
   * An untrusted workspace activates no catalog, so the window holds no
   * lifecycle service to dispatch to (099 FR-051). Gate 1 is the whole of that
   * contract. The store stays wired, which is what keeps the ordering claim
   * below non-vacuous: the staleness pre-check *could* have run.
   */
  readonly noLifecycle?: boolean;
}

function harness(seed: FakeStoreSeed = {}, options: HarnessOptions = {}): Harness {
  // The Pipeline validation resolves every `phaseId` against the Phase
  // projection, so the reload side's `PHASE_CATALOG` and the store's Phase rows
  // have to describe the same Phases.
  const store = new FakeCatalogStore({ phases: AUTHORED_PHASE_ROWS, ...seed });
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: new SanitizedLogger(),
    audit: { append: vi.fn().mockResolvedValue(undefined) },
    catalogStore: store,
    catalogLifecycle: options.noLifecycle ? null : fakeCatalogLifecycle(store),
    refreshCatalog: async () => undefined
  };
  return { router: new MessageRouter(deps), store };
}

let dispatched = 0;

/**
 * Dispatches one command, with a correlation id no other dispatch shares.
 *
 * The router caches every mutation ack by correlation id and replays it for an
 * hour, so a test that reuses one would get the *first* dispatch's ack back
 * without the second ever reaching a handler. The whole-array save needed one
 * write per test and never noticed; a lifecycle test writes two or three times,
 * and would otherwise assert against a replay.
 */
async function dispatch(
  { router }: Harness,
  command: Record<string, unknown>
): Promise<CommandAckMessage> {
  dispatched += 1;
  const correlationId = `${String(command.correlationId ?? command.type)}-${dispatched}`;
  const acks: CommandAckMessage[] = [];
  await router.dispatch({ ...command, correlationId } as unknown as SidebarCommand, async (message) => {
    acks.push(message);
    return true;
  });
  const ack = acks[0];
  expect(ack, 'the router must ack every lifecycle command').toBeDefined();
  return ack;
}

/**
 * The target every per-definition operation carries.
 *
 * The token is read from the store rather than written out: it is the draft
 * pointer, which every write moves (FR-012), so a literal would make each test
 * depend on how many writes ran before it. The stale cases below pass their own
 * token deliberately, and say so.
 */
function target(store: FakeCatalogStore, kind: CatalogKind, id: string): Record<string, unknown> {
  return { kind, id, expectedDraftVersion: tokenFor(store, kind, id) };
}

async function saveDraft(
  h: Harness,
  kind: CatalogKind,
  body: Record<string, unknown>
): Promise<CommandAckMessage> {
  return dispatch(h, {
    type: CMD_SAVE_DEFINITION_DRAFT,
    correlationId: 'test-correlation-save',
    payload: { ...target(h.store, kind, String(body.id)), body }
  });
}

async function publish(h: Harness, kind: CatalogKind, id: string): Promise<CommandAckMessage> {
  return dispatch(h, {
    type: CMD_PUBLISH_DEFINITION,
    correlationId: 'test-correlation-publish',
    payload: target(h.store, kind, id)
  });
}

/** Author a definition and make it effective — the two writes one save used to be. */
async function commit(
  h: Harness,
  kind: CatalogKind,
  body: Record<string, unknown>
): Promise<CommandAckMessage> {
  const saved = await saveDraft(h, kind, body);
  expect(saved.status, `the draft save of ${String(body.id)} must be accepted`).toBe('accepted');
  return publish(h, kind, String(body.id));
}

async function deactivate(
  h: Harness,
  kind: CatalogKind,
  id: string
): Promise<CommandAckMessage> {
  return dispatch(h, {
    type: CMD_DEACTIVATE_DEFINITION,
    correlationId: 'test-correlation-deactivate',
    payload: target(h.store, kind, id)
  });
}

/** Reloads a persisted catalog exactly as the host does on the next projection. */
function reload(rows: readonly unknown[]): PipelineDefinition {
  const catalog = resolvePipelineCatalog({
    rows,
    revision: 'rev-reload',
    phaseCatalog: PHASE_CATALOG
  });
  const definition = catalog.effective.find((candidate) => candidate.pipelineId === PIPELINE_ID);
  expect(definition, 'the saved Pipeline must resolve as effective on reload').toBeDefined();
  return definition as PipelineDefinition;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
});

describe('Pipeline catalog management — Phase sequence order round-trip (US2, T036)', () => {
  it('persists the authored Phase order verbatim and reloads it unchanged', async () => {
    const h = harness();

    const ack = await commit(h, 'pipeline', authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS));

    expect(ack.status).toBe('accepted');
    const persisted = h.store.rowsOf('pipeline');
    expect((persisted[0] as { phases: readonly string[] }).phases).toEqual([...AUTHORED_PHASES]);
    expect(reload(persisted).phaseIds).toEqual([...AUTHORED_PHASES]);
  });

  it('round-trips a reorder together with its remapped binding indices', async () => {
    const h = harness();
    await commit(h, 'pipeline', authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS));

    const ack = await commit(h, 'pipeline', authoredRow(REORDERED_PHASES, REORDERED_BINDINGS));

    expect(ack.status).toBe('accepted');
    const definition = reload(h.store.rowsOf('pipeline'));
    expect(definition.phaseIds).toEqual([...REORDERED_PHASES]);
    expect(definition.bindings).toEqual([...REORDERED_BINDINGS]);
  });

  it('carries the reloaded order through to the runtime Pipeline projection', async () => {
    const h = harness();
    await commit(h, 'pipeline', authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS));

    const catalog = resolvePipelineCatalog({
      rows: h.store.rowsOf('pipeline'),
      revision: 'rev-reload',
      phaseCatalog: PHASE_CATALOG
    });
    const runtime = catalog.effectivePipelineDefs.find((candidate) => candidate.id === PIPELINE_ID);
    expect(runtime?.phases).toEqual([...AUTHORED_PHASES]);
  });

  // Feature 099 — the revision is the store's, not a hash of the rows, so a
  // pure reorder proves itself by moving it: the store saw a real write.
  //
  // Feature 100 (FR-011a) — and the converse is now assertable in the same
  // breath. A save is measured against the head, so the reorder appends a
  // version while re-submitting the identical body does not: opening the editor
  // and closing it cannot manufacture history.
  it('appends a version for a pure reorder and none for a re-save of the same body', async () => {
    const h = harness();
    await commit(h, 'pipeline', authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS));
    const settled = h.store.revisionOf('pipeline');

    const reordered = await saveDraft(
      h,
      'pipeline',
      authoredRow(REORDERED_PHASES, REORDERED_BINDINGS)
    );
    expect(reordered.status).toBe('accepted');
    expect(reordered.result).toMatchObject({ appended: true });
    const moved = h.store.revisionOf('pipeline');
    expect(moved).not.toBe(settled);

    const again = await saveDraft(h, 'pipeline', authoredRow(REORDERED_PHASES, REORDERED_BINDINGS));
    expect(again.status).toBe('accepted');
    expect(again.result).toMatchObject({ appended: false });
    expect(h.store.revisionOf('pipeline')).toBe(moved);
  });
});

// ── US7 (T052) — isolated deactivation and gate 13's conjunction (SC-006) ────
//
// Taking a Pipeline out of service is an edit to exactly one catalog. The two
// things that can go wrong are the two things asserted here: writing more than
// the definition named, and stranding a Workflow that still references the id.
// Gate 13 blocks only when BOTH hold — the id would leave the effective catalog
// AND something references it — so each condition is exercised on its own.

const SCOPED_ROW = {
  id: 'scoped-flow',
  name: 'Scoped Flow',
  version: 1,
  phases: ['speckit-plan', 'done']
} as const;

const NEIGHBOUR_ROW = {
  id: 'neighbour-flow',
  name: 'Neighbour Flow',
  version: 1,
  phases: ['done']
} as const;

/**
 * A Workflow whose single node names `pipelineId`.
 *
 * Feature 100 — the reference is *seeded* rather than declared through a
 * `readWorkflowPipelineRefs` seam: the scan reads the store's own active
 * Workflow projection (FR-025), so a reference that is not really in the store
 * is not really a reference.
 */
function workflowRow(id: string, pipelineId: string): Record<string, unknown> {
  return {
    id,
    name: 'Reference Holder',
    version: 1,
    nodes: [{ nodeId: 'only', pipelineId }],
    connections: [],
    startNodeIds: ['only']
  };
}

function effectiveScoped(rows: readonly unknown[]) {
  const catalog = resolvePipelineCatalog({
    rows,
    revision: 'rev-reload',
    phaseCatalog: PHASE_CATALOG
  });
  return catalog.effective.find((entry) => entry.pipelineId === 'scoped-flow');
}

describe('Pipeline catalog management — isolated deactivation and gate 13 (US7, T052, SC-006)', () => {
  it('writes only the definition it named and leaves the sibling catalogs untouched', async () => {
    const h = harness({ pipelines: [SCOPED_ROW, NEIGHBOUR_ROW] });

    const ack = await deactivate(h, 'pipeline', 'scoped-flow');

    expect(ack.status).toBe('accepted');
    // One write, on the per-definition port, naming one definition. The
    // whole-array save could only ever express "the layer is now this"; a
    // lifecycle write names its target, so "wrote more than it named" is a
    // shape this assertion can see.
    expect(writesOf(h.store)).toEqual({ ...NO_WRITES, lifecycle: 1 });
    expect(h.store.lifecycleWrites[0]).toEqual({
      op: 'deactivate',
      kind: 'pipeline',
      id: 'scoped-flow',
      expectedDraftVersion: NO_DRAFT
    });
    expect(h.store.rowsOf('pipeline')).toEqual([NEIGHBOUR_ROW]);
    // The Phase catalog the same store holds is neither written nor moved.
    expect(h.store.rowsOf('phase')).toEqual(AUTHORED_PHASE_ROWS);
    expect(h.store.revisionOf('phase')).toBe('rev-phase-0');
  });

  // Feature 099 — the permitting arm used to be "a lower-precedence source
  // remains effective". One catalog leaves the other arm of the same
  // conjunction: the id leaves the effective catalog, and nothing referenced it.
  it('lets the deactivation land when no active Workflow references the id', async () => {
    const h = harness({
      pipelines: [SCOPED_ROW, NEIGHBOUR_ROW],
      workflows: [workflowRow('wf-1', 'neighbour-flow')]
    });
    expect(effectiveScoped(h.store.rowsOf('pipeline'))?.name).toBe('Scoped Flow');

    const ack = await deactivate(h, 'pipeline', 'scoped-flow');

    expect(ack.status).toBe('accepted');
    expect(h.store.rowsOf('pipeline')).toEqual([NEIGHBOUR_ROW]);
    expect(effectiveScoped(h.store.rowsOf('pipeline'))).toBeUndefined();
    // Feature 100 (FR-024a) — out of service, not deleted. The entry keeps its
    // history and holds the version that was live as its Draft, which is what
    // makes the step reversible; the old `remove` dropped the row outright.
    expect(ack.result).toMatchObject({ state: 'draft', draftVersionId: 'v1', advisories: [] });
    expect(h.store.stateOf('pipeline', 'scoped-flow')).toBe('draft');
  });

  it('blocks the deactivation and writes nothing while an active Workflow references it', async () => {
    const h = harness({
      pipelines: [SCOPED_ROW],
      workflows: [workflowRow('wf-1', 'scoped-flow')]
    });

    const ack = await deactivate(h, 'pipeline', 'scoped-flow');

    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('referenced');
    // Feature 100 — the refusal used to report two parallel id lists. A blocker
    // now names the field it sits in, so the operator is told where to look
    // rather than only which Workflow to open.
    expect(ack.result).toMatchObject({
      blockers: [{ kind: 'workflow', id: 'wf-1', field: 'nodes[0].pipelineId' }],
      total: 1
    });
    expect(writesOf(h.store)).toEqual(NO_WRITES);
    expect(h.store.rowsOf('pipeline')).toEqual([SCOPED_ROW]);
    expect(effectiveScoped(h.store.rowsOf('pipeline'))?.name).toBe('Scoped Flow');
  });
});

// T057 (FR-029, FR-030, SC-008) — two windows edit the same definition. The
// second one must lose cleanly: rejected with what the host actually holds and
// what the operator may legally do next, and with the store untouched. The trust
// case is the same contract from the other direction — an untrusted window is
// refused before any write, not after a partial one.
describe('Pipeline catalog management — concurrent windows and trust (T057)', () => {
  const ROW = authoredRow(AUTHORED_PHASES, AUTHORED_BINDINGS);
  const SCOPED_TARGET = {
    kind: 'pipeline',
    id: 'scoped-flow',
    expectedDraftVersion: NO_DRAFT
  } as const;

  it('rejects a save against a superseded draft token with the authoritative record and legal actions', async () => {
    // Both windows author the same Draft and both now hold `v1` as its token.
    const h = harness();
    expect((await saveDraft(h, 'pipeline', ROW)).status).toBe('accepted');
    const bothWindowsHold = tokenFor(h.store, 'pipeline', PIPELINE_ID);
    expect(bothWindowsHold).toBe('v1');

    // Window A publishes, which clears the draft pointer window B is holding.
    expect((await publish(h, 'pipeline', PIPELINE_ID)).status).toBe('accepted');

    const outcome = await dispatch(h, {
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'window-b',
      payload: {
        kind: 'pipeline',
        id: PIPELINE_ID,
        expectedDraftVersion: bothWindowsHold,
        body: { ...ROW, name: 'Renamed By Window B' }
      }
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBe('stale-catalog');
    // An exact record, not a subset. Feature 099 dropped the `scope` the record
    // used to name; feature 100 drops the echoed row with it. A revision
    // addressed a whole layer, so the row had to be reported for window B to see
    // what it was about to overwrite — per definition the retry needs one thing,
    // the token, and reporting the body would put an operator-authored value in
    // an ack that FR-015 keeps free of them.
    expect(outcome.result).toEqual({
      current: {
        kind: 'pipeline',
        id: PIPELINE_ID,
        state: 'active',
        draftVersionId: null,
        activeVersionId: 'v1',
        expectedDraftVersion: NO_DRAFT
      },
      legalActions: ['save-draft', 'deactivate', 'restore']
    });
  });

  it('changes no state on a stale operation — the definition is never written', async () => {
    const h = harness();
    await saveDraft(h, 'pipeline', ROW);
    const staleToken = tokenFor(h.store, 'pipeline', PIPELINE_ID);
    await publish(h, 'pipeline', PIPELINE_ID);
    const settled = {
      rows: h.store.rowsOf('pipeline'),
      revision: h.store.revisionOf('pipeline'),
      writes: writesOf(h.store)
    };

    // A discard, not a save: the gate sits on the path every operation shares,
    // so a second window losing has nothing to do with what it was trying to do.
    const outcome = await dispatch(h, {
      type: CMD_DISCARD_DEFINITION_DRAFT,
      correlationId: 'window-b',
      payload: { kind: 'pipeline', id: PIPELINE_ID, expectedDraftVersion: staleToken }
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBe('stale-catalog');
    expect(writesOf(h.store)).toEqual(settled.writes);
    expect(h.store.rowsOf('pipeline')).toEqual(settled.rows);
    expect(h.store.revisionOf('pipeline')).toBe(settled.revision);
  });

  // Feature 099 (FR-046, FR-051) — the `pipelineOverrides` capability is deleted
  // with the tier it guarded. An untrusted workspace activates no catalog, so
  // the same window is refused at gate 1 instead, still before any write.
  it('rejects a window with no activated catalog before any write (FR-029, FR-051)', async () => {
    const h = harness({}, { noLifecycle: true });

    const outcome = await saveDraft(h, 'pipeline', ROW);

    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBe('config-ops-unavailable');
    // No result at all: there is no authoritative record to report, because
    // there is no activated catalog to have read one from.
    expect(outcome.result).toBeUndefined();
    expect(writesOf(h.store)).toEqual(NO_WRITES);
    expect(h.store.rowsOf('pipeline')).toEqual([]);
  });

  // Feature 059's I-2 exempted `reset` from the capability ceiling: returning a
  // layer to its defaults could never redefine anything. Both halves of that are
  // gone — the capability with the tier it guarded, and `reset` with the
  // whole-array write. What replaces the exemption is its absence: gate 1 sits
  // ahead of every operation alike, so there is no per-operation arm to exempt.
  it('refuses every lifecycle operation alike when no catalog is activated (feature 059 I-2)', async () => {
    const h = harness({ pipelines: [SCOPED_ROW] }, { noLifecycle: true });
    const operations: readonly Record<string, unknown>[] = [
      { type: CMD_SAVE_DEFINITION_DRAFT, payload: { ...SCOPED_TARGET, body: SCOPED_ROW } },
      { type: CMD_PUBLISH_DEFINITION, payload: { ...SCOPED_TARGET } },
      { type: CMD_DEACTIVATE_DEFINITION, payload: { ...SCOPED_TARGET } },
      { type: CMD_RESTORE_DEFINITION_VERSION, payload: { ...SCOPED_TARGET, fromVersionId: 'v1' } },
      { type: CMD_DISCARD_DEFINITION_DRAFT, payload: { ...SCOPED_TARGET } },
      {
        type: CMD_PUBLISH_PACKAGE,
        payload: {
          layers: [
            {
              kind: 'pipeline',
              expectedRevision: h.store.revisionOf('pipeline'),
              definitions: [{ id: 'scoped-flow', body: SCOPED_ROW }]
            }
          ]
        }
      }
    ];

    for (const operation of operations) {
      const type = String(operation.type);
      const ack = await dispatch(h, { correlationId: `no-catalog-${type}`, ...operation });
      expect(ack.status, `${type} must be refused`).toBe('rejected');
      expect(ack.reason, `${type} must report the missing catalog`).toBe('config-ops-unavailable');
    }

    expect(writesOf(h.store)).toEqual(NO_WRITES);
    expect(h.store.rowsOf('pipeline')).toEqual([SCOPED_ROW]);
  });

  it('applies gate 1 before the staleness pre-check, so a storeless stale save reports the missing catalog', async () => {
    // The store is wired and holds `scoped-flow` with no Draft, so `v99` is
    // provably stale and the pre-check would have refused it. Only the ordering
    // of the two gates decides which refusal the window is told about.
    const h = harness({ pipelines: [SCOPED_ROW] }, { noLifecycle: true });

    const outcome = await dispatch(h, {
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'window-b',
      payload: {
        kind: 'pipeline',
        id: 'scoped-flow',
        expectedDraftVersion: 'v99',
        body: { ...SCOPED_ROW, name: 'Renamed' }
      }
    });

    expect(outcome.reason).toBe('config-ops-unavailable');
    expect(writesOf(h.store)).toEqual(NO_WRITES);
  });
});
