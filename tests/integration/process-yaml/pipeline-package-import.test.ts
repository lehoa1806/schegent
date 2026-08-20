// Feature 085 T043/T044 — the confirmed package write, across both host commands.
//
// A package can write two catalogs, and two catalog writes cannot be one atomic
// operation (FR-042). Everything below follows from taking that seriously rather
// than pretending otherwise:
//
//   ordered      — Phases first, then the Pipeline (FR-038), so a Pipeline is
//                  never persisted ahead of a dependency this same import
//                  supplies. The order is checked BEHAVIORALLY, not just by the
//                  sequence of spy calls: the Pipeline save resolves its
//                  references against the effective Phase catalog, so reversing
//                  the two writes turns an accepted save into an
//                  `unknown-phase` rejection.
//   independent  — each write is reported on its own (FR-042), so a failed
//                  second write reports exactly what landed (FR-042a).
//   irreversible — a failed second write triggers NO compensating delete
//                  (FR-042c). Re-running the same document is the recovery
//                  (FR-042b), and it is self-healing because the landed Phases
//                  then plan `skip` and resolve the Pipeline's references.
//
// Feature 099 (T496f, FR-042) — "two catalogs" used to mean two configuration
// keys, each with a user and a workspace layer, and a package write picked one
// scope for both. The scope tier is deleted: there is one catalog per kind, so
// `scope` leaves every payload and the layers a proposal appends to are simply
// the rows the store holds. Every claim below is about the ORDER and the
// INDEPENDENCE of the two writes, and neither was ever a property of the scope.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored below rather than imported — the webview is a separate program —
// exactly as `phase-import-commit.test.ts` mirrors the single-Phase one. What
// this file asserts is that the two HOST commands compose over the shape the
// contract specifies.
//
// Feature 100 (T514, FR-035, FR-037, FR-040) — there are no longer two host
// commands to compose. One `CMD_PUBLISH_PACKAGE` carries every layer, and the
// ordering that used to live in the webview's send sequence lives in the host,
// where it belongs: `publishPackage` sorts by dependency rank, so a request that
// lists the Pipeline first is published Phases-first anyway.
//
// Three of this file's claims change shape rather than going away, and the change
// is in each case a strengthening:
//
//   ordered      — still Phases before the Pipeline (FR-035), now asserted over the
//                  store's two write ports rather than over the caller's loop. The
//                  behavioural half moved: a Pipeline no longer needs its Phases to
//                  have LANDED, because the whole document is validated as one
//                  candidate set with every member overlaid (FR-017). So the test
//                  that reversed the writes is replaced by the sharper pair — the
//                  same Pipeline validates WITH its Phases in the request and is
//                  refused WITHOUT them — and the ordering claim becomes what it
//                  always was underneath: when the Pipeline's pointer moves, the
//                  Phases it binds are already live.
//   independent  — one ack, not two, and the host computes the outcome the webview
//                  used to derive. `partial` is a first-class arm of the reply
//                  (FR-037), so "never reported as wholly succeeded or wholly
//                  failed when it was neither" is now a property of the contract
//                  rather than a rule a caller could forget to apply.
//   irreversible — unchanged, and still the point: whichever prefix landed stays
//                  written, no compensating delete runs on any path (FR-038), and
//                  re-running the same document completes it (FR-039).
//
// What a "partial" is has moved one level down, too. A failure is a failure of one
// of the two passes, so a partial leaves a layer PUBLISHED and a layer DRAFTED —
// written, present in history, and not triggerable. That is the state the cases
// below observe, and it is why nothing needs undoing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/package-import' },
    name: 'package-import',
    index: 0
  })
}));

import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML, CMD_PUBLISH_PACKAGE } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  PublishPackageCommand
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { publishDefinitionPackage } from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { FakeCatalogStore, NO_WRITES, tokenFor, writesOf } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';

/** The catalog each write targets, and the order the two occur in. */
type LayerKey = 'phases' | 'pipelines';

const KIND_OF: Readonly<Record<LayerKey, CatalogKind>> = {
  phases: 'phase',
  pipelines: 'pipeline'
};

/** The other direction, for reading a recorded write request back as a layer key. */
const KEY_OF: Readonly<Record<CatalogKind, LayerKey | 'workflows'>> = {
  phase: 'phases',
  pipeline: 'pipelines',
  workflow: 'workflows'
};

/** Both writable catalogs, behind the one store a package write goes through. */
interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(seed: {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
} = {}): Installation {
  return {
    store: new FakeCatalogStore({
      phases: seed.phases ?? [],
      pipelines: seed.pipelines ?? [],
      workflows: seed.workflows ?? []
    })
  };
}

/**
 * The read seams every handler in this file shares, wired to one store.
 *
 * Feature 100 (T512, T514, FR-043) — each layer carries `ids` as well as `rows`,
 * because the host's `storedLayer` does and the difference between the two is what
 * the import presence gate reads: `rows` is the active bodies, `ids` is every entry
 * at every state. A harness that supplied only `rows` would fall back to the row ids
 * and report an operator's unpublished draft as absent, which is the one thing
 * FR-044 forbids — and the partial-recovery case below would then pass by importing
 * over a draft instead of skipping it.
 */
function catalogDeps(store: FakeCatalogStore): Record<string, unknown> {
  const layer = (kind: CatalogKind) => () => ({
    rows: store.rowsOf(kind),
    revision: store.revisionOf(kind),
    ids: new Set(store.idsOf(kind))
  });
  return {
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: layer('phase'),
    readPipelineConfig: layer('pipeline'),
    readWorkflowConfig: layer('workflow')
  };
}

/**
 * Someone else writes a catalog between the preview and the confirm.
 *
 * Feature 099 (T496f) — the cases that need this used to assign a layer array in
 * place. A revision is the store's now, not a hash of an array, so the way to
 * make a preview stale is to perform the write that moves it.
 */
async function concurrentWrite(
  inst: Installation,
  key: LayerKey,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const kind = KIND_OF[key];
  // Feature 100 (T514) — both passes, because the write has to be LIVE: a case that
  // seeds a competing row and then reads the effective catalog would otherwise be
  // reading a draft that nothing runs. Two revision moves rather than one, which is
  // irrelevant to every caller here — a stale gate is stale either way.
  const written = await inst.store.saveDraftLayer({
    kind,
    expectedRevision: inst.store.revisionOf(kind),
    definitions: rows.map((row) => ({ id: row.id as string, body: row }))
  });
  expect(written.outcome).toBe('saved');
  const published = await inst.store.publishLayer({
    kind,
    ids: rows.map((row) => row.id as string),
    expectedRevision: inst.store.revisionOf(kind)
  });
  expect(published.outcome).toBe('published');
}

const CORRELATION = 'package-import-1';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Pipeline', ...body, ''].join('\n');
}

/**
 * Self-contained: the root's every reference is supplied by the same document.
 * `specify` and `plan` are free ids — the built-ins are all `speckit-` prefixed —
 * so nothing here resolves by accident.
 */
const SELF_CONTAINED = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - plan',
  '  inputs:',
  '    - portId: feature-brief',
  '      label: Feature brief',
  '      type: text',
  '      required: true',
  '  bindings:',
  '    - kind: input',
  '      phaseIndex: 0',
  '      inputKey: brief',
  '      source:',
  '        from: pipeline-input',
  '        portId: feature-brief',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.',
  '    - metadata:',
  '        phaseId: plan',
  '        name: Plan',
  '        version: 5',
  '      spec:',
  '        instruction: Write the plan.'
]);

/**
 * The root references a Phase this document does not supply and no layer holds,
 * so the root is `blocked` while the one included Phase stays eligible (FR-039).
 */
const BLOCKED_ROOT = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - polish',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.'
]);

const HELD_PHASE = Object.freeze({
  id: 'held',
  name: 'Held',
  version: 4,
  instruction: 'Hold.'
});

const HELD_PIPELINE = Object.freeze({
  // Feature 098 (T080) — the held Pipeline used to name `speckit-specify`, which
  // resolved out of the built-in Phase layer. That layer is empty, so it names the
  // held Phase instead: every installation below that holds this Pipeline holds
  // that Phase in the same scope. The row has to stay valid, because the point of
  // "held" is that an import leaves it standing — an invalid row would be rejected
  // by the write gate and the case would report a validation failure instead.
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['held']
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit — the webview's translation, mirrored
// ---------------------------------------------------------------------------

/** Only `import` rows are written; `skip`, `blocked`, and `invalid` are not (FR-037). */
function importedPhases(plan: ImportPlan): readonly PhaseDefinition[] {
  const definitions: PhaseDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'phase') definitions.push(row.definition);
  }
  return definitions;
}

function importedPipelines(plan: ImportPlan): readonly PipelineDefinition[] {
  const definitions: PipelineDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'pipeline') {
      definitions.push(row.definition);
    }
  }
  return definitions;
}

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * The one command the confirmation sends, with a layer per kind the plan imports.
 *
 * Feature 100 (T514, FR-039b) — the `[...layers.phases, ...]` prefix is gone from
 * both layers. A layer write MERGES now: an id the request does not name is left
 * exactly as it is, so echoing the held rows back would assert nothing except that
 * the caller can copy an array. Its absence is the stronger claim, and the cases
 * that seed a held row and read it back afterwards are what make it.
 *
 * The layers are built Phases-first because that reads naturally, not because the
 * order matters here — the host sorts them (FR-035), which the ordering case below
 * asserts by sending them the other way round.
 */
function packageCommand(plan: ImportPlan): PublishPackageCommand {
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);
  const layers: PublishPackageCommand['payload']['layers'][number][] = [];

  if (phases.length > 0) {
    layers.push({
      kind: 'phase',
      expectedRevision: plan.computedAgainstRevision,
      definitions: phases.map((definition) => ({
        id: definition.phaseId,
        body: phaseRow(definition)
      }))
    });
  }

  if (pipelines.length > 0) {
    // FR-036 — the Pipeline catalog carries ITS OWN revision, not the Phase
    // catalog's. A single revision could not gate two independently mutable
    // catalogs, and using the live one at confirm time would defeat FR-040.
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'pipeline',
      expectedRevision: revision!,
      definitions: pipelines.map((definition) => ({
        id: definition.pipelineId,
        body: pipelineRow(definition)
      }))
    });
  }

  return { type: CMD_PUBLISH_PACKAGE, correlationId: CORRELATION, payload: { layers } };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  /** Layers pass 1 sent a draft write for, in the order the store saw them. */
  readonly drafted: readonly LayerKey[];
  /** Layers pass 2 sent a publication for, in the order the store saw them. */
  readonly published: readonly LayerKey[];
  readonly outcome: 'imported' | 'partial' | 'failed';
}

/**
 * The outcome as the host reports it (FR-037).
 *
 * This used to be the webview's rule, mirrored: count the accepted acks. There is
 * one ack now and `partial` is one of its reasons, so the rule the surface applies
 * is a read rather than a derivation — an import cannot be reported as wholly
 * succeeded or wholly failed when it was neither, because no caller is computing it.
 */
function outcomeOf(ack: CommandAckMessage): CommitRun['outcome'] {
  if (ack.status === 'accepted') return 'imported';
  return ack.reason === 'package-partial' ? 'partial' : 'failed';
}

/** Which pass of which layer the store should refuse, for the partial cases. */
interface FailPoint {
  readonly key: LayerKey;
  readonly pass: 'draft' | 'publish';
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  opts: { readonly failOn?: FailPoint; readonly command?: PublishPackageCommand } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      catalogLifecycle: fakeCatalogLifecycle(inst.store),
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // Feature 099 (T496f, FR-029) — `failOn` made the settings writer throw. The
  // store never throws; it names the fault, and `not-writable` is the same fault by
  // its own name. Feature 100 (T514) — keyed by kind, because the pass that must
  // fail is no longer the first write the store sees.
  if (opts.failOn !== undefined) {
    const kind = KIND_OF[opts.failOn.key];
    const refusal = { outcome: 'refused' as const, reason: 'not-writable' as const, id: null };
    if (opts.failOn.pass === 'draft') inst.store.draftLayerVerdicts.set(kind, refusal);
    else inst.store.publishLayerVerdicts.set(kind, refusal);
  }

  const draftsBefore = inst.store.draftLayerSaves.length;
  const publishesBefore = inst.store.publishLayers.length;

  await publishDefinitionPackage(ctx, opts.command ?? packageCommand(plan));

  expect(acks).toHaveLength(1);
  const ack = acks[0]!;

  // The layers each pass reached, in order. A gate that answers ahead of the store
  // leaves no request behind on either port, which is what the `NO_WRITES` cases
  // assert; a request that was refused still recorded itself here, which is what
  // makes "the Pipeline pass ran and was turned away" distinguishable from "the
  // Pipeline pass never ran".
  const layersOf = <T extends { readonly kind: CatalogKind }>(
    requests: readonly T[],
    from: number
  ): readonly LayerKey[] => requests.slice(from).map((request) => KEY_OF[request.kind] as LayerKey);

  return {
    ack,
    drafted: layersOf(inst.store.draftLayerSaves, draftsBefore),
    published: layersOf(inst.store.publishLayers, publishesBefore),
    outcome: outcomeOf(ack)
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function phaseCatalogOf(inst: Installation) {
  return resolvePhaseCatalog({
    rows: inst.store.rowsOf('phase'),
    revision: inst.store.revisionOf('phase')
  });
}

function effectivePhaseIds(inst: Installation): readonly string[] {
  return phaseCatalogOf(inst).effective.map((definition) => definition.phaseId);
}

function pipelineCatalogOf(inst: Installation) {
  return resolvePipelineCatalog({
    rows: inst.store.rowsOf('pipeline'),
    revision: inst.store.revisionOf('pipeline'),
    phaseCatalog: phaseCatalogOf(inst).effective
  });
}

function effectivePipelineIds(inst: Installation): readonly string[] {
  return pipelineCatalogOf(inst).effective.map((definition) => definition.pipelineId);
}

function snapshot(inst: Installation): string {
  return JSON.stringify({
    phases: inst.store.rowsOf('phase'),
    pipelines: inst.store.rowsOf('pipeline')
  });
}

beforeEach(() => capabilities.clear());

describe('Feature 085 T043 — the ordered two-layer write', () => {
  it('writes only the `import` rows, leaving `skip` untouched (FR-037)', async () => {
    // `specify` is already held, so it plans `skip` and stays at the version the
    // host holds — a skip is not a write, and not an overwrite either.
    const inst = installation({
      phases: [HELD_PHASE, { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' }]
    });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
    // The declared version survives the write it arrived on (FR-044).
    expect(inst.store.rowsOf('pipeline')).toEqual([
      expect.objectContaining({ id: 'ship-it', version: 3, phases: ['specify', 'plan'] })
    ]);
  });

  it('publishes the Phase catalog before the Pipeline catalog (FR-035)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    // Both passes, both in dependency order. The draft port is asserted as well as
    // the publish port because the drafts are what pass 2 gates on: a pass 1 that
    // wrote the Pipeline first would still publish in rank order, and this case
    // would pass while the store had seen the document backwards.
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    expect(run.published).toEqual(['phases', 'pipelines']);
    // One ack naming both layers, which is the whole of what the surface has to
    // read to report the import — no counting of acks, no deriving of an outcome.
    expect(run.ack.result).toEqual({
      published: [
        { kind: 'phase', ids: ['specify', 'plan'], total: 2 },
        { kind: 'pipeline', ids: ['ship-it'], total: 1 }
      ]
    });
  });

  it('publishes Phases first even when the request lists the Pipeline first (FR-035)', async () => {
    // The ordering is the HOST's now. Feature 085 asserted it by the sequence the
    // webview sent its two commands in, which is a claim about the webview; there is
    // one command, so the claim is that `publishPackage` sorts by dependency rank
    // whatever order the layers arrive in. Sent backwards, it comes out forwards.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const reversed: PublishPackageCommand = {
      ...sent,
      payload: { layers: [...sent.payload.layers].reverse() }
    };
    expect(reversed.payload.layers.map((layer) => layer.kind)).toEqual(['pipeline', 'phase']);

    const run = await commitPackage(inst, plan, { command: reversed });

    expect(run.outcome).toBe('imported');
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    expect(run.published).toEqual(['phases', 'pipelines']);
  });

  it('validates the Pipeline against the Phases arriving with it (FR-017)', async () => {
    // The behavioural half of the old ordering claim, sharpened. A Pipeline used to
    // need its Phases to have LANDED, so reversing the two writes turned an accepted
    // save into an `unknown-phase` rejection. It no longer does: the document is one
    // candidate set and every member is overlaid before anything is validated, so the
    // Pipeline resolves against what this publication is about to make live.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(effectivePhaseIds(inst)).not.toContain('specify');

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('refuses the same Pipeline when its Phases are not in the request (FR-017)', async () => {
    // The other half of the pair, and what keeps the carve-out from being a hole: the
    // union is the CANDIDATE set, not the union of everything anyone might publish
    // next. Drop the Phase layer and the identical Pipeline body no longer resolves —
    // nothing is written on either port, and the refusal names the missing dependency
    // rather than a generic failure.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const sent = packageCommand(plan);
    const pipelineOnly: PublishPackageCommand = {
      ...sent,
      payload: { layers: sent.payload.layers.filter((layer) => layer.kind === 'pipeline') }
    };

    const run = await commitPackage(inst, plan, { command: pipelineOnly });

    expect(run.outcome).toBe('failed');
    expect(run.ack.reason).toBe('validation-failed');
    const detail = run.ack.result as { readonly defects: readonly { readonly code: string }[] };
    expect(detail.defects.map((defect) => defect.code)).toContain('unknown-phase');
    expect(JSON.stringify(detail.defects)).toContain('specify');
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
  });

  it('leaves the Pipeline unpublished when the Phase publication is refused (FR-035)', async () => {
    // Why the order still has teeth once validation no longer depends on it: a
    // Pipeline whose Phases did not go live must not go live either. Refuse the Phase
    // pointer move and pass 2 stops there — the Pipeline body is written, drafted,
    // and not triggerable, and the operator is told which layer stopped it.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'phases', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    // Reached the Phase port and was turned away; never reached the Pipeline's.
    expect(run.published).toEqual(['phases']);
    expect(run.ack.result).toMatchObject({
      published: [],
      draftedOnly: ['phase', 'pipeline'],
      failedKind: 'phase',
      cause: 'not-writable'
    });
    expect(effectivePhaseIds(inst)).not.toContain('specify');
    expect(effectivePipelineIds(inst)).not.toContain('ship-it');
    expect(inst.store.draftRowsOf('pipeline')).toEqual([
      expect.objectContaining({ id: 'ship-it', phases: ['specify', 'plan'] })
    ]);
  });

  it('writes the eligible Phase even though the Pipeline is blocked (FR-039)', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan);

    // A blocked row is not a failed write — it was never eligible, so there is
    // no Pipeline layer in the request at all and nothing partial about the
    // outcome. Both ports see one layer, which is the same claim on either.
    expect(run.drafted).toEqual(['phases']);
    expect(run.published).toEqual(['phases']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'polish' } }
    });
  });

  it('refuses the package when the Phase catalog changed since preflight (FR-036)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    await concurrentWrite(inst, 'phases', [
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ]);
    const before = snapshot(inst);

    const run = await commitPackage(inst, plan);

    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    // The layer, and only the layer. A package names several kinds and only some of
    // them can be stale, so the actionable fact is which one — recompute the plan
    // and the fresh revision comes with it. There is no per-definition token to
    // report either, which is why this refusal carries no `current` record.
    expect(run.ack.result).toEqual({ kind: 'phase' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    expect(snapshot(inst)).toBe(before);
  });

  it('refuses the whole package when only the Pipeline catalog changed (FR-036)', async () => {
    // `held` is the Phase this Pipeline names, so the concurrent write below is a
    // valid catalog rather than one the write gate would reject for its own reasons.
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    // The two catalogs have independent revisions, so a concurrent Pipeline write
    // must stop this publication without pretending the Phase half is stale.
    await concurrentWrite(inst, 'pipelines', [HELD_PIPELINE]);

    const run = await commitPackage(inst, plan);

    // Feature 100 (T514) — this used to be a `partial`: two commands went out in
    // order, the Phase one landed, and the Pipeline one was refused for its own
    // revision. One command means the staleness question is asked of EVERY declared
    // layer before any write, so a stale Pipeline revision now costs nothing — the
    // Phase layer is not written and then stranded. Strictly better, and the
    // per-layer claim is untouched: the refusal names `pipeline`, so the Phase
    // revision was checked against its own and passed.
    expect(run.outcome).toBe('failed');
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.ack.result).toEqual({ kind: 'pipeline' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    expect(effectivePhaseIds(inst)).not.toContain('specify');
    expect(inst.store.rowsOf('pipeline')).toEqual([HELD_PIPELINE]);
  });

  it('reports staleness rather than the denied capability (FR-036)', async () => {
    // Both gates would fire. The operator is told the one that is actionable:
    // the preview no longer describes the catalog, so re-running the preflight
    // is the next step whether or not the capability is ever granted.
    capabilities.set('phases', false);
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);
    await concurrentWrite(inst, 'phases', [
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ]);

    const run = await commitPackage(inst, plan);

    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
  });

  it('reports staleness on the Pipeline layer with every capability denied (FR-036)', async () => {
    // Feature 099 (T496f, FR-046) — this denied `pipelineOverrides`, which is
    // deleted along with the layer tier: a Pipeline publication consults no
    // capability at all now, so "both gates would fire" is unreachable on this
    // path. What survives is the half that still has teeth — the staleness answer
    // does not depend on the resolver — so every remaining capability is denied
    // and the publication must still report the actionable reason.
    //
    // The document's Phases are seeded, so they plan `skip` and the Pipeline layer
    // is the only one declared. Otherwise the denied `phases` capability would be
    // the gate under test rather than the staleness one.
    for (const capability of ['phases', 'retryConditions']) {
      capabilities.set(capability, false);
    }
    const inst = installation({
      phases: [
        HELD_PHASE,
        { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
        { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
      ]
    });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 1, skip: 2, blocked: 0, invalid: 0 });
    await concurrentWrite(inst, 'pipelines', [HELD_PIPELINE]);

    const run = await commitPackage(inst, plan);

    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.ack.result).toEqual({ kind: 'pipeline' });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
  });
});

describe('Feature 085 T044 — a failed second pass is partial, and stays partial', () => {
  it('leaves the Phases live and reports the outcome as partial (FR-037)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    // Exactly which resources landed is observable, which is what FR-037 asks the
    // surface to report: the Phase layer published, the Pipeline layer did not, and
    // the reason it did not is named.
    expect(run.ack).toMatchObject({ status: 'rejected', reason: 'package-partial' });
    expect(run.ack.result).toEqual({
      published: [{ kind: 'phase', total: 2 }],
      draftedOnly: ['pipeline'],
      failedKind: 'pipeline',
      cause: 'not-writable'
    });
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).not.toContain('ship-it');
    // And what "drafted only" means, checked rather than taken on the ack's word:
    // the Pipeline body is written and readable, it is simply not what runs.
    expect(inst.store.draftRowsOf('pipeline')).toEqual([
      expect.objectContaining({ id: 'ship-it', version: 3, phases: ['specify', 'plan'] })
    ]);
  });

  it('triggers no compensating delete of the Phases that landed (FR-038)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'publish' } });

    // Two drafts and two publications attempted, and nothing after the refusal.
    // Removing a resource the operator never confirmed removing is a destructive
    // write in its own right, and it can destroy a concurrent edit.
    expect(run.drafted).toEqual(['phases', 'pipelines']);
    expect(run.published).toEqual(['phases', 'pipelines']);
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
    // Nor is the half-written layer withdrawn: the draft the failed pass wrote is
    // still there. A partial deletes nothing, in either direction (SC-009).
    expect(inst.store.stateOf('pipeline', 'ship-it')).toBe('draft');
  });

  it('needs no cleanup to re-run, and re-running writes nothing twice (FR-039)', async () => {
    // Feature 100 (T514, FR-039/FR-039a) — recovery changes shape here, and the
    // change is the point rather than a casualty. Under two whole-array writes the
    // failed one had written NOTHING, so re-running re-sent the Pipeline and it
    // landed. Under the lifecycle the failed pass had already written the body as a
    // draft, so the re-run finds it present (FR-044 — every state, including Draft)
    // and plans it as a skip. A skip is never published (FR-039a): an import must
    // not publish a draft as a side effect, and the store cannot tell a draft this
    // document wrote from one the operator was midway through authoring.
    //
    // So the recovery FR-039 promises is that nothing needs redoing and nothing
    // needs undoing — every landed write is still exactly what it was, and the one
    // step left is the deliberate publication the partial ack already named in
    // `draftedOnly`. That last step is taken below, through the same service, to
    // show the draft is complete and publishable as it stands.
    const inst = installation({ phases: [HELD_PHASE] });
    const first = await planFor(inst, SELF_CONTAINED);
    const partial = await commitPackage(inst, first, {
      failOn: { key: 'pipelines', pass: 'publish' }
    });
    expect(partial.outcome).toBe('partial');

    // The same bytes, nothing edited, nothing removed by hand.
    const second = await planFor(inst, SELF_CONTAINED);

    // Every resource the first run wrote is present — two Phases live, one Pipeline
    // drafted — so the whole document plans as skips and there is nothing to write.
    expect(second.counts).toEqual({ import: 0, skip: 3, blocked: 0, invalid: 0 });
    expect(second.rows.map((row) => row.resourceId)).toEqual(['ship-it', 'specify', 'plan']);

    const run = await commitPackage(inst, second);

    expect(run.outcome).toBe('imported');
    expect(run.ack.result).toEqual({ published: [] });
    expect(run.drafted).toEqual([]);
    expect(run.published).toEqual([]);
    // The Phases were not rewritten, so the versions the first run stored stand.
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);

    // And the one step the operator owns completes it, off the document.
    const published = await fakeCatalogLifecycle(inst.store).publish({
      kind: 'pipeline',
      id: 'ship-it',
      expectedDraftVersion: tokenFor(inst.store, 'pipeline', 'ship-it')
    });
    expect(published.outcome).toBe('published');
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T052 — an import removes nothing, so it confirms nothing (FR-054)
// ---------------------------------------------------------------------------
//
// Every other mutating catalog action has a confirmation because it can destroy
// work: `catalog.remove-phase` and `catalog.remove-pipeline` erase a row, and
// `workspace.reset` erases a layer. Import has none, and FR-054 states the reason
// rather than the policy — it never removes or replaces an existing resource.
//
// So this pins the reason, not just the absence. The registry check alone would
// pass just as well on an import that silently overwrote a held row; what makes
// the missing gate CORRECT is that a write only ever appends, and a resource the
// host already holds plans `skip` (FR-030) and is left exactly as authored.

// Feature 100 (T514) — the two `CMD_SAVE_*` names are gone with the commands. The
// import path is the preflight and the one package publish it confirms into, and
// those are the names that must stay off the destructive list.
const IMPORT_PATH_COMMANDS: readonly string[] = [
  'CMD_PREFLIGHT_PROCESS_YAML',
  'CMD_PUBLISH_PACKAGE'
];

describe('Feature 085 T052 — import registers no destructive-action confirmation (FR-054)', () => {
  it('names no import-path command in the destructive-command set', () => {
    // Read as text rather than imported: these are the two hand-maintained
    // tables the `useConfirm` gate is derived from, and the assertion is about
    // what they LIST. `tests/lint/destructive-actions.lint.test.ts` enforces the
    // gate over that list; this enforces that import stays off it.
    const lint = readFileSync(
      resolve(__dirname, '..', '..', 'lint', 'destructive-actions.lint.test.ts'),
      'utf8'
    );
    const listed = lint.slice(
      lint.indexOf('const DESTRUCTIVE_COMMANDS'),
      lint.indexOf('];', lint.indexOf('const DESTRUCTIVE_COMMANDS'))
    );
    for (const command of IMPORT_PATH_COMMANDS) expect(listed).not.toContain(command);
  });

  it('declares no confirmation copy for an import action', () => {
    // An `ActionKey` is the handle a confirmation is registered under. No import
    // key exists, so there is nothing for a call site to await — the gate cannot
    // be added by accident, only deliberately and with copy to match.
    const copy = readFileSync(
      resolve(__dirname, '..', '..', '..', 'webview-ui', 'src', 'lib', 'action-copy.ts'),
      'utf8'
    );
    // Feature 100 (T514) — the member LINES, not the raw slice. This used to cut at
    // the first `;` after the declaration, and the union now carries a comment that
    // contains one, so the slice stopped before the keys — leaving the two negatives
    // below passing because they were looking at prose instead of at key names.
    // Filtering to the `|` lines fixes both halves at once: nothing is truncated, and
    // a comment that happened to say "import" cannot fail a test about what the
    // surface can confirm.
    const keys = copy
      .slice(copy.indexOf('export type ActionKey'), copy.indexOf('export type Severity'))
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .join('\n');
    // Feature 100 (T509a, FR-049) — the positive anchor was `catalog.remove-phase`,
    // one of the four removal keys the two lifecycle keys replace. It has to be a
    // key that EXISTS, or the negatives would pass against an empty slice.
    expect(keys).toContain("'catalog.deactivate-definition'");
    expect(keys.toLowerCase()).not.toContain('import');
    expect(keys.toLowerCase()).not.toContain('exchange');
  });

  it('appends to the target catalog and rewrites nothing that was there', async () => {
    const MINE = Object.freeze({ id: 'mine', name: 'Mine', version: 9, instruction: 'Mine.' });
    const inst = installation({
      phases: [HELD_PHASE, MINE],
      pipelines: [HELD_PIPELINE]
    });
    const before = JSON.parse(snapshot(inst)) as {
      phases: readonly unknown[];
      pipelines: readonly unknown[];
    };

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan);
    expect(run.outcome).toBe('imported');

    // Each catalog is its prior contents, in order, followed by the imported rows.
    // Positional, because a row that moved is a row some other reader's index
    // now points past.
    expect(inst.store.rowsOf('phase').slice(0, before.phases.length)).toEqual(before.phases);
    expect(inst.store.rowsOf('pipeline').slice(0, before.pipelines.length)).toEqual(
      before.pipelines
    );
    expect(inst.store.rowsOf('phase').length).toBe(before.phases.length + 2);
    expect(inst.store.rowsOf('pipeline').length).toBe(before.pipelines.length + 1);
  });

  it('leaves a resource the host already holds exactly as its author wrote it', async () => {
    // The document declares `specify` at version 2 with its own instruction. The
    // host holds a different `specify`. The held one is what an operator would
    // lose if import replaced rather than skipped, so it is the case worth
    // pinning: nothing about it changes, not even its position.
    const AUTHORED = Object.freeze({
      id: 'specify',
      name: 'My Specify',
      version: 41,
      instruction: 'Mine, not the document.'
    });
    const inst = installation({ phases: [AUTHORED, HELD_PHASE] });

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    await commitPackage(inst, plan);

    expect(inst.store.rowsOf('phase')[0]).toEqual(AUTHORED);
    expect(
      inst.store.rowsOf('phase').filter((row) => (row as { id: string }).id === 'specify')
    ).toEqual([AUTHORED]);
  });

  it('touches no catalog it was not addressed to', async () => {
    // Feature 099 (T496f, FR-042) — this read "touches neither the other scope nor
    // the layer it was not addressed to", and half of it named a destination that
    // no longer exists. The surviving half is the one that was always the point: a
    // package declares the kinds it carries, and a kind it does not declare is not
    // written. This document is a Pipeline package, so the Workflow catalog is the
    // one it was not addressed to — untouched down to its revision, which is the
    // stronger reading, because a rewrite that happened to produce the same rows
    // would still move it.
    const WORKFLOW_ROW = Object.freeze({
      id: 'held-flow',
      name: 'Held Flow',
      version: 1,
      nodes: []
    });
    const inst = installation({ workflows: [WORKFLOW_ROW] });
    const untouchedRevision = inst.store.revisionOf('workflow');

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan);
    expect(run.outcome).toBe('imported');

    expect(inst.store.rowsOf('workflow')).toEqual([WORKFLOW_ROW]);
    expect(inst.store.revisionOf('workflow')).toBe(untouchedRevision);
    // Both write ports, because a kind is untouched only if neither pass named it.
    expect(inst.store.draftLayerSaves.map((request) => request.kind)).toEqual([
      'phase',
      'pipeline'
    ]);
    expect(inst.store.publishLayers.map((request) => request.kind)).toEqual(['phase', 'pipeline']);
  });

  it('removes nothing when the second write fails, so recovery needs no undo (FR-042c)', async () => {
    // The other half of why no confirmation is owed: the failure mode is a
    // partial APPEND, never a partial delete. Re-running the same document is
    // the recovery (FR-042b, pinned in T044 above), and it needs no permission
    // to destroy anything because there is nothing to destroy.
    const inst = installation({ phases: [HELD_PHASE] });
    const before = [...inst.store.rowsOf('phase')];

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'publish' } });

    expect(run.outcome).toBe('partial');
    expect(inst.store.rowsOf('phase').slice(0, before.length)).toEqual(before);
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T058 — what the import leaves behind (FR-045, FR-046)
// ---------------------------------------------------------------------------
//
// FR-045: the document is a one-time input, not a source the catalog reads from.
// The catalog has exactly one source of rows, and a second one that happened to be
// a file on someone's disk would be a source no other installation has — a Pipeline
// that resolves here and nowhere else.
//
// FR-046: what import writes is a catalog row like any other. It goes through
// the same save command, the same validation, and the same cross-reference
// resolution an operator's own edit does — so an imported Pipeline cannot be
// valid in a way an authored one could not be, and cannot be invalid in a way
// the catalog would fail to notice.

describe('Feature 085 T058 — an import is not a catalog source (FR-045)', () => {
  it('reads the document once, and never again', async () => {
    let opens = 0;
    const inst = installation();
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        ...catalogDeps(inst.store),
        openProcessYamlDocument: async () => {
          opens += 1;
          return {
            outcome: 'read' as const,
            bytes: new Uint8Array(Buffer.from(SELF_CONTAINED, 'utf8'))
          };
        },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await preflightHandler(ctx, {
      type: CMD_PREFLIGHT_PROCESS_YAML,
      correlationId: CORRELATION,
      payload: {}
    } as PreflightProcessYamlCommand);
    expect(opens).toBe(1);

    const result = acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    // The commit is driven entirely by the plan. If the document were a source,
    // the write would need to consult it again.
    await commitPackage(inst, result.plan);
    expect(opens).toBe(1);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('survives the document changing underneath it after the commit', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan);
    const after = snapshot(inst);

    // A later read of a document that now says something else must be
    // impossible, not merely unlikely: resolve the catalog again and see the
    // same rows. Nothing here has a handle on the file to re-read.
    await planFor(inst, BLOCKED_ROOT);
    expect(snapshot(inst)).toBe(after);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('stores no trace of where the resource came from', async () => {
    // FR-050 forbids a path crossing the boundary at all; this is the storage
    // end of the same rule. A row that named its origin would also be a row
    // whose contents differ between two operators who imported the same bytes.
    //
    // Asserted on the key set rather than by scanning for suspicious words:
    // `source` is legitimate binding vocabulary, so a word list would either
    // miss a real origin field or fire on a real binding.
    //
    // The claim is one-directional — import ADDS nothing. The catalog's own
    // normalization drops an optional array that came out empty, which is why
    // this is a subset check and not deep equality: subtraction by a rule the
    // catalog applies to every row is not a trace of anything.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan);

    const addsNothing = (stored: readonly unknown[], declared: readonly Record<string, unknown>[]) => {
      expect(stored).toHaveLength(declared.length);
      stored.forEach((row, index) => {
        const expected = declared[index]!;
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          expect(Object.keys(expected)).toContain(key);
          expect(value).toEqual(expected[key]);
        }
      });
    };

    addsNothing(inst.store.rowsOf('phase'), importedPhases(plan).map(phaseRow));
    addsNothing(inst.store.rowsOf('pipeline'), importedPipelines(plan).map(pipelineRow));
  });
});

describe('Feature 085 T058 — an imported Pipeline is a catalog row like any other (FR-046)', () => {
  it('resolves as effective, with the definition the document declared', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan);

    const resolved = pipelineCatalogOf(inst);

    const record = resolved.records.find((row) => row.pipelineId === 'ship-it');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(resolved.effective.find((row) => row.pipelineId === 'ship-it')).toMatchObject({
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 3,
      phaseIds: ['specify', 'plan']
    });
  });

  it('is refused by the same validation an authored row is, not a lenient one', async () => {
    // A binding naming a port the Pipeline does not declare. Preflight plans the
    // row — the document is well formed — and the publication applies the same
    // cross-reference gate it applies to an operator's own edit. Import is not a
    // way around the catalog's rules.
    //
    // The Phases are seeded so this isolates the binding gate: with the catalog
    // empty, `unknown-phase` would fire alongside it and the binding defect would
    // be one of two rather than the one the case is about.
    const seed = installation();
    const plan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({ phases: importedPhases(plan).map(phaseRow) });
    const [pipeline] = importedPipelines(plan);
    expect(pipeline).toBeDefined();

    const broken = {
      ...pipelineRow(pipeline!),
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'no-such-port' }
        }
      ]
    };

    const run = await commitPackage(inst, plan, {
      command: {
        type: CMD_PUBLISH_PACKAGE,
        correlationId: CORRELATION,
        payload: {
          layers: [
            {
              kind: 'pipeline',
              expectedRevision: inst.store.revisionOf('pipeline'),
              definitions: [{ id: 'ship-it', body: broken }]
            }
          ]
        }
      }
    });

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('validation-failed');
    // The specific defect, not just the reason class: a coarse code alone would
    // pass on a rejection that happened for some unrelated reason.
    expect(run.ack.result).toMatchObject({
      kind: null,
      defects: [
        expect.objectContaining({
          kind: 'pipeline',
          id: 'ship-it',
          code: 'binding-unknown-input-port'
        })
      ],
      total: 1
    });
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
    // A refused publication reaches neither write port — not even the draft one.
    // Feature 100 (T514) — this is the stronger form of the old claim: validation
    // runs BEFORE pass 1 (FR-016), so an invalid body is not written and then
    // withheld, it is never written at all.
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
  });

  it('is refused when its Phases are nowhere, exactly as an authored row would be', async () => {
    // The other half of FR-046. A Pipeline whose Phases are neither live nor in the
    // request does not resolve, and the publication is refused for the same defect
    // an operator's own save would be. Feature 100 (T514, FR-017) — "not there" now
    // means absent from the CANDIDATE SET as well as from the catalog, which is what
    // makes the union a carve-out rather than a hole; the union half is pinned above.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const [pipeline] = importedPipelines(plan);

    const run = await commitPackage(inst, plan, {
      command: {
        type: CMD_PUBLISH_PACKAGE,
        correlationId: CORRELATION,
        payload: {
          layers: [
            {
              kind: 'pipeline',
              expectedRevision: plan.computedAgainstPipelineRevision!,
              definitions: [{ id: 'ship-it', body: pipelineRow(pipeline!) }]
            }
          ]
        }
      }
    });

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('validation-failed');
    const detail = run.ack.result as { readonly defects: readonly { readonly code: string }[] };
    expect(detail.defects.map((defect) => defect.code)).toContain('unknown-phase');
    expect(JSON.stringify(detail.defects)).toContain('specify');
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
  });
});
