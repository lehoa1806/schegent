// Feature 085 T064 / Feature 086 T052 / Feature 263 (FR-R5-F04) — what a package
// exchange records about itself (FR-059, FR-060, FR-061).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));

const WORKSPACE_ROOT = '/Users/planted/ws/PKG-ROOT-TOKEN-Q9/checkout';
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/Users/planted/ws/PKG-ROOT-TOKEN-Q9/checkout' },
    name: 'checkout',
    index: 0
  })
}));

import {
  ALL_AUDIT_EVENT_TYPES,
  AUDIT_SCHEMA_VERSION,
  PROCESS_EXCHANGE_EVENT_TYPES
} from '../../../src/contracts/audit-events';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
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
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import {
  publishDefinition,
  publishDefinitionPackage,
  saveDefinitionDraft
} from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';
import { FakeCatalogStore, NO_WRITES, tokenFor, writesOf } from '../../fixtures/fake-catalog-store';

type LayerKey = 'phases' | 'workflows';

const LAYER_ORDER: readonly LayerKey[] = ['phases', 'workflows'];

const KIND_OF: Readonly<Record<LayerKey, CatalogKind>> = {
  phases: 'phase',
  workflows: 'workflow'
};

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

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

const TOKENS = {
  workflowName: 'PKG-NAME-TOKEN-Q1',
  workflowDescription: 'PKG-DESC-TOKEN-Q2',
  portLabel: 'PORT-LABEL-TOKEN-Q3',
  portDescription: 'PORT-DESC-TOKEN-Q4',
  instruction: 'INSTRUCTION-TOKEN-Q5',
  skill: 'SKILL-TOKEN-Q6',
  retryCondition: 'RETRY_TOKEN_Q7 > 0',
  recommendedNext: 'next-token-q8',
  secret: 'sk-secret-value-Q0'
} as const;

const FORBIDDEN_AUDIT_TOKENS = [
  ...Object.values(TOKENS),
  WORKSPACE_ROOT,
  'PKG-ROOT-TOKEN-Q9',
  'ship-it.workflow.yaml'
] as const;

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Workflow', ...body, ''].join('\n');
}

const PLANTED_PACKAGE = packageDocument([
  'metadata:',
  '  id: ship-it',
  `  name: ${TOKENS.workflowName}`,
  `  description: ${TOKENS.workflowDescription}`,
  '  version: 3',
  'spec:',
  '  inputs:',
  '    - portId: feature-brief',
  `      label: ${TOKENS.portLabel}`,
  '      type: text',
  '      required: true',
  `      description: ${TOKENS.portDescription}`,
  '  nodes:',
  '    - nodeId: n1',
  '      kind: phase',
  '      phaseId: specify',
  '    - nodeId: n2',
  '      kind: phase',
  '      phaseId: polish',
  '  startNodeIds:',
  '    - n1',
  '    - n2',
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

const BLOCKED_ROOT = packageDocument([
  'metadata:',
  '  id: ship-it',
  `  name: ${TOKENS.workflowName}`,
  '  version: 3',
  'spec:',
  '  nodes:',
  '    - nodeId: n1',
  '      kind: phase',
  '      phaseId: specify',
  '    - nodeId: n2',
  '      kind: phase',
  '      phaseId: absent-phase',
  '  startNodeIds:',
  '    - n1',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  `        instruction: ${TOKENS.instruction}`
]);

const REFUSED_DOCUMENT = 'apiVersion: schegent/v1\nkind: Deployment\n';

const REFUSED_AS_WORKFLOW = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  nodes:',
  '    - nodeId: n1',
  '      kind: phase',
  '      phaseId: specify',
  '  startNodeIds:',
  '    - n1',
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

const STORED_WORKFLOW = {
  workflowId: 'ship-it',
  name: TOKENS.workflowName,
  description: TOKENS.workflowDescription,
  version: 3,
  inputs: [
    {
      portId: 'feature-brief',
      label: TOKENS.portLabel,
      type: 'text',
      required: true,
      description: TOKENS.portDescription
    }
  ],
  nodes: [
    { nodeId: 'n1', kind: 'phase', phaseId: 'specify' },
    { nodeId: 'n2', kind: 'phase', phaseId: 'polish' }
  ],
  connections: [],
  startNodeIds: ['n1', 'n2'],
  recommendedNext: [TOKENS.recommendedNext]
} as const;

interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(
  seed: {
    readonly phases?: readonly unknown[];
    readonly workflows?: readonly unknown[];
  } = {}
): Installation {
  return {
    store: new FakeCatalogStore({
      phases: seed.phases ?? [],
      pipelines: [],
      workflows: seed.workflows ?? []
    })
  };
}

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

async function exportWorkflow(
  inst: Installation,
  inclusion: 'references-only' | 'include-closure'
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
    payload: { resourceKind: 'workflow', resourceId: 'ship-it', inclusion }
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

function imported<T>(plan: ImportPlan, kind: 'phase' | 'workflow'): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
    }
  }
  return definitions;
}

const importedPhases = (plan: ImportPlan) => imported<PhaseDefinition>(plan, 'phase');
const importedWorkflows = (plan: ImportPlan) => imported<WorkflowDefinition>(plan, 'workflow');

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

function packageCommand(
  plan: ImportPlan,
  revisions: Partial<Record<'phase' | 'workflow', string>> = {}
): PublishPackageCommand {
  const layers: PublishPackageCommand['payload']['layers'][number][] = [];
  const phases = importedPhases(plan);
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

interface Driven {
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
      catalogLifecycle: fakeCatalogLifecycle(inst.store),
      readConfig: () => undefined,
      executeCommand: vi.fn(),
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
    readonly revisions?: Partial<Record<'phase' | 'workflow', string>>;
    readonly command?: PublishPackageCommand;
  } = {}
): Promise<CommitRun> {
  const { ctx, acks, audits } = driver(inst);

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

function exchangeAudits(audits: readonly AuditEntry[]): readonly AuditEntry[] {
  return audits.filter((entry) => entry.eventType.startsWith('process-exchange'));
}

function recordedKinds(records: readonly AuditEntry[]): readonly [unknown, unknown][] {
  return records.map((entry) => [entry.payload.resourceKind, entry.payload.outcomes]);
}

beforeEach(() => {
  capabilities.clear();
});

describe('Feature 085 T064 — a package exchange records five fields (FR-059)', () => {
  it('bounds a package export to the envelope, and names the Workflow kind', async () => {
    const inst = installation({ phases: [...STORED_PHASES], workflows: [STORED_WORKFLOW] });
    const run = await exportWorkflow(inst, 'include-closure');
    expect(run.audits).toHaveLength(1);
    const entry = run.audits[0]!;
    expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(entry.payload.resourceKind).toBe('workflow');
    expect(entry.payload.resourceIds).toEqual(['ship-it']);
  });

  it('counts the definitions the document actually carried, not just the root', async () => {
    const inst = installation({ phases: [...STORED_PHASES], workflows: [STORED_WORKFLOW] });
    const bundled = await exportWorkflow(inst, 'include-closure');
    expect(bundled.audits[0]!.payload.counts).toEqual({
      exported: 1,
      includedPhases: 2
    });

    const bare = await exportWorkflow(inst, 'references-only');
    expect(bare.audits[0]!.payload.counts).toEqual({
      exported: 1,
      includedPhases: 0
    });
  });

  it('bounds a package refusal to the envelope, under the kind the dispatch settled on', async () => {
    const run = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_WORKFLOW, 'utf8'))
    });
    expect(run.result.outcome).toBe('refused');
    expect(run.audits).toHaveLength(1);
    expect(Object.keys(run.audits[0]!.payload).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(run.audits[0]!.payload).toMatchObject({
      operation: 'import-preflight',
      resourceKind: 'workflow',
      resourceIds: [],
      counts: { refused: 1 }
    });
  });

  it('bounds each layer of a confirmed import to the same envelope', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

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
      resourceKind: 'workflow',
      resourceIds: ['ship-it'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
  });

  it('records nothing for an ordinary catalog edit, which is not an exchange', async () => {
    const inst = installation();
    const audits = await editOneDefinition(
      inst,
      { kind: 'phase', id: 'specify' },
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' }
    );

    expect(exchangeAudits(audits)).toEqual([]);
    expect(audits.map((entry) => entry.eventType)).toEqual(['definition-published']);
  });
});

describe('Feature 085 T064 — the log records the operation, not the package (FR-060)', () => {
  it('carries no authored text out of an export, though the document held all of it', async () => {
    const inst = installation({ phases: [...STORED_PHASES], workflows: [STORED_WORKFLOW] });
    const run = await exportWorkflow(inst, 'include-closure');

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
    expect(serialized).not.toContain(message);
  });

  it('carries no authored text out of a commit, though every row held some', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    expect(JSON.stringify(inst.store.rowsOf('phase'))).toContain(TOKENS.instruction);
    expect(JSON.stringify(inst.store.rowsOf('workflow'))).toContain(TOKENS.portLabel);

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
  });

  it('records the workspace basename but never the root', async () => {
    capabilities.set('phases', false);
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);

    const serialized = JSON.stringify(run.audits);
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
      failOn: { key: 'workflows', pass: 'publish' }
    });
    const refused = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_WORKFLOW, 'utf8'))
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
      ['workflow', ['stale-catalog']]
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
    expect(run.records).toEqual([]);
  });

  it('records a partial outcome as two records that disagree', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, {
      failOn: { key: 'workflows', pass: 'publish' }
    });

    expect(run.ack.reason).toBe('package-partial');
    expect(inst.store.rowsOf('phase')).toHaveLength(2);
    expect(inst.store.rowsOf('workflow')).toEqual([]);
    expect(inst.store.draftRowsOf('workflow')).toHaveLength(1);

    expect(run.records).toHaveLength(2);
    expect(run.records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      outcomes: ['imported'],
      counts: { imported: 2 }
    });
    expect(run.records[0]!.outcome).toBe('info');
    expect(run.records[1]!.payload).toMatchObject({
      resourceKind: 'workflow',
      resourceIds: ['ship-it'],
      outcomes: ['package-partial'],
      counts: { refused: 1 }
    });
    expect(run.records[1]!.outcome).toBe('failure');
  });

  it('records the pass-1 partial as two refusals, because nothing became live', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, { failOn: { key: 'workflows', pass: 'draft' } });

    expect(run.ack.reason).toBe('package-partial');
    expect(run.ack.result).toMatchObject({
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'workflow',
      cause: 'not-writable'
    });
    expect(inst.store.rowsOf('phase')).toEqual([]);
    expect(inst.store.draftRowsOf('phase')).toHaveLength(2);

    expect(recordedKinds(run.records)).toEqual([
      ['phase', ['package-partial']],
      ['workflow', ['package-partial']]
    ]);
    expect(run.records.map((entry) => entry.outcome)).toEqual(['failure', 'failure']);
  });

  it('records a blocked root as an import of what was eligible, and no more', async () => {
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
    expect(inst.store.rowsOf('workflow')).toEqual([]);
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
    const seen = new Set<string>();
    const record = (entry: AuditEntry) =>
      seen.add(
        `${entry.eventType}/${entry.payload.resourceKind}/${(entry.payload.outcomes as readonly string[]).join(',')}`
      );

    const refusedRun = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_WORKFLOW, 'utf8'))
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
      failOn: { key: 'workflows', pass: 'publish' }
    });
    partialRun.records.forEach(record);

    expect([...seen].sort()).toEqual([
      'process-exchange-import-committed/phase/imported',
      'process-exchange-import-committed/workflow/imported',
      'process-exchange-import-refused/phase/stale-catalog',
      'process-exchange-import-refused/workflow/duplicate-id',
      'process-exchange-import-refused/workflow/package-partial',
      'process-exchange-import-refused/workflow/stale-catalog'
    ]);
  });

  it('adds no event type and needs no schema bump', async () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
    expect([...PROCESS_EXCHANGE_EVENT_TYPES]).toEqual([
      'process-exchange-export',
      'process-exchange-import-refused',
      'process-exchange-import-committed'
    ]);

    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan);
    for (const entry of run.records) {
      expect(['process-exchange-import-committed', 'process-exchange-import-refused']).toContain(
        entry.eventType
      );
      expect(ALL_AUDIT_EVENT_TYPES as readonly string[]).toContain(entry.eventType);
    }
  });

  it('records both kinds in dependency order, never a reordering', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const forwards = packageCommand(plan);
    const backwards: PublishPackageCommand = {
      ...forwards,
      payload: { layers: [...forwards.payload.layers].reverse() }
    };
    expect(backwards.payload.layers.map((layer) => layer.kind)).toEqual(['workflow', 'phase']);

    const run = await commitPackage(inst, plan, { command: backwards });

    expect(run.records.map((entry) => entry.payload.resourceKind)).toEqual([
      'phase',
      'workflow'
    ]);
    expect(inst.store.publishLayers.map((request) => request.kind)).toEqual(
      LAYER_ORDER.map((key) => KIND_OF[key])
    );
  });
});
