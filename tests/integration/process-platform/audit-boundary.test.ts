// Feature 089 (T036-T038, US6, FR-033 - FR-037, SC-007) — what the process
// platform is allowed to write down about itself.
//
// The five operations of the parity suite are driven again here, but nothing
// about their *answers* is asserted. What is asserted is the trail they leave:
// which structured audit events each one emits, what those events may carry, and
// what they may never carry. The parity suite proves the two adapters agree; this
// one proves that what they agree on is safe to persist.
//
// **The emission map, stated once so the zeros below are claims and not gaps.**
//
//   preview     one `process-exchange-import-refused` per refused document, and
//               NOTHING for a document that plans — a plan is a proposal about a
//               file nobody has written yet, and recording every dialog the
//               operator opened would make the log a browsing history
//   import      one `process-exchange-import-committed` or `-refused` per LAYER
//               of a package publication, because a package can land in pieces
//               and the catalog alone can no longer say which pieces those were
//   export      one `process-exchange-export`, saved or unavailable
//   launch      nothing
//   continuation nothing
//
// The last two are the ones worth being explicit about. A run's audit trail
// begins downstream, at drain: `NodeRunStartDeps` declares no audit member, and
// neither `node-run-starter.ts` nor the router's mutation executor emits anything
// of its own. So "no event" is the specified behaviour, not an oversight — and it
// is asserted over a recorder proven live by an emitting command dispatched
// through the SAME dependency bag, because "the list is empty" is a claim any
// dead recorder satisfies.
//
// **Feature 100 (T514i, FR-052 - FR-054, SC-010) — a second family, and a second
// set of zeros.** The three layer saves that emitted the `import` line above are
// one `CMD_PUBLISH_PACKAGE`, so that line is unchanged in substance: the records
// are still per layer, emitted now by `catalog-lifecycle-commit.ts` rather than by
// three handlers. What is new is the per-definition lifecycle, whose emission map
// is its own:
//
//   save-draft      nothing
//   discard-draft   nothing
//   publish         one `definition-published`
//   deactivate      one `definition-deactivated`
//   restore         one `definition-restored`
//
// The two zeros are the requirement (FR-054), not an omission: an audit event per
// draft would turn the log into a keystroke record of an operator's unfinished
// work, and a draft is by construction the thing nobody has committed to. They are
// asserted the same way `launch` and `continuation` are — against a recorder proven
// live by the publish that follows through the same bag.
//
// The lifecycle payload is `{resourceKind, resourceId, versionId}`: a kind, an id,
// and a `v<N>`. It has no field a definition body, an operator's note, or a
// workspace root could ride out in, and the classifier below asserts that by
// exact key set rather than by reading the three fields it happens to have today.
//
// **Why the classification is written as a closed vocabulary rather than a field
// list.** FR-033 permits bounded identifiers, versions, statuses, outcomes,
// counts, and timestamps. A test that simply named the six fields
// `ProcessExchangePayload` has today would pass unchanged on the day a seventh is
// added carrying an instruction. So every leaf of every emitted event is run
// through a classifier that must place it in the permitted vocabulary, and the
// key sets are asserted for EXACT equality — a new field fails until someone
// classifies it deliberately. (Versions and timestamps are in the vocabulary and
// absent from these payloads: the writer mints `id` and `timestamp` downstream,
// past this seam.)
//
// **`outcomes` is the field where a leak would actually surface.** Its entries
// are refusal codes and save-gate rejection reasons — literals this build chose —
// while the operator-facing *message* beside them quotes what the document said.
// The two are one substitution apart. Asserting the shape of a build-chosen
// literal (lower-kebab, bounded) is what makes that substitution fail here rather
// than ship.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
// A real directory, because the launch and continuation gates probe the root
// before they accept. It is also the absolute path the canary scan looks for.
const workspaceRoot = vi.hoisted(() => ({ path: '/tmp/audit-boundary' }));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: workspaceRoot.path, scheme: 'file' },
    name: 'audit-boundary',
    index: 0
  })
}));

import { buildCatalog, type PhaseDef, type PipelineDef } from '../../../src/config/pipeline-config';
import { loadCatalog } from '../../../src/config/pipeline-config-loader';
import { PIPELINE_ID_MAX_LEN } from '../../../src/config/pipeline-definition-validator';
import { PHASE_ID_MAX_LEN } from '../../../src/config/process-definition-validator';
import { WORKFLOW_ID_MAX_LEN } from '../../../src/config/workflow-definition-validator';
import {
  CATALOG_LIFECYCLE_EVENT_TYPES,
  PROCESS_EXCHANGE_EVENT_TYPES
} from '../../../src/contracts/audit-events';
import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import type {
  PackagePublishOutcome,
  PackagePublishRequest,
  PackagePublishedLayer
} from '../../../src/contracts/catalog-lifecycle';
import type { RunRequest } from '../../../src/contracts/run-request';
import {
  CMD_CONTINUE_WORKFLOW,
  type CommandAckMessage,
  type ContinueWorkflowPayload,
  type ImportPlan,
  type PreflightProcessYamlResult,
  type SidebarCommand
} from '../../../src/contracts/sidebar-ipc';
import type { ExportProcessYamlRequest } from '../../../src/contracts/sidebar-ipc/process-yaml';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import {
  exportProcessDefinitions,
  importProcessDocument,
  previewProcessDocument,
  type ImportWritePort,
  type LayerSaveAck
} from '../../../src/headless/process-yaml-api';
import { launchPipelineRun } from '../../../src/headless/pipeline-run-api';
import { continueWorkflowRun } from '../../../src/headless/workflow-run-api';
import { parseAuditLogLineDetailed } from '../../../src/parser/audit-log-parser';
import { createConnectedRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import type { ContinuationDeps } from '../../../src/services/workflow-execution/continuation-service';
import {
  appendAttempt,
  appendDecision,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import { isNodeStartable, projectConnectedRun } from '../../../src/ui/sidebar/connected-run-projector';
import type { HandlerContext } from '../../../src/ui/sidebar/commands/handler-contract';
import { auditImportCommitted } from '../../../src/ui/sidebar/commands/process-exchange-commit-audit';
import { MessageRouter, type RouterDeps } from '../../../src/ui/sidebar/message-router';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_EXPORT_PROCESS_YAML,
  CMD_LAUNCH_PIPELINE,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_SAVE_MODELS
} from '../../../src/ui/sidebar/messages';
import { RecordingQueue, makeWorkspaceRoot, removeWorkspaceRoot, storedCatalog } from './run-harness';
import { FakeCatalogStore, tokenFor } from '../../fixtures/fake-catalog-store';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';

// ---------------------------------------------------------------------------
// The canaries
// ---------------------------------------------------------------------------
//
// Deliberately distinctive, because the scan in T037 is a substring search: a
// canary made of common words would either never match or match by accident, and
// neither outcome says anything. Each one is a different class of the thing
// FR-034 and FR-035 forbid, and each is planted somewhere a careless
// implementation would plausibly pick it up.

/** Operator-authored business content, in a Phase instruction (prompt text). */
const CANARY_INSTRUCTION =
  'Reconcile the Delta-Foxtrot-7719 escrow ledger before the quarterly attestation';
/** Operator-authored task text, in a definition name and a run input value. */
const CANARY_TASK = 'Quarterly Delta-Foxtrot-7719 Attestation';
/** A credential-shaped token, in the same instruction an operator might paste it into. */
const CANARY_SECRET = 'sk-live-9f3c2a7d41b8e05612d4c9ab7e3f10d8';
/** An absolute path an operator wrote by hand, distinct from the workspace root. */
const CANARY_PATH = '/Users/audit-canary-operator/ledger/private-notes.md';
/**
 * An operator's change note (feature 100, T514i).
 *
 * Its own canary rather than a reuse of the instruction, because it is a field
 * only the draft commands carry: `SaveDraftRequest.note` is what an operator
 * writes ABOUT a change, and a per-draft audit event is exactly where it would
 * have gone. A shared canary would still fail, but the failure would not say
 * which field leaked.
 */
const CANARY_NOTE = 'Delta-Foxtrot-7719 revision note for the escrow attestation';

const CANARY_TEXT = `${CANARY_INSTRUCTION} at ${CANARY_PATH} with key ${CANARY_SECRET}`;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------
//
// A three-layer Workflow package, so a confirmed import performs all three layer
// writes and the commit records cover every `resourceKind` the envelope admits.
// Every free-text field it has carries a canary.

const DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Workflow',
  'metadata:',
  '  id: audit-flow',
  `  name: ${CANARY_TASK}`,
  '  version: 1',
  'spec:',
  '  nodes:',
  '    - nodeId: draft',
  '      pipelineId: audit-authoring',
  '    - nodeId: review',
  '      pipelineId: audit-review',
  '  connections:',
  '    - from:',
  '        nodeId: draft',
  '        portId: report',
  '      to:',
  '        nodeId: review',
  '        portId: brief',
  '  startNodeIds:',
  '    - draft',
  'included:',
  '  pipelines:',
  '    - metadata:',
  '        id: audit-authoring',
  `        name: ${CANARY_TASK}`,
  '        version: 1',
  '      spec:',
  '        phaseIds:',
  '          - audit-specify',
  '        outputs:',
  '          - portId: report',
  `            label: ${CANARY_TASK}`,
  '            type: markdown',
  '    - metadata:',
  '        id: audit-review',
  '        name: Audit Review',
  '        version: 1',
  '      spec:',
  '        phaseIds:',
  '          - audit-specify',
  '        inputs:',
  '          - portId: brief',
  '            label: Brief',
  '            type: text',
  '  phases:',
  '    - metadata:',
  '        phaseId: audit-specify',
  `        name: ${CANARY_TASK}`,
  '        version: 1',
  '      spec:',
  `        instruction: ${CANARY_TEXT}`,
  ''
].join('\n');

/**
 * The same canaries in a document this build refuses.
 *
 * A flow sequence is `disallowed-syntax`, and the refusal names the offending
 * LINE in its operator-facing message — which is precisely the text that must not
 * reach the log. Refusing on the instruction line makes the preflight record the
 * one worth scanning.
 */
const REFUSED_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Phase',
  'metadata:',
  '  phaseId: audit-refused',
  `  name: ${CANARY_TASK}`,
  '  version: 1',
  'spec:',
  `  instruction: [${CANARY_TEXT}]`,
  ''
].join('\n');

// ---------------------------------------------------------------------------
// The fixture: one configuration store, one live audit recorder
// ---------------------------------------------------------------------------

/**
 * Feature 099 (T496f, FR-042) — this was three `{ user, workspace }` layers the
 * handlers wrote through `updateConfig`. Definitions live in one store per kind
 * now, so the store IS the fixture; which layer held a row was never something
 * this file asserted, and nothing below reads a layer name.
 */
type Store = FakeCatalogStore;

function makeStore(): Store {
  return new FakeCatalogStore();
}

/** The envelope as it crosses `RouterDeps['audit'].append`, before the writer mints id and timestamp. */
interface AuditEnvelope {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly correlationId?: string;
}

interface Recorder {
  readonly events: AuditEnvelope[];
  readonly port: { append(entry: AuditEnvelope): Promise<void> };
}

function auditRecorder(): Recorder {
  const events: AuditEnvelope[] = [];
  return {
    events,
    port: {
      append: async (entry: AuditEnvelope) => {
        events.push(entry);
      }
    }
  };
}

/**
 * The dependency bag every surface below reads through.
 *
 * `logger.sanitize` is the identity here on purpose. The redaction set is real
 * and is tested where it lives; substituting a stub that scrubbed the canaries
 * would make every assertion below pass for the wrong reason — the claim is that
 * the *envelope has nowhere to put them*, not that a filter caught them.
 */
function depsFor(store: Store, audit: Recorder, bytes?: Uint8Array): RouterDeps {
  return {
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') }),
    readPipelineConfig: () => ({
      rows: store.rowsOf('pipeline'),
      revision: store.revisionOf('pipeline')
    }),
    readWorkflowConfig: () => ({
      rows: store.rowsOf('workflow'),
      revision: store.revisionOf('workflow')
    }),
    ...(bytes !== undefined
      ? { openProcessYamlDocument: async () => ({ outcome: 'read' as const, bytes }) }
      : {}),
    // Feature 099 (T496f, FR-042a) — the save handlers wrote through
    // `updateConfig(key, value, scope)`; they write through the store now, and
    // the fixture holds one rather than reimplementing it. `refreshCatalog` is a
    // no-op because nothing here reads the resolved catalog back: the claim is
    // about what the audit envelope carries, not about what the surface is shown.
    //
    // Feature 100 (T514i) — the store alone is no longer enough. A lifecycle
    // command is a read, a decision, and a gated write, and the handlers reach
    // the middle step through `catalogLifecycle`; a bag without one acks
    // `config-ops-unavailable` and emits nothing, which is the one way this file
    // could pass for the wrong reason. It is the REAL service over the fake
    // store, so every event below is emitted by the shipped commit path.
    catalogStore: store,
    catalogLifecycle: fakeCatalogLifecycle(store),
    refreshCatalog: async () => undefined,
    executeCommand: vi.fn(),
    queueRemover: { remove: vi.fn() },
    isPrimary: () => true,
    isTrusted: () => true,
    audit: audit.port,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (value: string) => value
    }
  } as unknown as RouterDeps;
}

let dispatched = 0;

/** One command through the real router. A fresh correlation id, or the executor replays the last ack. */
async function dispatch(
  deps: RouterDeps,
  type: string,
  payload: unknown
): Promise<CommandAckMessage> {
  dispatched += 1;
  const acks: CommandAckMessage[] = [];
  await new MessageRouter(deps).dispatch(
    { type, correlationId: `audit-${dispatched}-${type}`, payload: payload ?? {} } as unknown as SidebarCommand,
    async (message) => {
      acks.push(message);
      return true;
    }
  );
  const ack = acks[0];
  expect(ack, `no ack for ${type}`).toBeDefined();
  return ack!;
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------------------
// The five operations
// ---------------------------------------------------------------------------

interface Emission {
  readonly label: string;
  readonly events: readonly AuditEnvelope[];
}

/** Preview, both adapters: the planned document (silent) and the refused one (recorded). */
async function drivePreview(): Promise<readonly Emission[]> {
  const planned = auditRecorder();
  const plannedStore = makeStore();
  const headlessPlanned = await previewProcessDocument(depsFor(plannedStore, planned), {
    bytes: bytesOf(DOCUMENT)
  });
  expect(
    (headlessPlanned as PreflightProcessYamlResult).outcome,
    `document did not plan: ${JSON.stringify(headlessPlanned)}`
  ).toBe('planned');
  await dispatch(depsFor(plannedStore, planned, bytesOf(DOCUMENT)), CMD_PREFLIGHT_PROCESS_YAML, {});

  const refused = auditRecorder();
  const refusedStore = makeStore();
  const headlessRefused = await previewProcessDocument(depsFor(refusedStore, refused), {
    bytes: bytesOf(REFUSED_DOCUMENT)
  });
  expect(
    (headlessRefused as PreflightProcessYamlResult).outcome,
    `refusal fixture planned instead: ${JSON.stringify(headlessRefused)}`
  ).toBe('refused');
  await dispatch(
    depsFor(refusedStore, refused, bytesOf(REFUSED_DOCUMENT)),
    CMD_PREFLIGHT_PROCESS_YAML,
    {}
  );

  return [
    { label: 'preview planned', events: planned.events },
    { label: 'preview refused', events: refused.events }
  ];
}

/** The plan the import cases confirm, computed once against an empty store. */
async function planFor(store: Store, audit: Recorder): Promise<ImportPlan> {
  const result = await previewProcessDocument(depsFor(store, audit), { bytes: bytesOf(DOCUMENT) });
  const preflight = result as PreflightProcessYamlResult;
  if (preflight.outcome !== 'planned') {
    throw new Error(`preview did not plan: ${JSON.stringify(preflight)}`);
  }
  return preflight.plan;
}

/**
 * The write port `importProcessDocument` takes, wired to the real router.
 *
 * Feature 100 (T514i) — this was three `CMD_SAVE_*` sends and is one
 * `CMD_PUBLISH_PACKAGE`. It is still the router rather than a stub, for the
 * original reason: the commit records are emitted by the handler behind it, and a
 * stubbed port would record nothing at all. `saveModels` is untouched — the Model
 * Catalog is the one catalog still written through configuration.
 *
 * The ack is read back as an outcome because `ImportWritePort` speaks outcomes
 * while the router speaks acks; in production the automation adapter holds
 * `lifecycle.publishPackage` directly and never crosses this seam. Only the
 * accepted arm is reconstructed in any detail. A refusal is reported as one so
 * the fixture's own outcome assertion fails loudly, and it is deliberately NOT
 * where the refusal arm below is observed — that one is dispatched through the
 * router directly, so the reason the log records is the handler's own.
 */
function packageWritePort(deps: RouterDeps): ImportWritePort {
  return {
    publishPackage: async (request: PackagePublishRequest): Promise<PackagePublishOutcome> => {
      const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, request);
      if (ack.status !== 'accepted') {
        return {
          outcome: 'refused',
          refusal: { reason: 'store-refused', kind: null, defects: [], storeReason: ack.reason }
        };
      }
      const result = ack.result as { readonly published: readonly PackagePublishedLayer[] };
      return { outcome: 'published', published: result.published, pruned: [] };
    },
    saveModels: async (payload): Promise<LayerSaveAck> => {
      const ack = await dispatch(deps, CMD_SAVE_MODELS, payload);
      return ack.status === 'accepted'
        ? { status: 'accepted', result: ack.result }
        : { status: 'rejected', reason: ack.reason ?? 'unknown', result: ack.result };
    }
  };
}

/**
 * Import, through the real publication handler.
 *
 * One command now covers all three layers, and the per-layer records come from
 * `commitPackagePublish` walking the layers the request declared in rank order —
 * which is why the committed assertion below is still a per-kind list.
 */
async function driveImport(): Promise<readonly Emission[]> {
  const committed = auditRecorder();
  const store = makeStore();
  const deps = depsFor(store, committed);
  const plan = await planFor(store, committed);
  const imported = await importProcessDocument(packageWritePort(deps), { plan });
  expect(imported.outcome, `import fixture failed: ${JSON.stringify(imported)}`).toBe('imported');

  // A refused layer write, so the `-refused` commit arm is covered too. The
  // revision is stale by construction: the store now holds the Phase the import
  // above wrote, so the revision the plan was computed against is gone.
  //
  // Feature 099 (T496f, FR-042) — that used to be spelled `expectedRevision: 0`,
  // a number no layer revision could equal. A revision is an opaque string the
  // store mints, so staleness is spelled as a revision the store never minted.
  //
  // Feature 100 (T514i) — one layer, not the whole document, because the request
  // shape decides how many records a refusal writes: `commitPackagePublish`
  // reports every confirmed layer, so a three-layer request would record three
  // refusals and say nothing more than one does.
  const refused = auditRecorder();
  const refusedDeps = depsFor(store, refused);
  const ack = await dispatch(refusedDeps, CMD_PUBLISH_PACKAGE, {
    layers: [
      {
        kind: 'phase',
        expectedRevision: 'rev-phase-never-minted',
        definitions: [{ id: 'audit-specify', body: { id: 'audit-specify' } }]
      }
    ]
  });
  expect(ack.status, 'stale publication was accepted').toBe('rejected');

  return [
    { label: 'import committed', events: committed.events },
    { label: 'import refused', events: refused.events },
    { label: 'import store', events: [] }
  ];
}

/** Export, both adapters, both outcomes. */
async function driveExport(): Promise<readonly Emission[]> {
  const setup = auditRecorder();
  const store = makeStore();
  const deps = depsFor(store, setup);
  const plan = await planFor(store, setup);
  const imported = await importProcessDocument(packageWritePort(deps), { plan });
  expect(imported.outcome, 'export fixture failed to import').toBe('imported');

  const selection: ExportProcessYamlRequest = {
    resourceKind: 'workflow',
    resourceId: 'audit-flow',
    inclusion: 'include-pipelines'
  };

  const saved = auditRecorder();
  const headlessSaved = await exportProcessDefinitions(depsFor(store, saved), { selection });
  expect(
    (headlessSaved as { outcome: string }).outcome,
    `export did not serialize: ${JSON.stringify(headlessSaved)}`
  ).toBe('serialized');
  const savedDeps = {
    ...(depsFor(store, saved) as unknown as Record<string, unknown>),
    saveProcessYamlDocument: async () => ({ outcome: 'saved' as const })
  } as unknown as RouterDeps;
  await dispatch(savedDeps, CMD_EXPORT_PROCESS_YAML, selection);

  const unavailable = auditRecorder();
  await exportProcessDefinitions(depsFor(store, unavailable), {
    selection: { resourceKind: 'phase', resourceId: 'no-such-phase' }
  });

  return [
    { label: 'export saved', events: saved.events },
    { label: 'export unavailable', events: unavailable.events }
  ];
}

// -- The per-definition lifecycle (T514i) -----------------------------------

const LIFECYCLE_ID = 'audit-lifecycle-phase';

/** Every free-text field a Phase has, carrying a canary. */
function lifecyclePhaseBody(instruction: string): Record<string, unknown> {
  return { id: LIFECYCLE_ID, name: CANARY_TASK, version: 1, instruction };
}

/** One operation that must have recorded nothing, and what the log held when it ran. */
interface SilentOperation {
  readonly operation: string;
  readonly events: number;
  /** Pointer moves so far — what the log legitimately held at that moment. */
  readonly moves: number;
}

interface LifecycleTrail {
  readonly emission: Emission;
  readonly silent: readonly SilentOperation[];
  /**
   * One entry per pointer move, in order, taken from the ACK rather than
   * restated here — so the claim is "the record names the version the operator
   * was told about" rather than "the record names v2".
   */
  readonly expected: readonly { readonly eventType: string; readonly versionId: string }[];
}

/**
 * The five per-definition operations over one Phase, through the real handlers.
 *
 * Deliberately one recorder for the whole sequence rather than one per operation.
 * The two silent operations (FR-054) are the claim, and "the recorder is empty" is
 * satisfied by any dead port; run against a shared log, each zero is instead
 * "the log grew by nothing *while the publishes around it grew it*".
 *
 * The order is also the one that makes each event's version id distinguishable: two
 * publishes, so `definition-published` is not asserted against a single v1 that
 * every field of every event happens to equal.
 */
async function driveLifecycle(): Promise<LifecycleTrail> {
  const audit = auditRecorder();
  const store = makeStore();
  const deps = depsFor(store, audit);
  const silent: SilentOperation[] = [];
  const expected: { eventType: string; versionId: string }[] = [];

  /** The target, re-read each time: the token is what the last operation left. */
  const target = () => ({
    kind: 'phase' as const,
    id: LIFECYCLE_ID,
    expectedDraftVersion: tokenFor(store, 'phase', LIFECYCLE_ID)
  });
  const send = async (type: string, payload: Record<string, unknown>) => {
    const ack = await dispatch(deps, type, payload);
    expect(ack.status, `${type} was rejected: ${ack.reason}`).toBe('accepted');
    return (ack.result ?? {}) as Record<string, unknown>;
  };
  const silently = async (operation: string, type: string, payload: Record<string, unknown>) => {
    await send(type, payload);
    silent.push({ operation, events: audit.events.length, moves: expected.length });
  };

  // The first draft is written under the sentinel — there is no version to name yet.
  expect(target().expectedDraftVersion, 'the fixture store already holds this id').toBe(NO_DRAFT);
  await silently('save-draft (first)', CMD_SAVE_DEFINITION_DRAFT, {
    ...target(),
    body: lifecyclePhaseBody(CANARY_TEXT),
    note: CANARY_NOTE
  });

  const firstPublish = await send(CMD_PUBLISH_DEFINITION, target());
  expected.push({
    eventType: 'definition-published',
    versionId: String(firstPublish['activeVersionId'])
  });

  await silently('save-draft (edit)', CMD_SAVE_DEFINITION_DRAFT, {
    ...target(),
    body: lifecyclePhaseBody(`${CANARY_TEXT} (revised)`),
    note: CANARY_NOTE
  });

  const secondPublish = await send(CMD_PUBLISH_DEFINITION, target());
  expected.push({
    eventType: 'definition-published',
    versionId: String(secondPublish['activeVersionId'])
  });

  // Restore records the version restored FROM, not the draft it produced: the
  // source is the operator's selection and the only thing that tells two
  // restores of one definition apart.
  const restored = await send(CMD_RESTORE_DEFINITION_VERSION, {
    ...target(),
    fromVersionId: String(firstPublish['activeVersionId'])
  });
  expected.push({
    eventType: 'definition-restored',
    versionId: String(restored['fromVersionId'])
  });

  await silently('discard-draft', CMD_DISCARD_DEFINITION_DRAFT, target());

  // Deactivation records the version that stopped being live, which it retains as
  // the definition's draft rather than writing a new record (FR-024a).
  const deactivated = await send(CMD_DEACTIVATE_DEFINITION, target());
  expected.push({
    eventType: 'definition-deactivated',
    versionId: String(deactivated['draftVersionId'])
  });

  return { emission: { label: 'lifecycle', events: audit.events }, silent, expected };
}

// -- Launch -----------------------------------------------------------------

// Feature 098 (T080) — the Pipeline named `speckit-specify` and the reader
// supplied no Phases, because the built-in Phase layer resolved that id for free.
// It resolves nothing now, so the Pipeline quarantines, the catalog is empty and
// the launch is refused before it reaches the audit port this case is about. The
// Phase is authored here instead, in the same stored catalog the Pipeline that
// names it comes from (feature 099, T496f — there is no scope to share).
const LAUNCH_PHASE = Object.freeze({
  id: 'audit-launch-phase',
  name: 'Audit Launch Phase',
  version: 1,
  instruction: CANARY_TEXT
});

const LAUNCH_PIPELINE = Object.freeze({
  id: 'audit-launch',
  name: 'Audit Launch',
  phases: [LAUNCH_PHASE.id],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
});

const LAUNCH_CATALOG = loadCatalog(
  storedCatalog({ phases: [LAUNCH_PHASE], pipelines: [LAUNCH_PIPELINE] }),
  { getModels: () => undefined, getDefaultPipelineId: () => undefined }
).catalog;

function launchDeps(store: Store, audit: Recorder, queue: RecordingQueue): RouterDeps {
  return {
    ...(depsFor(store, audit) as unknown as Record<string, unknown>),
    guardedRun: queue,
    getCatalog: () => LAUNCH_CATALOG,
    defaultRunnerKind: 'claude'
  } as unknown as RouterDeps;
}

/** The request carries every canary a run request can carry. */
function launchRequest(): RunRequest {
  return {
    pipelineId: LAUNCH_PIPELINE.id,
    inputs: [],
    supplemental: [],
    outputs: [{ portId: 'report', target: 'out/report.md' }],
    instructions: CANARY_TEXT
  };
}

// -- Continuation -----------------------------------------------------------

// Feature 099 (T496f, FR-043) — each of the three carried `sourceScope:
// 'workspace'`. A resolved definition has no scope now; the field is deleted
// rather than defaulted, and nothing below ever read it.
const AUDIT_PHASE: PhaseDef = {
  id: 'audit-continue-phase',
  name: 'Audit Continue Phase',
  version: 1,
  instruction: CANARY_TEXT
};

const AUDIT_HEAD: PipelineDef = {
  id: 'audit-continue-head',
  name: 'Audit Continue Head',
  phases: [AUDIT_PHASE.id],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

const AUDIT_TAIL: PipelineDef = {
  id: 'audit-continue-tail',
  name: 'Audit Continue Tail',
  phases: [AUDIT_PHASE.id],
  inputs: [{ portId: 'seed', label: 'Seed', type: 'text', required: true }],
  outputs: []
};

const AUDIT_GRAPH: WorkflowDefinition = {
  workflowId: 'audit-continue',
  name: 'Audit Continue',
  version: 1,
  nodes: [
    { nodeId: 'first', pipelineId: AUDIT_HEAD.id },
    { nodeId: 'second', pipelineId: AUDIT_TAIL.id }
  ],
  connections: [{ from: { nodeId: 'first', portId: 'report' }, to: { nodeId: 'second', portId: 'seed' } }],
  startNodeIds: ['first']
};

const CONTINUE_RUN_ID = 'audit-continue-run';
const CONTINUE_STARTED_AT = 1_700_000_000_000;
/** Opened (1), one attempt on `first` (2), one decision (3). */
const CONTINUE_REVISION = 3;
const CONTINUE_NOW = 1_760_000_100_000;

function storedContinueRun(): ConnectedWorkflowRun {
  const snapshot = createConnectedRunSnapshot({
    connectedRunId: CONTINUE_RUN_ID,
    workflow: AUDIT_GRAPH,
    catalog: buildCatalog(
      [AUDIT_PHASE],
      [AUDIT_HEAD, AUDIT_TAIL],
      { claude: [], codex: [], agy: [] },
      AUDIT_HEAD.id
    ),
    startedAt: CONTINUE_STARTED_AT,
    defaultRunnerKind: 'claude'
  });
  if (snapshot.outcome !== 'created') {
    throw new Error(`fixture could not open a run: ${snapshot.reason}`);
  }
  const withAttempt = appendAttempt(snapshot.run, 'first', {
    queueItemId: 'child-1',
    startedAt: CONTINUE_STARTED_AT
  });
  return appendDecision(withAttempt, {
    nodeId: 'first',
    attemptIndex: 0,
    decidedAt: CONTINUE_STARTED_AT + 1_000,
    operands: [],
    connections: [{ index: 0, matched: true, isDefault: false }],
    defaultApplied: false,
    eligible: [0]
  });
}

function continuePayload(): ContinueWorkflowPayload {
  return {
    connectedRunId: CONTINUE_RUN_ID,
    expectedRevision: CONTINUE_REVISION,
    nodeId: 'second',
    request: {
      pipelineId: AUDIT_TAIL.id,
      inputs: [{ portId: 'seed', type: 'text', value: CANARY_TEXT }],
      supplemental: [],
      outputs: []
    }
  } as ContinueWorkflowPayload;
}

/**
 * The emitting command the two "nothing was recorded" cases prove their recorder
 * with (feature 100, T514i).
 *
 * A package publication rather than a per-definition one because it is a single
 * dispatch that records — the per-definition path needs a draft first, and the
 * draft is one of the operations that deliberately records nothing, so the
 * control would have been two commands the first of which proves nothing.
 */
function controlPackage(store: Store): PackagePublishRequest {
  return {
    layers: [
      {
        kind: 'phase',
        expectedRevision: store.revisionOf('phase'),
        definitions: [
          {
            id: 'audit-control',
            body: { id: 'audit-control', name: 'Audit Control', version: 1, instruction: 'Control.' }
          }
        ]
      }
    ]
  };
}

function continueDeps(store: Store, audit: Recorder, queue: RecordingQueue) {
  const current = storedContinueRun();
  const connectedRuns = {
    get: (connectedRunId: string) => (connectedRunId === current.connectedRunId ? current : null),
    compareAndSetConnectedRun: async (run: ConnectedWorkflowRun) => ({
      outcome: 'written' as const,
      run
    }),
    readChildState: () => 'completed' as const
  };
  return {
    ...(depsFor(store, audit) as unknown as Record<string, unknown>),
    guardedRun: queue,
    defaultRunnerKind: 'claude',
    connectedRuns
  } as unknown as RouterDeps & ContinuationDeps;
}

// ---------------------------------------------------------------------------
// The classifier (T036, FR-033)
// ---------------------------------------------------------------------------

const ENVELOPE_REQUIRED = ['runId', 'phase', 'iteration', 'eventType', 'payload', 'outcome'];
const ENVELOPE_OPTIONAL = ['correlationId'];
// Feature 099 (T490b, T496f, FR-043) — `scope` stood between `resourceIds` and
// `outcomes`, and is gone with the layer tier it named. Dropping it from this
// list is not a relaxation: the key set below is asserted for EXACT equality, so
// a build that still emitted `scope` fails here, and so would one that emitted a
// nulled-out stand-in for it.
const PAYLOAD_KEYS = ['operation', 'resourceKind', 'resourceIds', 'outcomes', 'counts'];

// Feature 100 (T514i, FR-053) — the second family's payload, whose key set is
// asserted for exact equality for the same reason: three fields today, and a
// fourth must be classified here before it can ship.
const LIFECYCLE_PAYLOAD_KEYS = ['resourceKind', 'resourceId', 'versionId'];

/** The two `phase` literals the families are partitioned by. */
const EXCHANGE_PHASE = 'process-exchange';
const LIFECYCLE_PHASE = 'catalog-lifecycle';

/** The catalogs' own identifier bound. See T038 for why there is no second one. */
const ID_MAX = 64;
const IDS_MAX = 20;
const CORRELATION_ID_MAX = 128;
const RUN_ID_PREFIX = `${EXCHANGE_PHASE}:`;
/** A store-minted version id, and a shape no operator-authored text satisfies. */
const VERSION_ID = /^v[1-9][0-9]*$/;

/**
 * A literal this build chose: lower-kebab, bounded, no whitespace. Any quoted
 * document text, any operator message, any sentence fails it on the first space.
 */
const BUILD_LITERAL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A count's key, which is camelCase rather than kebab (`includedPhases`). */
const COUNT_KEY = /^[a-z][A-Za-z0-9]*$/;
/**
 * True when the string carries a C0 control character or DEL. Written as a
 * code-point scan rather than a regex character class so the detector does not
 * itself embed the control characters it looks for — the same assertion, with no
 * suppressed lint rule.
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const OPERATIONS = ['export', 'import-preflight', 'import-commit'];
const RESOURCE_KINDS = ['phase', 'pipeline', 'workflow'];
const OUTCOMES = ['info', 'success', 'failure'];

/** A bounded identifier: non-empty, within the catalogs' bound, single-line. */
function expectBoundedId(value: unknown, where: string): void {
  expect(typeof value, `${where} is not a string`).toBe('string');
  const id = value as string;
  expect(id.length, `${where} is empty`).toBeGreaterThan(0);
  expect(id.length, `${where} exceeds the identifier bound`).toBeLessThanOrEqual(ID_MAX);
  expect(hasControlChar(id), `${where} carries a control character`).toBe(false);
}

function expectBuildLiteral(value: unknown, where: string): void {
  expect(typeof value, `${where} is not a string`).toBe('string');
  const literal = value as string;
  expect(literal.length, `${where} exceeds the literal bound`).toBeLessThanOrEqual(ID_MAX);
  expect(BUILD_LITERAL.test(literal), `${where} is not a build-chosen literal: "${literal}"`).toBe(
    true
  );
}

function expectCount(value: unknown, where: string): void {
  expect(typeof value, `${where} is not a number`).toBe('number');
  const count = value as number;
  expect(Number.isInteger(count), `${where} is not an integer`).toBe(true);
  expect(count, `${where} is negative`).toBeGreaterThanOrEqual(0);
}

/**
 * The envelope both families share, and the whole of what they share.
 *
 * Split out when the lifecycle family arrived (feature 100, T514i) rather than
 * widening `classify`: a single classifier over both would have to accept the
 * UNION of the two payload key sets, and a union is precisely the containment
 * check the header rejects — an exchange event that grew a `versionId` would
 * pass it, and so would a lifecycle event that grew an `outcomes` list.
 */
function expectEnvelopeShape(event: AuditEnvelope, where: string): void {
  const keys = Object.keys(event).sort();
  const allowed = [...ENVELOPE_REQUIRED, ...ENVELOPE_OPTIONAL].sort();
  expect(keys.filter((key) => !allowed.includes(key)), `${where} has unclassified envelope fields`).toEqual([]);
  for (const required of ENVELOPE_REQUIRED) {
    expect(keys, `${where} is missing ${required}`).toContain(required);
  }
  expectCount(event.iteration, `${where}.iteration`);
  if (event.correlationId !== undefined) {
    expect(typeof event.correlationId, `${where}.correlationId is not a string`).toBe('string');
    expect(event.correlationId.length, `${where}.correlationId is unbounded`).toBeLessThanOrEqual(
      CORRELATION_ID_MAX
    );
    expect(hasControlChar(event.correlationId), `${where}.correlationId has control chars`).toBe(false);
  }
  const payload = event.payload;
  expect(payload !== null && typeof payload === 'object' && !Array.isArray(payload), `${where}.payload`).toBe(true);
}

/**
 * Every leaf of one event, placed in FR-033's vocabulary.
 *
 * Key sets are asserted for EXACT equality rather than containment: a field
 * added later must be classified here deliberately, not inherited silently.
 */
function classify(event: AuditEnvelope, where: string): void {
  expectEnvelopeShape(event, where);

  // `runId` is the one envelope field that carries an operator-chosen id: the
  // exchange namespace prefix, then either a fixed operation literal or the
  // resource the operator named.
  expect(typeof event.runId, `${where}.runId is not a string`).toBe('string');
  expect(event.runId.startsWith(RUN_ID_PREFIX), `${where}.runId is outside the exchange namespace`).toBe(true);
  expectBoundedId(event.runId.slice(RUN_ID_PREFIX.length), `${where}.runId suffix`);

  expect(event.phase, `${where}.phase`).toBe(EXCHANGE_PHASE);
  expect(PROCESS_EXCHANGE_EVENT_TYPES, `${where}.eventType`).toContain(event.eventType);
  expect(OUTCOMES, `${where}.outcome`).toContain(event.outcome);

  const payload = event.payload;
  expect(Object.keys(payload).sort(), `${where}.payload key set`).toEqual([...PAYLOAD_KEYS].sort());

  expect(OPERATIONS, `${where}.payload.operation`).toContain(payload['operation']);
  expect(RESOURCE_KINDS, `${where}.payload.resourceKind`).toContain(payload['resourceKind']);

  const resourceIds = payload['resourceIds'];
  expect(Array.isArray(resourceIds), `${where}.payload.resourceIds is not an array`).toBe(true);
  expect((resourceIds as unknown[]).length, `${where}.payload.resourceIds is unbounded`).toBeLessThanOrEqual(IDS_MAX);
  (resourceIds as unknown[]).forEach((id, index) =>
    expectBoundedId(id, `${where}.payload.resourceIds[${index}]`)
  );

  const outcomes = payload['outcomes'];
  expect(Array.isArray(outcomes), `${where}.payload.outcomes is not an array`).toBe(true);
  expect((outcomes as unknown[]).length, `${where}.payload.outcomes is unbounded`).toBeLessThanOrEqual(IDS_MAX);
  (outcomes as unknown[]).forEach((outcome, index) =>
    expectBuildLiteral(outcome, `${where}.payload.outcomes[${index}]`)
  );

  const counts = payload['counts'];
  expect(counts !== null && typeof counts === 'object' && !Array.isArray(counts), `${where}.payload.counts`).toBe(true);
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    expect(COUNT_KEY.test(key), `${where}.payload.counts has a free-form key: "${key}"`).toBe(true);
    expectCount(value, `${where}.payload.counts.${key}`);
  }
}

/**
 * Every leaf of one lifecycle event, placed in FR-053's vocabulary (T514i).
 *
 * Three fields, and the reason the whole family is safe by construction: a kind
 * from the store's own closed union, an id bounded at the catalog's own limit, and
 * a `v<N>` the store minted. There is no list, no message, and no free-text field
 * — so a body, a note, or a workspace root has nowhere to go, and the exact key
 * set above is what keeps that true of the next field somebody adds.
 */
function classifyLifecycle(event: AuditEnvelope, where: string): void {
  expectEnvelopeShape(event, where);

  // A literal rather than a run id: these events belong to no run, so `runId`
  // carries nothing an operator chose. That is why there is no namespace-plus-
  // suffix check here — there is no suffix.
  expect(event.runId, `${where}.runId`).toBe(LIFECYCLE_PHASE);
  expect(event.phase, `${where}.phase`).toBe(LIFECYCLE_PHASE);
  expect(CATALOG_LIFECYCLE_EVENT_TYPES, `${where}.eventType`).toContain(event.eventType);
  // Not `OUTCOMES`: a pointer move is recorded only once it has happened, so
  // `info` is the only entry outcome this family can produce.
  expect(event.outcome, `${where}.outcome`).toBe('info');

  const payload = event.payload;
  expect(Object.keys(payload).sort(), `${where}.payload key set`).toEqual(
    [...LIFECYCLE_PAYLOAD_KEYS].sort()
  );
  expect(RESOURCE_KINDS, `${where}.payload.resourceKind`).toContain(payload['resourceKind']);
  expectBoundedId(payload['resourceId'], `${where}.payload.resourceId`);
  const versionId = payload['versionId'];
  expect(typeof versionId, `${where}.payload.versionId is not a string`).toBe('string');
  expect(
    VERSION_ID.test(versionId as string),
    `${where}.payload.versionId is not a store-minted v<N>: "${String(versionId)}"`
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// The canary scan (T037, FR-034, FR-035)
// ---------------------------------------------------------------------------

interface Leaf {
  readonly where: string;
  readonly text: string;
}

/**
 * Every string an event carries, keys included.
 *
 * Keys are walked as well as values because a leak can ride in either: a
 * `counts` map built from operator-supplied names would put the text in the key
 * position, where a value-only scan sees nothing.
 */
function stringLeaves(value: unknown, where: string, out: Leaf[]): void {
  if (typeof value === 'string') {
    out.push({ where, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, `${where}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push({ where: `${where}.${key} (key)`, text: key });
      stringLeaves(item, `${where}.${key}`, out);
    }
  }
}

function leavesOf(events: readonly { readonly where: string; readonly event: AuditEnvelope }[]): Leaf[] {
  const out: Leaf[] = [];
  for (const { where, event } of events) stringLeaves(event, where, out);
  return out;
}

/** Which canaries appear in which fields. Empty is the passing answer. */
function findCanaries(
  leaves: readonly Leaf[],
  canaries: readonly { readonly label: string; readonly text: string }[]
): string[] {
  const hits: string[] = [];
  for (const leaf of leaves) {
    for (const canary of canaries) {
      if (leaf.text.includes(canary.text)) hits.push(`${leaf.where} leaked ${canary.label}`);
    }
  }
  return hits;
}

/**
 * A path separator, anywhere.
 *
 * Stricter than "an absolute path" on purpose: nothing this envelope legitimately
 * carries has a separator in it — event types, operations, scopes and outcomes
 * are kebab literals, ids are catalog identifiers, and the correlation id is the
 * command name with a counter. A relative path would be just as much of a leak as
 * an absolute one, and this catches both.
 */
const PATH_SEPARATOR = /[/\\]/;

// ---------------------------------------------------------------------------
// The writer and reader bounds (T038, FR-036, FR-037)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * The modules that carry an operator-authored identifier into a bounded field —
 * the two exchange services and the commit audit writer.
 *
 * FR-037 says operator identifiers reuse the bound the runtime validators already
 * enforce, and that no second limit for the same class of value is introduced.
 * A local `const …ID…MAX = 64` beside `PHASE_ID_MAX_LEN` is exactly that second
 * limit: it agrees today by coincidence, and the day a catalog widens its own id
 * bound it starts silently truncating ids the catalog accepts.
 */
const EXCHANGE_BOUNDARY_SOURCES = [
  'src/services/process-yaml/preflight-service.ts',
  'src/services/process-yaml/export-service.ts',
  'src/ui/sidebar/commands/process-exchange-commit-audit.ts'
];

/** Any module-level numeric constant. Narrowed to the id-length class below. */
const NUMERIC_CONSTANT = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d[\d_]*)\b/g;

const LENGTH_TOKENS = new Set(['MAX', 'LEN', 'LIMIT']);

/**
 * A bound on how long ONE identifier may be — the class FR-037 says must be
 * sourced from the runtime validators.
 *
 * Token-wise rather than by substring so the sibling bounds these same modules
 * legitimately own stay out of scope: `RESOURCE_IDS_MAX` bounds how MANY ids a
 * record lists (a different class of value, with no validator to defer to), and
 * `NAME_MAX` / `CODE_MAX` / `MESSAGE_MAX` bound fields that are not identifiers.
 * A substring match would have flagged all four.
 */
function isIdLengthBound(name: string): boolean {
  const tokens = name.split('_');
  return tokens.includes('ID') && tokens.some((token) => LENGTH_TOKENS.has(token));
}

const OVERLONG_ID = 'a'.repeat(200);

function handlerContext(audit: Recorder): HandlerContext {
  return {
    deps: depsFor(makeStore(), audit),
    postAck: async () => true,
    correlationId: 'audit-bound'
  } as unknown as HandlerContext;
}

// ---------------------------------------------------------------------------

describe('Audit boundary (T036-T038, US6, FR-033 - FR-037)', () => {
  let root: string;
  let emissions: readonly Emission[];
  let lifecycle: LifecycleTrail;

  beforeAll(async () => {
    root = await makeWorkspaceRoot();
    workspaceRoot.path = root;
    lifecycle = await driveLifecycle();
    emissions = [
      ...(await drivePreview()),
      ...(await driveImport()),
      ...(await driveExport()),
      // Folded into the shared set on purpose: the privacy scans below are the
      // ones this family most needs, and a second scan over a second list is a
      // second place for one of them to be forgotten.
      lifecycle.emission
    ];
  });

  afterAll(async () => {
    workspaceRoot.path = '/tmp/audit-boundary';
    await removeWorkspaceRoot(root);
  });

  function everyEvent(): readonly { readonly where: string; readonly event: AuditEnvelope }[] {
    return emissions.flatMap((emission) =>
      emission.events.map((event, index) => ({ event, where: `${emission.label}[${index}]` }))
    );
  }

  describe('Structured fields (T036, FR-033)', () => {
    it('emits exactly the events the five operations specify', () => {
      const byLabel = new Map(emissions.map((emission) => [emission.label, emission.events]));

      // A document that plans records nothing. A plan is a proposal about a file
      // nobody has written yet.
      expect(byLabel.get('preview planned')).toEqual([]);

      // A refusal records one event per adapter — the automation's without a
      // correlation id, the operator's with one.
      const refusedPreview = byLabel.get('preview refused') ?? [];
      expect(refusedPreview).toHaveLength(2);
      for (const event of refusedPreview) {
        expect(event.eventType).toBe('process-exchange-import-refused');
        expect(event.payload['operation']).toBe('import-preflight');
      }

      // One commit record per layer of the package: Phases, Pipelines, Workflows.
      const committed = byLabel.get('import committed') ?? [];
      expect(committed.map((event) => event.payload['resourceKind'])).toEqual([
        'phase',
        'pipeline',
        'workflow'
      ]);
      for (const event of committed) {
        expect(event.eventType).toBe('process-exchange-import-committed');
        expect(event.payload['operation']).toBe('import-commit');
        expect(event.outcome).toBe('info');
      }

      // A refused layer write is recorded as a failure carrying the save gate's own
      // rejection literal — never the operator-facing message beside it.
      const refusedCommit = byLabel.get('import refused') ?? [];
      expect(refusedCommit).toHaveLength(1);
      expect(refusedCommit[0]!.eventType).toBe('process-exchange-import-refused');
      expect(refusedCommit[0]!.outcome).toBe('failure');
      expect(refusedCommit[0]!.payload['outcomes']).toEqual(['stale-catalog']);

      const exported = byLabel.get('export saved') ?? [];
      expect(exported).toHaveLength(2);
      for (const event of exported) {
        expect(event.eventType).toBe('process-exchange-export');
        expect(event.payload['outcomes']).toEqual(['saved']);
      }

      const unavailable = byLabel.get('export unavailable') ?? [];
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]!.payload['outcomes']).toEqual(['unavailable']);
      expect(unavailable[0]!.payload['counts']).toEqual({ exported: 0 });
    });

    it('carries only bounded ids, statuses, outcomes, and counts', () => {
      const all = everyEvent();
      // The classifier is only worth running over a non-empty set.
      expect(all.length, 'no audit events were captured at all').toBeGreaterThan(0);

      // Feature 100 (T514i) — the partition is asserted BEFORE either half is
      // classified. Two classifiers selected by `phase` means an event in
      // neither family is classified by nobody, and a test that simply filtered
      // for the two it knows would report that as a pass.
      const exchange = all.filter(({ event }) => event.phase === EXCHANGE_PHASE);
      const lifecycleEvents = all.filter(({ event }) => event.phase === LIFECYCLE_PHASE);
      expect(
        all
          .filter(({ event }) => event.phase !== EXCHANGE_PHASE && event.phase !== LIFECYCLE_PHASE)
          .map(({ where, event }) => `${where} is phase "${event.phase}"`),
        'an emitted event belongs to neither audited family'
      ).toEqual([]);
      expect(exchange.length, 'no exchange events were captured').toBeGreaterThan(0);
      expect(lifecycleEvents.length, 'no lifecycle events were captured').toBeGreaterThan(0);

      for (const { event, where } of exchange) classify(event, where);
      for (const { event, where } of lifecycleEvents) classifyLifecycle(event, where);
    });

    it('adds no audit event of its own when a Pipeline run is launched', async () => {
      const store = makeStore();
      const audit = auditRecorder();
      const deps = launchDeps(store, audit, new RecordingQueue());

      const headless = await launchPipelineRun(deps, {
        request: launchRequest(),
        workspaceRoot: workspaceRoot.path
      });
      expect((headless as { outcome: string }).outcome, JSON.stringify(headless)).toBe('enqueued');
      const sidebar = await dispatch(deps, CMD_LAUNCH_PIPELINE, { request: launchRequest() });
      expect(sidebar.status).toBe('accepted');
      expect(audit.events, 'a launch wrote an audit event').toEqual([]);

      // The recorder in that same bag is live: a package publication through it
      // records. Without this, "the list is empty" would also be true of a dead port.
      const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, controlPackage(store));
      expect(ack.status, `control publication rejected: ${ack.reason}`).toBe('accepted');
      expect(audit.events.length, 'the audit port was never live').toBeGreaterThan(0);
    });

    it('adds no audit event of its own when a Workflow run is continued', async () => {
      const store = makeStore();
      const audit = auditRecorder();
      const deps = continueDeps(store, audit, new RecordingQueue());

      const headless = await continueWorkflowRun(
        { ...deps, projectRun: projectConnectedRun, isNodeStartable },
        { payload: continuePayload(), workspaceRoot: workspaceRoot.path, startedAt: CONTINUE_NOW }
      );
      expect((headless as { outcome: string }).outcome, JSON.stringify(headless)).toBe('started');
      const sidebar = await dispatch(deps, CMD_CONTINUE_WORKFLOW, continuePayload());
      expect(sidebar.status).toBe('accepted');
      expect(audit.events, 'a continuation wrote an audit event').toEqual([]);

      const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, controlPackage(store));
      expect(ack.status, `control publication rejected: ${ack.reason}`).toBe('accepted');
      expect(audit.events.length, 'the audit port was never live').toBeGreaterThan(0);
    });
  });

  describe('The lifecycle emission map (T514i, FR-052 - FR-054, SC-010)', () => {
    it('records nothing for a draft write and nothing for a discard (FR-054)', () => {
      // NOT "the recorder is empty" — that is also true of a port nobody wired,
      // and this file's whole subject is the difference. Each silent operation is
      // checked against the number of pointer moves that had already happened, so
      // a stray record fails even in the middle of a trail that legitimately
      // holds four, and the order of the trail is not an escape hatch.
      expect(lifecycle.silent.length, 'no silent operation was exercised').toBeGreaterThan(0);
      for (const { operation, events, moves } of lifecycle.silent) {
        expect(events, `${operation} emitted an audit event`).toBe(moves);
      }
      // And the recorder those zeros were read off did record, four times.
      expect(lifecycle.emission.events.length, 'the audit port was never live').toBe(
        lifecycle.expected.length
      );
      expect(lifecycle.expected.length, 'no pointer move was exercised').toBeGreaterThan(0);
    });

    it('records one event per pointer move, naming the version the ack named (FR-052)', () => {
      // The expected version ids are read off the ACKS, never hardcoded: the claim
      // is that the record names the version the operator was told about. A
      // publish names the version that became active, a restore the version it
      // copied FROM (the operator's selection), a deactivation the draft it left.
      expect(
        lifecycle.emission.events.map((event) => ({
          eventType: event.eventType,
          versionId: event.payload['versionId']
        }))
      ).toEqual(lifecycle.expected);
    });

    it('names the definition that moved, and nothing else about it (FR-053)', () => {
      for (const event of lifecycle.emission.events) {
        expect(event.payload['resourceKind']).toBe('phase');
        expect(event.payload['resourceId']).toBe(LIFECYCLE_ID);
      }
    });
  });

  describe('Privacy bounds (T037, FR-034, FR-035, SC-007)', () => {
    const CANARIES = [
      { label: 'the instruction text', text: CANARY_INSTRUCTION },
      { label: 'the task name', text: CANARY_TASK },
      { label: 'the credential-shaped token', text: CANARY_SECRET },
      { label: 'the operator-authored path', text: CANARY_PATH },
      // Feature 100 (T514i) — the field the draft commands added. It is scanned
      // over the same list of events as the other four, because the lifecycle
      // emission joined `emissions` rather than getting a scan of its own.
      { label: 'the operator-authored note', text: CANARY_NOTE }
    ];

    it("carries none of the document's operator-authored text (FR-034)", () => {
      const leaves = leavesOf(everyEvent());
      // Substring search over an empty set finds nothing, and so does a real one.
      expect(leaves.length, 'nothing was scanned').toBeGreaterThan(0);
      expect(findCanaries(leaves, CANARIES)).toEqual([]);
    });

    it('carries no workspace root and no path separator at all (FR-035)', () => {
      const leaves = leavesOf(everyEvent());
      // The mocked root is a real temp directory, so this is the actual string a
      // careless implementation would have picked up — not a stand-in for it.
      expect(findCanaries(leaves, [{ label: 'the workspace root', text: root }])).toEqual([]);
      const separators = leaves
        .filter((leaf) => PATH_SEPARATOR.test(leaf.text))
        .map((leaf) => `${leaf.where} = ${leaf.text}`);
      expect(separators).toEqual([]);
    });

    it('reports every planted canary, including one in a key (positive control)', () => {
      const planted: AuditEnvelope = {
        runId: `process-exchange:${CANARY_TASK}`,
        phase: 'process-exchange',
        iteration: 0,
        eventType: 'process-exchange-import-refused',
        outcome: 'info',
        payload: {
          operation: 'import-preflight',
          resourceKind: 'phase',
          // Two entries, so the walker is shown to descend past index 0.
          resourceIds: [CANARY_INSTRUCTION, CANARY_NOTE],
          outcomes: [CANARY_SECRET],
          // In the KEY position, which is the half a value-only walker misses.
          counts: { [CANARY_PATH]: 1 }
        }
      };
      const leaves = leavesOf([{ where: 'planted', event: planted }]);

      const hits = findCanaries(leaves, CANARIES);
      // One hit per canary: each is planted exactly once, in a different position.
      expect(hits).toHaveLength(CANARIES.length);
      expect(hits.some((hit) => hit.includes('counts') && hit.includes('(key)'))).toBe(true);
      expect(leaves.some((leaf) => PATH_SEPARATOR.test(leaf.text))).toBe(true);
    });
  });

  describe('Reader and writer bounds (T038, FR-036, FR-037, FR-015)', () => {
    it('preserves an event type this build does not know, with a warning (FR-036)', () => {
      const real = everyEvent().find(
        ({ event }) => event.eventType === 'process-exchange-import-committed'
      );
      expect(real, 'no committed event was captured to reshape').toBeDefined();

      // A real emitted event, made into a log line the way the writer would: the
      // two fields it mints downstream added, and the event type replaced with one
      // a later build might introduce.
      const lineFor = (eventType: string): string =>
        JSON.stringify({
          ...real!.event,
          id: 'audit-boundary-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          eventType
        });

      const unknown = parseAuditLogLineDetailed(lineFor('process-exchange-import-quarantined'));
      expect(unknown.entry, 'an unknown event type was dropped').not.toBeNull();
      expect(unknown.entry?.eventType).toBe('process-exchange-import-quarantined');
      // Preserved whole, not degraded to a placeholder: a reader that kept the
      // record but discarded its payload would satisfy a null check and nothing else.
      expect(unknown.entry?.payload).toEqual(real!.event.payload);
      expect(unknown.warning).toMatch(/unknown eventType/);

      // The same line under a type this build does know warns about nothing, so
      // the warning above is a response to the unknown type and not a constant.
      const known = parseAuditLogLineDetailed(lineFor('process-exchange-import-committed'));
      expect(known.entry).not.toBeNull();
      expect(known.warning).toBeUndefined();
    });

    it("bounds an over-long id at each catalog's own validator constant (FR-037)", async () => {
      const kinds = [
        { kind: 'phase', max: PHASE_ID_MAX_LEN },
        { kind: 'pipeline', max: PIPELINE_ID_MAX_LEN },
        { kind: 'workflow', max: WORKFLOW_ID_MAX_LEN }
      ] as const;

      for (const { kind, max } of kinds) {
        const audit = auditRecorder();
        await auditImportCommitted(handlerContext(audit), {
          resourceKind: kind,
          resourceIds: [OVERLONG_ID]
        });

        const ids = audit.events[0]?.payload['resourceIds'] as readonly string[] | undefined;
        // Asserted against the imported constant, never a literal: the claim is
        // that the writer defers to the catalog's bound, so a catalog that widens
        // its own id length and a writer that does not follow must fail here.
        expect((ids ?? [])[0]?.length, `${kind} id was not bounded at its own maximum`).toBe(max);
      }
    });

    it('keeps the id-list cap visible in the counts it records (FR-049)', async () => {
      const audit = auditRecorder();
      const declared = Array.from({ length: 50 }, (_, index) => `audit-id-${index}`);
      await auditImportCommitted(handlerContext(audit), {
        resourceKind: 'phase',
        resourceIds: declared
      });

      const payload = audit.events[0]?.payload ?? {};
      expect((payload['resourceIds'] as readonly string[]).length).toBe(20);
      // Untruncated, so a reader can tell 20-of-50 from 20-of-20.
      expect(payload['counts']).toEqual({ imported: declared.length });
    });

    it('declares no second identifier-length limit at the exchange boundaries (FR-037)', () => {
      const offenders: string[] = [];
      for (const relative of EXCHANGE_BOUNDARY_SOURCES) {
        const source = readFileSync(resolve(REPO_ROOT, relative), 'utf8');
        for (const [, name, value] of source.matchAll(NUMERIC_CONSTANT)) {
          if (isIdLengthBound(name!)) offenders.push(`${relative} declares ${name} = ${value}`);
        }
      }
      expect(offenders, 'FR-037 forbids a second limit for a value the validators already bound')
        .toEqual([]);
    });
  });
});
