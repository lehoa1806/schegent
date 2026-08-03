// Feature 085 T064 — what a package exchange records about itself (FR-059,
// FR-060, FR-061).
//
// 084 settled the envelope: operation, resource kind, ids, scope, per-resource
// outcomes, counts, and nothing else. A package does not change that shape — it
// changes what fills it. One document now carries several definitions, writes
// two catalog layers, and can end in a state that is neither success nor
// failure, and the envelope has to describe all of that without acquiring a
// field an instruction could ride out in.
//
// Three claims, in the order the FRs make them:
//
//   FR-059 — the payload is the same six fields, whatever the document held.
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
  CMD_PREFLIGHT_PROCESS_YAML
} from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as savePhasesHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { handler as savePipelinesHandler } from '../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PHASES, CMD_SAVE_PIPELINES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand, SavePipelinesCommand } from '../../../src/ui/sidebar/messages';

type Scope = 'user' | 'workspace';
type LayerKey = 'phases' | 'pipelines';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

/** The six fields 084 closed the envelope on. A seventh is the failure. */
const ENVELOPE_KEYS = [
  'counts',
  'operation',
  'outcomes',
  'resourceIds',
  'resourceKind',
  'scope'
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
// Catalog rows, as the layers store them
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

interface Layers {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

interface Installation {
  readonly phases: Layers;
  readonly pipelines: Layers;
}

function installation(
  seed: { readonly phases?: Partial<Layers>; readonly pipelines?: Partial<Layers> } = {}
): Installation {
  return {
    phases: { user: seed.phases?.user ?? [], workspace: seed.phases?.workspace ?? [] },
    pipelines: { user: seed.pipelines?.user ?? [], workspace: seed.pipelines?.workspace ?? [] }
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
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

interface Attempt {
  readonly key: LayerKey;
  readonly command: SavePhasesCommand | SavePipelinesCommand;
}

function attemptsFor(
  plan: ImportPlan,
  scope: Scope,
  inst: Installation,
  overrides: { readonly phaseRevision?: string; readonly pipelineRevision?: string } = {}
): readonly Attempt[] {
  const attempts: Attempt[] = [];
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);

  if (phases.length > 0) {
    attempts.push({
      key: 'phases',
      command: {
        type: CMD_SAVE_PHASES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: overrides.phaseRevision ?? plan.computedAgainstRevision[scope],
          mutation: {
            kind: 'import-package',
            phaseIds: phases.map((definition) => definition.phaseId)
          },
          phases: [...inst.phases[scope], ...phases.map(phaseRow)]
        }
      }
    });
  }

  if (pipelines.length > 0) {
    const revisions = plan.computedAgainstPipelineRevision;
    expect(revisions).toBeDefined();
    attempts.push({
      key: 'pipelines',
      command: {
        type: CMD_SAVE_PIPELINES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: overrides.pipelineRevision ?? revisions![scope],
          mutation: {
            kind: 'import-package',
            pipelineIds: pipelines.map((definition) => definition.pipelineId)
          },
          pipelines: [...inst.pipelines[scope], ...pipelines.map(pipelineRow)]
        }
      }
    });
  }

  return attempts;
}

interface CommitRun {
  readonly audits: readonly AuditEntry[];
  readonly results: readonly { key: LayerKey; ack: CommandAckMessage }[];
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  scope: Scope,
  opts: {
    readonly failOn?: LayerKey;
    readonly phaseRevision?: string;
    readonly pipelineRevision?: string;
  } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
      readConfig: () => undefined,
      updateConfig: async (key: string, value: unknown, target: Scope) => {
        if (opts.failOn === key) throw new Error('EACCES: settings.json is read-only');
        const layer = key === 'phases' ? inst.phases : inst.pipelines;
        layer[target] = value as readonly unknown[];
      },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const results: { key: LayerKey; ack: CommandAckMessage }[] = [];
  const attempts = attemptsFor(plan, scope, inst, {
    ...(opts.phaseRevision !== undefined ? { phaseRevision: opts.phaseRevision } : {}),
    ...(opts.pipelineRevision !== undefined ? { pipelineRevision: opts.pipelineRevision } : {})
  });
  for (const attempt of attempts) {
    if (attempt.key === 'phases') {
      await savePhasesHandler(ctx, attempt.command as SavePhasesCommand);
    } else {
      await savePipelinesHandler(ctx, attempt.command as SavePipelinesCommand);
    }
    const ack = acks[acks.length - 1]!;
    results.push({ key: attempt.key, ack });
    // The ordering exists so a Pipeline never lands without its Phases; carrying
    // on past a failed Phase write would be exactly that.
    if (ack.status !== 'accepted') break;
  }
  return { audits, results };
}

/** Exchange records only — the trust gate's own events are a separate family. */
function exchangeAudits(audits: readonly AuditEntry[]): readonly AuditEntry[] {
  return audits.filter((entry) => entry.eventType.startsWith('process-exchange'));
}

beforeEach(() => {
  capabilities.clear();
});

// ---------------------------------------------------------------------------
// FR-059 — the envelope does not widen for a package
// ---------------------------------------------------------------------------

describe('Feature 085 T064 — a package exchange records six fields (FR-059)', () => {
  it('bounds a package export to the envelope, and names the Pipeline kind', async () => {
    const inst = installation({
      phases: { workspace: [...STORED_PHASES] },
      pipelines: { workspace: [STORED_PIPELINE] }
    });
    const run = await exportPipeline(inst, 'include-referenced');
    expect(run.audits).toHaveLength(1);
    const entry = run.audits[0]!;
    expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(entry.payload.resourceKind).toBe('pipeline');
    expect(entry.payload.resourceIds).toEqual(['ship-it']);
    expect(entry.payload.scope).toBe('workspace');
  });

  it('counts the definitions the document actually carried, not just the root', async () => {
    // A package export writes N+1 definitions. `counts: { exported: 1 }` would
    // describe a references-only export equally well, which makes the two
    // operations indistinguishable in the log — and the difference is precisely
    // whether other operators' Phase text left the installation.
    const inst = installation({
      phases: { workspace: [...STORED_PHASES] },
      pipelines: { workspace: [STORED_PIPELINE] }
    });
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
      scope: null,
      counts: { refused: 1 }
    });
  });

  it('bounds each layer write of a confirmed import to the same envelope', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, 'workspace');

    const records = exchangeAudits(run.audits);
    // One per layer written, because a package write is two operations that can
    // succeed independently (FR-042).
    expect(records).toHaveLength(2);
    for (const entry of records) {
      expect(Object.keys(entry.payload).sort()).toEqual([...ENVELOPE_KEYS]);
      expect(entry.payload.operation).toBe('import-commit');
      expect(entry.payload.scope).toBe('workspace');
    }
    expect(records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      resourceIds: ['specify', 'polish'],
      outcomes: ['imported'],
      counts: { imported: 2 }
    });
    expect(records[1]!.payload).toMatchObject({
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
  });

  it('records nothing for an ordinary catalog edit, which is not an exchange', async () => {
    // The commit record is keyed on the mutation intent, not on the command. A
    // save handler that audited every write would turn the exchange log into a
    // second copy of the catalog's history.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const attempts = attemptsFor(plan, 'workspace', inst);
    expect(attempts.length).toBeGreaterThan(0);

    const audits: AuditEntry[] = [];
    const ctx = {
      deps: {
        readPhaseConfig: () => inst.phases,
        readPipelineConfig: () => inst.pipelines,
        readConfig: () => undefined,
        updateConfig: async () => undefined,
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
      postAck: async () => true,
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const edit = attempts[0]!.command as SavePhasesCommand;
    await savePhasesHandler(ctx, {
      ...edit,
      payload: { ...edit.payload, mutation: { kind: 'edit', phaseId: 'specify' } }
    });
    expect(exchangeAudits(audits)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FR-060 — none of the document's own text reaches the log
// ---------------------------------------------------------------------------

describe('Feature 085 T064 — the log records the operation, not the package (FR-060)', () => {
  it('carries no authored text out of an export, though the document held all of it', async () => {
    const inst = installation({
      phases: { workspace: [...STORED_PHASES] },
      pipelines: { workspace: [STORED_PIPELINE] }
    });
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
    const run = await commitPackage(inst, plan, 'workspace');

    // The rows that landed prove the tokens were in scope at commit time.
    expect(JSON.stringify(inst.phases.workspace)).toContain(TOKENS.instruction);
    expect(JSON.stringify(inst.pipelines.workspace)).toContain(TOKENS.portLabel);

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
  });

  it('records the workspace basename but never the root', async () => {
    capabilities.set('pipelineOverrides', false);
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, 'workspace');

    const serialized = JSON.stringify(run.audits);
    // Feature 059 I-6: the basename is the deliberate disclosure.
    expect(serialized).toContain('checkout');
    expect(serialized).not.toContain(WORKSPACE_ROOT);
    expect(serialized).not.toContain('PKG-ROOT-TOKEN-Q9');
  });

  it('draws every recorded outcome from a closed vocabulary, never document text', async () => {
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const committed = await commitPackage(inst, plan, 'workspace');
    const refused = await preflight(installation(), {
      outcome: 'read',
      bytes: new Uint8Array(Buffer.from(REFUSED_AS_PIPELINE, 'utf8'))
    });

    const recorded = [...exchangeAudits(committed.audits), ...refused.audits]
      .flatMap((entry) => entry.payload.outcomes as readonly string[]);
    expect(recorded.length).toBeGreaterThan(0);
    for (const outcome of recorded) {
      expect(
        ['imported', 'stale-catalog', 'persistence-failed', 'disallowed-syntax', 'duplicate-id'],
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

  it('records a stale-write refusal, so it is not silence', async () => {
    // The operator confirmed a plan computed against a layer that has since
    // moved. Nothing is written, and the reason the write did not happen is
    // exactly what a later reconstruction needs — an unaudited stale rejection
    // is indistinguishable from an operator who closed the dialog.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, 'workspace', { phaseRevision: 'moved-on' });

    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.ack.reason).toBe('stale-catalog');
    expect(inst.phases.workspace).toEqual([]);

    const records = exchangeAudits(run.audits);
    expect(records).toHaveLength(1);
    expect(records[0]!.eventType).toBe('process-exchange-import-refused');
    expect(records[0]!.payload).toMatchObject({
      operation: 'import-commit',
      resourceKind: 'phase',
      scope: 'workspace',
      outcomes: ['stale-catalog'],
      counts: { refused: 1 }
    });
  });

  it('records a capability denial as a denial, not as an exchange', async () => {
    capabilities.set('phases', false);
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, 'workspace');

    expect(run.results[0]!.ack.reason).toBe('trust-denied');
    expect(inst.phases.workspace).toEqual([]);
    const denials = run.audits.filter((entry) => entry.eventType === 'trust.capability-denied');
    expect(denials).toHaveLength(1);
    // A denial is a different decision, taken at a different time, about a
    // different thing — so it keeps its own event type (084's rule, unchanged).
    expect(exchangeAudits(run.audits)).toEqual([]);
  });

  it('records a partial outcome as two records that disagree', async () => {
    // The Phase layer lands and the Pipeline layer does not (FR-042a). This is
    // the state the catalog itself cannot describe: a workspace holding two
    // Phases and no Pipeline is indistinguishable from one where the operator
    // imported the Phases alone.
    const inst = installation();
    const plan = await planFor(inst, PLANTED_PACKAGE);
    const run = await commitPackage(inst, plan, 'workspace', { failOn: 'pipelines' });

    expect(inst.phases.workspace).toHaveLength(2);
    expect(inst.pipelines.workspace).toEqual([]);

    const records = exchangeAudits(run.audits);
    expect(records).toHaveLength(2);
    expect(records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      outcomes: ['imported'],
      counts: { imported: 2 }
    });
    expect(records[0]!.outcome).toBe('info');
    expect(records[1]!.payload).toMatchObject({
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      outcomes: ['persistence-failed'],
      counts: { refused: 1 }
    });
    expect(records[1]!.outcome).toBe('failure');
  });

  it('records a blocked root as an import of what was eligible, and no more', async () => {
    // The root references a Phase nothing supplies, so only the included Phase
    // is written (FR-039). The log says a Phase landed and no Pipeline did,
    // which is the difference between "blocked" and "the Pipeline write failed".
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts.blocked).toBe(1);

    const run = await commitPackage(inst, plan, 'workspace');
    const records = exchangeAudits(run.audits);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      resourceKind: 'phase',
      resourceIds: ['specify'],
      outcomes: ['imported'],
      counts: { imported: 1 }
    });
    expect(inst.pipelines.workspace).toEqual([]);
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
    const staleRun = await commitPackage(staleInst, stalePlan, 'workspace', {
      phaseRevision: 'moved-on'
    });
    exchangeAudits(staleRun.audits).forEach(record);

    const okInst = installation();
    const okPlan = await planFor(okInst, PLANTED_PACKAGE);
    const okRun = await commitPackage(okInst, okPlan, 'workspace');
    exchangeAudits(okRun.audits).forEach(record);

    const partialInst = installation();
    const partialPlan = await planFor(partialInst, PLANTED_PACKAGE);
    const partialRun = await commitPackage(partialInst, partialPlan, 'workspace', {
      failOn: 'pipelines'
    });
    exchangeAudits(partialRun.audits).forEach(record);

    expect([...seen].sort()).toEqual([
      'process-exchange-import-committed/phase/imported',
      'process-exchange-import-committed/pipeline/imported',
      'process-exchange-import-refused/phase/stale-catalog',
      'process-exchange-import-refused/pipeline/duplicate-id',
      'process-exchange-import-refused/pipeline/persistence-failed'
    ]);
  });
});
