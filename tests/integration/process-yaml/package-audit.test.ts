// Feature 085 T064 — what a package exchange records about itself (FR-059,
// FR-060, FR-061).
//
// 084 settled the envelope: operation, resource kind, ids, per-resource outcomes,
// counts, and nothing else. A package does not change that shape — it changes what
// fills it. One document now carries several definitions, writes several catalogs,
// and can end in a state that is neither success nor failure, and the envelope has
// to describe all of that without acquiring a field an instruction could ride out
// in.
//
// Feature 099 (T496f, FR-041) — the envelope is FIVE fields now: `scope` named
// the layer a write went to, and there is one catalog per kind, so `resourceKind`
// already says it. Every `scope` assertion below is deleted rather than relaxed,
// and the exact-key-set check is what keeps the field from creeping back — a
// build that re-emits it, under any value, fails at the first case in the file.
//
// Three claims, in the order the FRs make them:
//
//   FR-059 — the payload is the same five fields, whatever the document held.
//   FR-060 — none of the document's own text reaches the log. The tokens below
//            are planted in every operator-authored slot a package has, so the
//            absence assertions fail on a leak instead of on a coincidence.
//   FR-061 — refused, blocked, stale, committed, partial, and never-happened are
//            six distinguishable states. That is the whole point of auditing an
//            import: an operator reconstructing what became of a document needs
//            to tell "the write was refused" from "the write never ran".
//
// The commit half is what this feature adds. 084 audited a refusal and a
// capability denial and deliberately audited neither a plan nor a write: a
// single Phase either landed or did not, and the catalog itself was the record.
// A package can land in pieces (FR-042a), so the catalog is no longer a record
// of what the operator asked for — two layers agreeing with each other says
// nothing about the document that produced them.
//
// A plan is still not audited. Preflight changes nothing, and logging every
// inspection would make the log describe the operator's browsing.
//
// Feature 100 (T514, T513b) — the three `CMD_SAVE_*` commands the commit half was
// driven through are deleted. There is ONE command, `CMD_PUBLISH_PACKAGE`, and the
// host runs two ordered passes over its layers. Three things move, and the claims
// above hold in a stronger form for each:
//
//   * One command, still one record PER CONFIRMED LAYER. The records are what make
//     the partial state readable, and a partial is a statement about kinds — so a
//     single record for "the import" would describe something that never happens
//     as a unit. `exchangeTargets` in the handler builds one target per non-empty
//     layer, rank-ordered, and the ordering case below sends the layers BACKWARDS
//     to show the log's order is the host's rather than the caller's.
//   * A layer left as a draft records the same reason as the layer that failed:
//     nothing of it became triggerable, so as an *import* it did not land. Which
//     is which is the ack's job (`draftedOnly` against `failedKind`), and no
//     `drafted` outcome literal is invented for it — the vocabulary stays 085's.
//   * Staleness is asked of every layer before anything is written (FR-036), so a
//     stale kind refuses the WHOLE package. The stale cases below therefore assert
//     a refusal record per confirmed layer and zero writes, where they used to
//     assert one record and a written prefix.
//
// The `import-package` mutation intent is gone with the layer saves: a publication
// of this command IS an import commit, because the Builder's own writes are
// per-definition. The two "records nothing for an ordinary edit" cases below are
// what hold that line — they drive the per-definition lifecycle instead, and it
// records itself through `definition-published`, never through this family.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
// A root whose own name is a planted token. Feature 059's trust payload records
// the BASENAME by design (I-6), which is why the basename is an unremarkable
// word and the token sits above it.
const WORKSPACE_ROOT = '/Users/planted/ws/PKG-ROOT-TOKEN-Q9/checkout';
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/Users/planted/ws/PKG-ROOT-TOKEN-Q9/checkout' },
    name: 'checkout',
    index: 0
  })
}));

import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_SAVE_DEFINITION_DRAFT
} from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  PublishDefinitionCommand,
  PublishPackageCommand,
  SaveDefinitionDraftCommand
} from '../../../src/contracts/sidebar-ipc';
import {
  ALL_AUDIT_EVENT_TYPES,
  AUDIT_SCHEMA_VERSION,
  PROCESS_EXCHANGE_EVENT_TYPES
} from '../../../src/contracts/audit-events';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { FakeCatalogStore, NO_WRITES, tokenFor, writesOf } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import {
  publishDefinition,
  publishDefinitionPackage,
  saveDefinitionDraft
} from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';

/** The catalog each layer of a package targets, and the order they publish in. */
type LayerKey = 'phases' | 'pipelines' | 'workflows';

const LAYER_ORDER: readonly LayerKey[] = ['phases', 'pipelines', 'workflows'];

const KIND_OF: Readonly<Record<LayerKey, CatalogKind>> = {
  phases: 'phase',
  pipelines: 'pipeline',
  workflows: 'workflow'
};

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

/**
 * The fields the envelope is closed on. One more is the failure.
 *
 * Feature 099 (T496f, FR-041) — six became five when `scope` went.
 */
const ENVELOPE_KEYS = [
  'counts',
  'operation',
  'outcomes',
  'resourceIds',
  'resourceKind'
] as const;

const CORRELATION = 'package-audit-1';

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
// The planted document
// ---------------------------------------------------------------------------
//
// Every slot a package gives operator-authored prose, each with its own token,
// so a leak says WHICH field leaked rather than only that something did.

const TOKENS = {
  pipelineName: 'PKG-NAME-TOKEN-Q1',
  pipelineDescription: 'PKG-DESC-TOKEN-Q2',
  portLabel: 'PORT-LABEL-TOKEN-Q3',
  portDescription: 'PORT-DESC-TOKEN-Q4',
  instruction: 'INSTRUCTION-TOKEN-Q5',
  skill: 'SKILL-TOKEN-Q6',
  // A well-formed DSL expression whose identifier is the token. The exchange
  // path never parses this — but the catalog's own validator does on the way in,
  // so a token that is not an expression would fail the write for a reason that
  // has nothing to do with auditing.
  retryCondition: 'RETRY_TOKEN_Q7 > 0',
  // An identifier, not prose: `recommendedNext` names other Pipelines and the
  // catalog holds it to `^[a-z][a-z0-9-]{0,63}$`. Still document content, so
  // still a token — just one the format can carry.
  recommendedNext: 'next-token-q8',
  secret: 'sk-secret-value-Q0'
} as const;

/** Every planted string, plus the two location-shaped things FR-060 also bars. */
const FORBIDDEN_AUDIT_TOKENS = [
  ...Object.values(TOKENS),
  WORKSPACE_ROOT,
  'PKG-ROOT-TOKEN-Q9',
  'ship-it.pipeline.yaml'
] as const;

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Pipeline', ...body, ''].join('\n');
}

/**
 * A self-contained package with a token in every authored slot. `specify` and
 * `polish` are free ids — the built-ins are all `speckit-` prefixed — so nothing
 * here resolves by accident.
 */
const PLANTED_PACKAGE = packageDocument([
  'metadata:',
  '  id: ship-it',
  `  name: ${TOKENS.pipelineName}`,
  `  description: ${TOKENS.pipelineDescription}`,
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - polish',
  '  inputs:',
  '    - portId: feature-brief',
  `      label: ${TOKENS.portLabel}`,
  '      type: text',
  '      required: true',
  `      description: ${TOKENS.portDescription}`,
  '  recommendedNext:',
  `    - ${TOKENS.recommendedNext}`,
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  `        instruction: ${TOKENS.instruction} and a planted ${TOKENS.secret}`,
  `        retryCondition: ${TOKENS.retryCondition}`,
  '    - metadata:',
  '        phaseId: polish',
  '        name: Polish',
  '        version: 1',
  '      spec:',
  `        skill: ${TOKENS.skill}`
]);

/**
 * The root references a Phase this document does not supply and no layer holds,
 * so the root is `blocked` while the included Phase stays eligible (FR-039).
 */
const BLOCKED_ROOT = packageDocument([
  'metadata:',
  '  id: ship-it',
  `  name: ${TOKENS.pipelineName}`,
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - absent-phase',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  `        instruction: ${TOKENS.instruction}`
]);

/**
 * Clears the version gate and fails the kind gate, so a test using it pins
 * `unsupported-kind` rather than whichever gate happens to run first.
 */
const REFUSED_DOCUMENT = 'apiVersion: schegent/v1\nkind: Deployment\n';

/**
 * Refused as a Pipeline, which a syntax refusal cannot be: the scanner runs
 * before the dispatch reads `kind`, so an anchor or a tab is recorded under the
 * handler's documented `'phase'` default. This document parses, dispatches, and
 * is refused by the package reader for declaring one id twice.
 */
const REFUSED_AS_PIPELINE = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Once.',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify Again',
  '        version: 3',
  '      spec:',
  '        instruction: Twice.'
]);

// ---------------------------------------------------------------------------
// Catalog rows, as the store holds them
// ---------------------------------------------------------------------------

const STORED_PHASES = [
  {
    phaseId: 'specify',
    name: 'Specify',
    version: 2,
    instruction: `${TOKENS.instruction} and a planted ${TOKENS.secret}`,
    retryCondition: TOKENS.retryCondition
  },
  { phaseId: 'polish', name: 'Polish', version: 1, skill: TOKENS.skill }
] as const;

const STORED_PIPELINE = {
  pipelineId: 'ship-it',
  name: TOKENS.pipelineName,
  description: TOKENS.pipelineDescription,
  version: 3,
  phaseIds: ['specify', 'polish'],
  inputs: [
    {
      portId: 'feature-brief',
      label: TOKENS.portLabel,
      type: 'text',
      required: true,
      description: TOKENS.portDescription
    }
  ],
  recommendedNext: [TOKENS.recommendedNext]
} as const;

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/**
 * One installation is now one store. Feature 099 (T496f, FR-042) — this was a
 * pair of `{ user, workspace }` layers per kind, and every helper below took a
 * `scope` to say which half it meant. The store IS the installation, so the
 * parameter is gone from every signature and the seams the handlers read
 * (`readXConfig`, `catalogStore`) all come off the same object.
 */
interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(
  seed: {
    readonly phases?: readonly unknown[];
    readonly pipelines?: readonly unknown[];
    readonly workflows?: readonly unknown[];
  } = {}
): Installation {
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
 * Feature 100 (T512, FR-043) — each layer carries `ids` as well as `rows`, because
 * the host's `storedLayer` does and the difference is what the import presence gate
 * reads: `rows` is the active bodies, `ids` is every entry at every state. A harness
 * supplying only `rows` would report an operator's unpublished draft as absent.
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

interface ExportRun {
  readonly audits: readonly AuditEntry[];
  readonly saved: readonly { suggestedFileName: string; text: string }[];
  readonly ack: CommandAckMessage;
}

async function exportPipeline(
  inst: Installation,
  inclusion: 'references-only' | 'include-referenced'
): Promise<ExportRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      saveProcessYamlDocument: async (request: { suggestedFileName: string; text: string }) => {
        saved.push({ ...request });
        return { outcome: 'saved' as const };
      },
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;

  const command: ExportProcessYamlCommand = {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: { resourceKind: 'pipeline', resourceId: 'ship-it', inclusion }
  };
  await exportHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { audits, saved, ack: acks[0]! };
}

interface PreflightRun {
  readonly result: PreflightProcessYamlResult;
  readonly audits: readonly AuditEntry[];
  readonly ack: CommandAckMessage;
}

async function preflight(
  inst: Installation,
  opened:
    | { readonly outcome: 'read'; readonly bytes: Uint8Array }
    | { readonly outcome: 'canceled' }
): Promise<PreflightRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      openProcessYamlDocument: async () => opened,
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { result: acks[0]!.result as PreflightProcessYamlResult, audits, ack: acks[0]! };
}

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const run = await preflight(inst, {
    outcome: 'read',
    bytes: new Uint8Array(Buffer.from(text, 'utf8'))
  });
  expect(run.result.outcome).toBe('planned');
  if (run.result.outcome !== 'planned') throw new Error('unreachable');
  return run.result.plan;
}

// --- the webview's plan-to-request translation, mirrored ---------------------

function imported<T>(plan: ImportPlan, kind: CatalogKind): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
    }
  }
  return definitions;
}

const importedPhases = (plan: ImportPlan) => imported<PhaseDefinition>(plan, 'phase');
const importedPipelines = (plan: ImportPlan) => imported<PipelineDefinition>(plan, 'pipeline');
const importedWorkflows = (plan: ImportPlan) => imported<WorkflowDefinition>(plan, 'workflow');

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * The row shape the webview emitter actually sends (feature 086 T054):
 * `saveWorkflowRowFromDefinition` spreads the definition and renames nothing,
 * because the Workflow catalog arrived after the `id` spelling was retired.
 *
 * Feature 100 (T514) — the legacy-`id` acceptance went with the retired handler,
 * so the canonical `workflowId` spelling is not merely what a caller happens to
 * send: it is the only spelling that reads back, and the store keeps bodies
 * verbatim (099 FR-010).
 */
function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

/**
 * The one command the confirmation sends, with a layer per kind the plan imports.
 *
 * `revisions` replaces the per-key overrides the three-command driver took: a
 * declared revision that no longer matches is how a caller says "the catalog moved
 * under my preview", and it is still declared per layer (FR-036).
 */
function packageCommand(
  plan: ImportPlan,
  revisions: Partial<Record<CatalogKind, string>> = {}
): PublishPackageCommand {
  const layers: PublishPackageCommand['payload']['layers'][number][] = [];
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);
  const workflows = importedWorkflows(plan);

  if (phases.length > 0) {
    layers.push({
      kind: 'phase',
      expectedRevision: revisions.phase ?? plan.computedAgainstRevision,
      definitions: phases.map((definition) => ({
        id: definition.phaseId,
        body: phaseRow(definition)
      }))
    });
  }

  if (pipelines.length > 0) {
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'pipeline',
      expectedRevision: revisions.pipeline ?? revision!,
      definitions: pipelines.map((definition) => ({
        id: definition.pipelineId,
        body: pipelineRow(definition)
      }))
    });
  }

  if (workflows.length > 0) {
    const revision = plan.computedAgainstWorkflowRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'workflow',
      expectedRevision: revisions.workflow ?? revision!,
      definitions: workflows.map((definition) => ({
        id: definition.workflowId,
        body: workflowRow(definition)
      }))
    });
  }

  return { type: CMD_PUBLISH_PACKAGE, correlationId: CORRELATION, payload: { layers } };
}

/** Every handler in this file reads the same deps off the same store. */
interface Driven {
  // Structurally faked: these suites supply the deps a handler reads, and nothing
  // else — the router's own shape is asserted by the transport suites.
  readonly ctx: any;
  readonly acks: CommandAckMessage[];
  readonly audits: AuditEntry[];
}

function driver(inst: Installation): Driven {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      // The real service over the fake disk: a suite that hand-rolled the decision
      // half would be asserting against a second implementation of it.
      catalogLifecycle: fakeCatalogLifecycle(inst.store),
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
  } as any;
  return { ctx, acks, audits };
}

/** Which pass of which layer the store should refuse, for the partial cases. */
interface FailPoint {
  readonly key: LayerKey;
  readonly pass: 'draft' | 'publish';
}

interface CommitRun {
  readonly audits: readonly AuditEntry[];
  readonly records: readonly AuditEntry[];
  readonly ack: CommandAckMessage;
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  opts: {
    readonly failOn?: FailPoint;
    readonly revisions?: Partial<Record<CatalogKind, string>>;
    readonly command?: PublishPackageCommand;
  } = {}
): Promise<CommitRun> {
  const { ctx, acks, audits } = driver(inst);

  // Feature 099 (T496f, FR-029) — `failOn` used to make the settings writer throw.
  // The store never throws; it names the fault, and `not-writable` is the same
  // fault by its own name. Feature 100 (T514) — keyed by kind AND by pass, because
  // every layer is drafted before any is published, so "the Pipeline write fails"
  // has two distinct meanings and each produces a different partial.
  if (opts.failOn !== undefined) {
    const kind = KIND_OF[opts.failOn.key];
    const refusal = { outcome: 'refused' as const, reason: 'not-writable' as const, id: null };
    if (opts.failOn.pass === 'draft') inst.store.draftLayerVerdicts.set(kind, refusal);
    else inst.store.publishLayerVerdicts.set(kind, refusal);
  }

  await publishDefinitionPackage(
    ctx,
    opts.command ?? packageCommand(plan, opts.revisions ?? {})
  );
  expect(acks).toHaveLength(1);
  return { audits, records: exchangeAudits(audits), ack: acks[0]! };
}

/**
 * An ordinary catalog edit, which is what a package publication is NOT: write a
 * draft, then publish that one definition. Returns everything both commands logged.
 */
async function editOneDefinition(
  inst: Installation,
  target: { readonly kind: CatalogKind; readonly id: string },
  body: unknown
): Promise<readonly AuditEntry[]> {
  const { ctx, acks, audits } = driver(inst);
  const save: SaveDefinitionDraftCommand = {
    type: CMD_SAVE_DEFINITION_DRAFT,
    correlationId: CORRELATION,
    payload: {
      ...target,
      expectedDraftVersion: tokenFor(inst.store, target.kind, target.id),
      body
    }
  };
  await saveDefinitionDraft(ctx, save);
  const publish: PublishDefinitionCommand = {
    type: CMD_PUBLISH_DEFINITION,
    correlationId: CORRELATION,
    payload: { ...target, expectedDraftVersion: tokenFor(inst.store, target.kind, target.id) }
  };
  await publishDefinition(ctx, publish);
  expect(acks.map((ack) => ack.status)).toEqual(['accepted', 'accepted']);
  return audits;
}

/** Exchange records only — the trust gate's own events are a separate family. */
function exchangeAudits(audits: readonly AuditEntry[]): readonly AuditEntry[] {
  return audits.filter((entry) => entry.eventType.startsWith('process-exchange'));
}

/** The `(kind, outcomes)` pairs a run recorded, which is what every case reads. */
function recordedKinds(records: readonly AuditEntry[]): readonly [unknown, unknown][] {
  return records.map((entry) => [entry.payload.resourceKind, entry.payload.outcomes]);
}

beforeEach(() => {
  capabilities.clear();
});

// ---------------------------------------------------------------------------
// FR-059 — the envelope does not widen for a package
// ---------------------------------------------------------------------------

describe('Feature 085 T064 — a package exchange records five fields (FR-059)', () => {
  it('bounds a package export to the envelope, and names the Pipeline kind', async () => {
    const inst = installation({ phases: [...STORED_PHASES], pipelines: [STORED_PIPELINE] });
    const run = await exportPipeline(inst, 'include-referenced');
    expect(run.audits).toHaveLength(1);
    const entry = run.audits[0]!;
    expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(entry.payload.resourceKind).toBe('pipeline');
    expect(entry.payload.resourceIds).toEqual(['ship-it']);
  });

  it('counts the definitions the document actually carried, not just the root', async () => {
    // A package export writes N+1 definitions. `counts: { exported: 1 }` would
    // describe a references-only export equally well, which makes the two
    // operations indistinguishable in the log — and the difference is precisely
    // whether other operators' Phase text left the installation.
    const inst = installation({ phases: [...STORED_PHASES], pipelines: [STORED_PIPELINE] });
    const bundled = await exportPipeline(inst, 'include-referenced');
    expect(bundled.audits[0]!.payload.counts).toEqual({ exported: 1, includedPhases: 2 });

    const bare = await exportPipeline(inst, 'references-only');
    expect(bare.audits[0]!.payload.counts).toEqual({ exported: 1, includedPhases: 0 });
  });

  it('bounds a package refusal to the envelope, under the kind the dispatch settled on', async () => {
    const run = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_PIPELINE, 'utf8'))
    });
    expect(run.result.outcome).toBe('refused');
    expect(run.audits).toHaveLength(1);
    expect(Object.keys(run.audits[0]!.payload).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(run.audits[0]!.payload).toMatchObject({
      operation: 'import-preflight',
      resourceKind: 'pipeline',
      resourceIds: [],
      counts: { refused: 1 }
    });
  });

  it('bounds each layer of a confirmed import to the same envelope', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    // One per catalog written, because a package write is two operations that can
    // succeed independently (FR-042) — one command now, and still two records: a
    // single record for "the import" would describe something that never happens
    // as a unit.
    expect(run.records).toHaveLength(2);
    for (const entry of run.records) {
      expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
      expect(entry.payload.operation).toBe('import-commit');
      expect(entry.runId).toBe('process-exchange:import-commit');
    }
    expect(run.records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      resourceIds: ['specify', 'polish'],
      outcomes: ['imported'],
      counts: { imported: 2 }
    });
    expect(run.records[1]!.payload).toMatchObject({
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
  });

  it('records nothing for an ordinary catalog edit, which is not an exchange', async () => {
    // Feature 100 (T514) — the record used to be keyed on the layer save's mutation
    // intent, and the intent is gone: a publication of `CMD_PUBLISH_PACKAGE` IS an
    // import commit, because the Builder's own writes are per-definition commands.
    // This is that path, and it records itself through the lifecycle family — a
    // handler that audited every write would turn the exchange log into a second
    // copy of the catalog's history.
    const inst = installation();
    const audits = await editOneDefinition(
      inst,
      { kind: 'phase', id: 'specify' },
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' }
    );

    expect(exchangeAudits(audits)).toEqual([]);
    // The sink was wired, so the absence above is an absence of records rather
    // than an absence of auditing.
    expect(audits.map((entry) => entry.eventType)).toEqual(['definition-published']);
  });
});

// ---------------------------------------------------------------------------
// FR-060 — none of the document's own text reaches the log
// ---------------------------------------------------------------------------

describe('Feature 085 T064 — the log records the operation, not the package (FR-060)', () => {
  it('carries no authored text out of an export, though the document held all of it', async () => {
    const inst = installation({ phases: [...STORED_PHASES], pipelines: [STORED_PIPELINE] });
    const run = await exportPipeline(inst, 'include-referenced');

    // The document itself proves the tokens were reachable — otherwise the
    // absences below would say nothing at all.
    const text = run.saved[0]!.text;
    for (const token of Object.values(TOKENS)) {
      expect(text, `${token} must be in the document for its absence to mean anything`).toContain(
        token
      );
    }

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
  });

  it('carries no authored text out of a refusal, and no refusal message', async () => {
    // A document that declares a name, an instruction, and a skill and is still
    // refused, so the refusal path has content available to leak.
    const refused = PLANTED_PACKAGE.replace('apiVersion: schegent/v1', 'apiVersion: schegent/v2');
    const run = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(refused, 'utf8'))
    });

    expect(run.result.outcome).toBe('refused');
    if (run.result.outcome !== 'refused') throw new Error('unreachable');
    const message = run.result.refusal.message;
    expect(message.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
    // The operator sees the message; the log sees the code. A message quotes
    // what the document declared, which is exactly what FR-060 excludes.
    expect(serialized).not.toContain(message);
  });

  it('carries no authored text out of a commit, though every row held some', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    // The rows that landed prove the tokens were in scope at commit time.
    expect(JSON.stringify(inst.store.rowsOf('phase'))).toContain(TOKENS.instruction);
    expect(JSON.stringify(inst.store.rowsOf('pipeline'))).toContain(TOKENS.portLabel);

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
  });

  it('records the workspace basename but never the root', async () => {
    // Feature 099 (T496f, FR-046) — this denied `pipelineOverrides` to make a
    // trust record appear, and that capability is deleted. `phases` is the
    // surviving capability whose denial writes the payload this case reads, so
    // the record under test is produced the same way by a gate that still exists.
    capabilities.set('phases', false);
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    const serialized = JSON.stringify(run.audits);
    // Feature 059 I-6: the basename is the deliberate disclosure.
    expect(serialized).toContain('checkout');
    expect(serialized).not.toContain(WORKSPACE_ROOT);
    expect(serialized).not.toContain('PKG-ROOT-TOKEN-Q9');
  });

  it('draws every recorded outcome from a closed vocabulary, never document text', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const committed = await commitPackage(inst, plan);
    const partialInst = installation();
    const partialPlan = await planFor(partialInst, PLANTED_PACKAGE);
    const partial = await commitPackage(partialInst, partialPlan, {
      failOn: { key: 'pipelines', pass: 'publish' }
    });
    const refused = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_PIPELINE, 'utf8'))
    });

    const recorded = [...committed.records, ...partial.records, ...refused.audits].flatMap(
      (entry) => entry.payload.outcomes as readonly string[]
    );
    expect(recorded.length).toBeGreaterThan(0);
    for (const outcome of recorded) {
      expect(
        [
          'imported',
          'package-partial',
          'stale-catalog',
          'persistence-failed',
          'validation-failed',
          'disallowed-syntax',
          'duplicate-id'
        ],
        `${outcome} must be a literal this build chose`
      ).toContain(outcome);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-061 — six states, told apart after the fact
// ---------------------------------------------------------------------------

describe('Feature 085 T064 — refused, blocked, stale, committed, partial, and never (FR-061)', () => {
  it('records a refused document as a refusal', async () => {
    const run = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_DOCUMENT, 'utf8'))
    });
    expect(run.audits).toHaveLength(1);
    expect(run.audits[0]!.eventType).toBe('process-exchange-import-refused');
    expect(run.audits[0]!.runId).toBe('process-exchange:import-preflight');
    expect(run.audits[0]!.payload.outcomes).toEqual(['unsupported-kind']);
  });

  it('records a stale-write refusal on every confirmed layer, so it is not silence', async () => {
    // The operator confirmed a plan computed against a catalog that has since
    // moved. Nothing is written, and the reason the write did not happen is
    // exactly what a later reconstruction needs — an unaudited stale rejection
    // is indistinguishable from an operator who closed the dialog.
    //
    // Feature 100 (T514, FR-036) — staleness is asked of every declared layer
    // before anything is written, so a stale Phase layer refuses the WHOLE
    // package: the Pipeline layer records that it did not land either, and the
    // written prefix this case used to assert does not exist.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, { revisions: { phase: 'moved-on' } });

    expect(run.ack.reason).toBe('stale-catalog');
    expect(writesOf(inst.store)).toEqual(NO_WRITES);

    expect(run.records).toHaveLength(2);
    for (const entry of run.records) {
      expect(entry.eventType).toBe('process-exchange-import-refused');
      expect(entry.outcome).toBe('failure');
      expect(entry.payload).toMatchObject({
        operation: 'import-commit',
        outcomes: ['stale-catalog'],
        counts: { refused: 1 }
      });
    }
    expect(recordedKinds(run.records)).toEqual([
      ['phase', ['stale-catalog']],
      ['pipeline', ['stale-catalog']]
    ]);
  });

  it('records a capability denial as a denial, not as an exchange', async () => {
    capabilities.set('phases', false);
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    expect(run.ack.reason).toBe('trust-denied');
    expect(writesOf(inst.store)).toEqual(NO_WRITES);
    const denials = run.audits.filter((entry) => entry.eventType === 'trust.capability-denied');
    expect(denials).toHaveLength(1);
    // A denial is a different decision, taken at a different time, about a
    // different thing — so it keeps its own event type (084's rule, unchanged).
    expect(run.records).toEqual([]);
  });

  it('records a partial outcome as two records that disagree', async () => {
    // The Phase layer lands and the Pipeline layer does not (FR-042a). This is
    // the state the catalog itself cannot describe: a workspace holding two
    // Phases and no Pipeline is indistinguishable from one where the operator
    // imported the Phases alone.
    //
    // Feature 100 (T514) — the failure is in pass 2, which is what makes the two
    // records disagree: both layers were drafted, the Phase layer published, and
    // the Pipeline layer stayed a draft.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, {
      failOn: { key: 'pipelines', pass: 'publish' }
    });

    expect(run.ack.reason).toBe('package-partial');
    expect(inst.store.rowsOf('phase')).toHaveLength(2);
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
    // Not deleted — drafted and waiting, which is what the operator re-runs into.
    expect(inst.store.draftRowsOf('pipeline')).toHaveLength(1);

    expect(run.records).toHaveLength(2);
    expect(run.records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      outcomes: ['imported'],
      counts: { imported: 2 }
    });
    expect(run.records[0]!.outcome).toBe('info');
    expect(run.records[1]!.payload).toMatchObject({
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      outcomes: ['package-partial'],
      counts: { refused: 1 }
    });
    expect(run.records[1]!.outcome).toBe('failure');
  });

  it('records the pass-1 partial as two refusals, because nothing became live', async () => {
    // The other partial shape, which only exists from feature 100 on: the draft
    // pass stopped, so the Phase layer is written and waiting while nothing is
    // triggerable. Both records are failures — as an IMPORT neither kind landed —
    // and the ack is where the two are told apart.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, { failOn: { key: 'pipelines', pass: 'draft' } });

    expect(run.ack.reason).toBe('package-partial');
    expect(run.ack.result).toMatchObject({
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'pipeline',
      cause: 'not-writable'
    });
    expect(inst.store.rowsOf('phase')).toEqual([]);
    expect(inst.store.draftRowsOf('phase')).toHaveLength(2);

    expect(recordedKinds(run.records)).toEqual([
      ['phase', ['package-partial']],
      ['pipeline', ['package-partial']]
    ]);
    expect(run.records.map((entry) => entry.outcome)).toEqual(['failure', 'failure']);
  });

  it('records a blocked root as an import of what was eligible, and no more', async () => {
    // The root references a Phase nothing supplies, so only the included Phase
    // is written (FR-039). The log says a Phase landed and no Pipeline did,
    // which is the difference between "blocked" and "the Pipeline write failed":
    // a kind the request never carried records nothing at all.
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts.blocked).toBe(1);

    const run = await commitPackage(inst, plan);
    expect(run.records).toHaveLength(1);
    expect(run.records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      resourceIds: ['specify'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
  });

  it('records nothing when the operator closes the dialog', async () => {
    const run = await preflight(installation(), { outcome: 'canceled' });
    expect(run.result).toEqual({ outcome: 'canceled' });
    expect(run.audits).toEqual([]);
  });

  it('records nothing for a plan, because a plan changes nothing', async () => {
    const run = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(PLANTED_PACKAGE, 'utf8'))
    });
    expect(run.result.outcome).toBe('planned');
    expect(run.audits).toEqual([]);
  });

  it('tells the six states apart by event type and outcome together', async () => {
    // The point of the whole file, stated once: every state above produces a
    // distinct (eventType, resourceKind, outcomes) triple, or no record at all.
    const seen = new Set<string>();
    const record = (entry: AuditEntry) =>
      seen.add(
        `${entry.eventType}/${entry.payload.resourceKind}/${(entry.payload.outcomes as readonly string[]).join(',')}`
      );

    const refusedRun = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_PIPELINE, 'utf8'))
    });
    refusedRun.audits.forEach(record);

    const staleInst = installation();
    const stalePlan = await planFor(staleInst, PLANTED_PACKAGE);
    const staleRun = await commitPackage(staleInst, stalePlan, {
      revisions: { phase: 'moved-on' }
    });
    staleRun.records.forEach(record);

    const okInst = installation();
    const okPlan = await planFor(okInst, PLANTED_PACKAGE);
    const okRun = await commitPackage(okInst, okPlan);
    okRun.records.forEach(record);

    const partialInst = installation();
    const partialPlan = await planFor(partialInst, PLANTED_PACKAGE);
    const partialRun = await commitPackage(partialInst, partialPlan, {
      failOn: { key: 'pipelines', pass: 'publish' }
    });
    partialRun.records.forEach(record);

    expect([...seen].sort()).toEqual([
      'process-exchange-import-committed/phase/imported',
      'process-exchange-import-committed/pipeline/imported',
      'process-exchange-import-refused/phase/stale-catalog',
      'process-exchange-import-refused/pipeline/duplicate-id',
      'process-exchange-import-refused/pipeline/package-partial',
      'process-exchange-import-refused/pipeline/stale-catalog'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Feature 086 T052 — the third layer records itself the same way (FR-054)
// ---------------------------------------------------------------------------
//
// 085 established that a package writing two catalog layers needs its own record,
// because a partial write leaves a catalog that cannot describe what the operator
// asked for. A Workflow package writes three, so there is one more record and one
// more partial shape — and, deliberately, nothing else: the same envelope, the
// same two event types, the same `AUDIT_SCHEMA_VERSION`.
//
// The tokens are planted in every authored slot a Workflow adds over a Pipeline:
// its name, its description, a node label, and a condition's right-hand literal.
// The last is the interesting one — a condition is structured data, and its
// literal is the only place inside it that an operator's own words appear.

const WORKFLOW_TOKENS = {
  workflowName: 'WF-NAME-TOKEN-R1',
  workflowDescription: 'WF-DESC-TOKEN-R2',
  nodeLabel: 'NODE-LABEL-TOKEN-R3',
  conditionLiteral: 'COND-LITERAL-TOKEN-R4'
} as const;

const FORBIDDEN_WORKFLOW_TOKENS = [
  ...Object.values(WORKFLOW_TOKENS),
  ...Object.values(TOKENS),
  WORKSPACE_ROOT,
  'PKG-ROOT-TOKEN-Q9',
  'ship-it-flow.workflow.yaml'
] as const;

/**
 * A self-contained three-layer package with a token in every slot a Workflow
 * authors. `spec-authoring`, `spec-review`, and `specify` are free ids.
 *
 * `spec-authoring` declares a `structured-data` output alongside its markdown
 * one because a `node-output` condition operand may only read a field from a
 * structured output port (FR-022). Drop it and the row turns `invalid`, so the
 * third write never happens and the record under test never appears.
 */
const PLANTED_WORKFLOW_PACKAGE = [
  'apiVersion: schegent/v1',
  'kind: Workflow',
  'metadata:',
  '  id: ship-it-flow',
  `  name: ${WORKFLOW_TOKENS.workflowName}`,
  `  description: ${WORKFLOW_TOKENS.workflowDescription}`,
  '  version: 3',
  'spec:',
  '  nodes:',
  '    - nodeId: draft',
  '      pipelineId: spec-authoring',
  `      label: ${WORKFLOW_TOKENS.nodeLabel}`,
  '    - nodeId: review',
  '      pipelineId: spec-review',
  '  connections:',
  '    - from:',
  '        nodeId: draft',
  '        portId: spec-document',
  '      to:',
  '        nodeId: review',
  '        portId: spec',
  '      condition:',
  '        left:',
  '          source: node-output',
  '          nodeId: draft',
  '          field: verdict',
  '        operator: equals',
  `        right: ${WORKFLOW_TOKENS.conditionLiteral}`,
  '  startNodeIds:',
  '    - draft',
  'included:',
  '  pipelines:',
  '    - metadata:',
  '        id: spec-authoring',
  `        name: ${TOKENS.pipelineName}`,
  '        version: 2',
  '      spec:',
  '        phaseIds:',
  '          - specify',
  '        outputs:',
  '          - portId: spec-document',
  `            label: ${TOKENS.portLabel}`,
  '            type: markdown',
  '          - portId: verdict',
  '            label: Verdict',
  '            type: structured-data',
  '    - metadata:',
  '        id: spec-review',
  '        name: Spec Review',
  '        version: 1',
  '      spec:',
  '        phaseIds:',
  '          - specify',
  '        inputs:',
  '          - portId: spec',
  `            label: ${TOKENS.portDescription}`,
  '            type: text',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  `        instruction: ${TOKENS.instruction} and a planted ${TOKENS.secret}`,
  `        retryCondition: ${TOKENS.retryCondition}`,
  ''
].join('\n');

describe('Feature 086 T052 — the Workflow write records itself through the existing envelope (FR-054)', () => {
  it('bounds all three catalog writes to the same five fields, naming the third kind', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const run = await commitPackage(inst, plan);

    expect(run.ack.status).toBe('accepted');
    expect(run.ack.result).toEqual({
      published: [
        { kind: 'phase', ids: ['specify'], total: 1 },
        { kind: 'pipeline', ids: ['spec-authoring', 'spec-review'], total: 2 },
        { kind: 'workflow', ids: ['ship-it-flow'], total: 1 }
      ]
    });

    // One per catalog written. Three, not one — the three writes can succeed
    // independently, so one record describing "the import" would be a record of
    // something that never happens as a unit.
    expect(run.records).toHaveLength(3);
    for (const entry of run.records) {
      expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
      expect(entry.payload.operation).toBe('import-commit');
      expect(entry.runId).toBe('process-exchange:import-commit');
    }
    expect(run.records.map((entry) => entry.payload.resourceKind)).toEqual([
      'phase',
      'pipeline',
      'workflow'
    ]);
    expect(run.records[2]!.payload).toMatchObject({
      resourceKind: 'workflow',
      resourceIds: ['ship-it-flow'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
    expect(run.records[2]!.outcome).toBe('info');
  });

  it('carries no authored text out of the Workflow write, though every slot held some', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const run = await commitPackage(inst, plan);

    // The definitions landed, so the tokens were genuinely carried through the
    // path that produced these records — the absence below is not the absence of
    // the data itself.
    expect(inst.store.rowsOf('workflow')).toHaveLength(1);
    const serialized = JSON.stringify(run.records);
    expect(serialized.length).toBeGreaterThan(100);
    for (const token of FORBIDDEN_WORKFLOW_TOKENS) {
      expect(serialized).not.toContain(token);
    }
    // The ids are the only document-derived strings in the log, and they are
    // identifiers the format already bounds, not prose.
    expect(serialized).toContain('ship-it-flow');
  });

  it('records the third partial shape as three records, the last a failure (FR-054)', async () => {
    // data-model.md §5.3's second shape: Phases and Pipelines landed, the Workflow
    // did not. Without the third record this is indistinguishable in the log from
    // a package that only ever declared two kinds.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const run = await commitPackage(inst, plan, { failOn: { key: 'workflows', pass: 'publish' } });

    expect(inst.store.rowsOf('phase')).toHaveLength(1);
    expect(inst.store.rowsOf('pipeline')).toHaveLength(2);
    expect(inst.store.rowsOf('workflow')).toEqual([]);
    // Written, not deleted: re-running the document completes it (FR-038, FR-039).
    expect(inst.store.draftRowsOf('workflow')).toHaveLength(1);

    expect(run.records).toHaveLength(3);
    expect(run.records.slice(0, 2).map((entry) => entry.outcome)).toEqual(['info', 'info']);
    expect(run.records[2]!.payload).toMatchObject({
      resourceKind: 'workflow',
      resourceIds: ['ship-it-flow'],
      outcomes: ['package-partial'],
      counts: { refused: 1 }
    });
    expect(run.records[2]!.outcome).toBe('failure');
  });

  it('records a stale Workflow layer as a refusal of the whole package', async () => {
    // Feature 100 (T514, FR-036) — the Workflow layer moving under the operator
    // used to strand two written layers and record one refusal. Every layer is
    // asked before anything is written now, so the record is three refusals and
    // the store is untouched — a strengthening, and the reason the case's title
    // no longer says "so it is not silence": it says which silence was avoided.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const run = await commitPackage(inst, plan, { revisions: { workflow: 'moved-on' } });

    expect(run.ack.reason).toBe('stale-catalog');
    expect(run.ack.result).toMatchObject({ kind: 'workflow' });
    expect(writesOf(inst.store)).toEqual(NO_WRITES);

    expect(recordedKinds(run.records)).toEqual([
      ['phase', ['stale-catalog']],
      ['pipeline', ['stale-catalog']],
      ['workflow', ['stale-catalog']]
    ]);
    expect(run.records.map((entry) => entry.outcome)).toEqual([
      'failure',
      'failure',
      'failure'
    ]);
  });

  it('records nothing for an ordinary Workflow edit, which is not an exchange', async () => {
    // Same rule as the package path's own: the exchange record belongs to the
    // import, and a per-definition operation records itself through the lifecycle
    // family instead.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    // Land all three kinds so the edit reaches the same gates a real one would.
    const imported = await commitPackage(inst, plan);
    expect(imported.ack.status).toBe('accepted');

    const stored = inst.store.rowsOf('workflow')[0] as Record<string, unknown>;
    const audits = await editOneDefinition(
      inst,
      { kind: 'workflow', id: 'ship-it-flow' },
      { ...stored, name: 'Renamed Flow' }
    );

    expect(exchangeAudits(audits)).toEqual([]);
    expect(audits.map((entry) => entry.eventType)).toEqual(['definition-published']);
  });

  it('adds no event type and needs no schema bump', async () => {
    // The whole claim of T079, asserted rather than inferred. The third catalog is
    // one more record of an existing kind, so nothing about the persisted shape
    // changes and no reader needs to learn a new name.
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
    expect([...PROCESS_EXCHANGE_EVENT_TYPES]).toEqual([
      'process-exchange-export',
      'process-exchange-import-refused',
      'process-exchange-import-committed'
    ]);

    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const run = await commitPackage(inst, plan);
    // Every record the three-kind write produced is one of the two 085 declared.
    for (const entry of run.records) {
      expect(['process-exchange-import-committed', 'process-exchange-import-refused']).toContain(
        entry.eventType
      );
      expect(ALL_AUDIT_EVENT_TYPES as readonly string[]).toContain(entry.eventType);
    }
  });

  it('records all three kinds in dependency order, never a reordering', async () => {
    // The log's order is the write order, which is the dependency order. A record
    // sequence that put the Workflow first would describe an import that could not
    // have resolved.
    //
    // Feature 099 (T496f) — this committed to the `user` layer deliberately, to
    // show the order does not depend on where the write lands. With one catalog
    // per kind there is no second destination to vary.
    //
    // Feature 100 (T514, FR-035) — and the order is no longer the caller's to get
    // right either, so the layers are sent BACKWARDS. Both the log and the store
    // still read Phases-first: the ordering is the host's property, not a habit of
    // the webview's that a second caller could break.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_WORKFLOW_PACKAGE);
    const forwards = packageCommand(plan);
    const backwards: PublishPackageCommand = {
      ...forwards,
      payload: { layers: [...forwards.payload.layers].reverse() }
    };
    expect(backwards.payload.layers.map((layer) => layer.kind)).toEqual([
      'workflow',
      'pipeline',
      'phase'
    ]);

    const run = await commitPackage(inst, plan, { command: backwards });

    expect(run.records.map((entry) => entry.payload.resourceKind)).toEqual([
      'phase',
      'pipeline',
      'workflow'
    ]);
    expect(inst.store.publishLayers.map((request) => request.kind)).toEqual(
      LAYER_ORDER.map((key) => KIND_OF[key])
    );
  });
});
