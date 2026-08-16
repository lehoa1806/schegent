// Feature 084 T052/T054/T055/T056 — what the exchange records, and what it
// refuses to record.
//
// Three separate invariants meet in this file because they are all about the
// same boundary — what an exchange operation is allowed to say about itself:
//
//   T054 (FR-047, FR-048) — an audit entry carries operation, resource ids,
//     scope, per-resource outcomes, and counts. Never document contents,
//     instruction or skill text, a file name, an absolute path, or a workspace
//     root.
//   T055 (FR-049) — a refusal and a capability denial each leave a record, and
//     an import that never happened leaves none. All three are distinguishable.
//   T056 (FR-010, FR-046) — the document has no say in which layer is written.
//
// T052 closes the export side: the emitted document's key set is a closed
// allowlist, so a runtime-only field, a session value, or a secret cannot ride
// out inside a Phase.
//
// The tokens planted below are deliberately unlike any legitimate value, so an
// assertion that one is absent fails on a real leak rather than on a coincidence.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace'
}));
// A root whose own name is a planted token, so "no workspace root in the log"
// is checked against something that could only appear by being copied. Feature
// 059's trust payload records the BASENAME by design (I-6) — that is why the
// basename here is an unremarkable word and the token sits above it.
const WORKSPACE_ROOT = '/Users/planted/ws/AUDIT-ROOT-TOKEN-ZZ9/checkout';
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/Users/planted/ws/AUDIT-ROOT-TOKEN-ZZ9/checkout' },
    name: 'checkout',
    index: 0
  })
}));

import { phaseLayerRevision } from '../../../src/config/process-catalog';
import { CMD_EXPORT_PROCESS_YAML, CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { WritablePhaseDefinitionScope } from '../../../src/contracts/process-definitions';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand } from '../../../src/ui/sidebar/messages';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

/**
 * Every field a Phase document can carry, so the key-set allowlist below is a
 * closed set rather than a description of one example (T052).
 */
const MAXIMAL_PHASE = Object.freeze({
  phaseId: 'audited-phase',
  name: 'NAME-TOKEN-ZZ1',
  description: 'DESCRIPTION-TOKEN-ZZ2',
  version: 5,
  instruction: 'INSTRUCTION-TOKEN-ZZ3 and a planted sk-secret-value-ZZ8',
  model: 'claude-opus-5',
  effort: 'high',
  timeoutSeconds: 900,
  loopable: true,
  isRequired: false,
  retryCondition: 'open_questions > 0',
  runner: 'claude'
});

/**
 * The complete set of keys a Phase document may name. Nothing here is a runtime
 * field, a session value, a run history entry, an audit field, or a result.
 */
const DOCUMENT_KEY_ALLOWLIST = [
  'apiVersion',
  'description',
  'effort',
  'instruction',
  'isRequired',
  'kind',
  'loopable',
  'metadata',
  'model',
  'name',
  'phaseId',
  'retryCondition',
  'runner',
  'spec',
  'timeoutSeconds',
  'version'
] as const;

/** Names the exchange must never emit, per FR-009 and the spec's QS-4. */
const FORBIDDEN_DOCUMENT_KEYS = [
  'sideEffects',
  'evidencePolicy',
  'promptVersion',
  'sourceScope',
  'sessionId',
  'runId',
  'transcript',
  'auditLog',
  'lastResult',
  'apiKey',
  'token'
] as const;

/** Content the audit log must not carry, whatever the document said. */
const FORBIDDEN_AUDIT_TOKENS = [
  'NAME-TOKEN-ZZ1',
  'DESCRIPTION-TOKEN-ZZ2',
  'INSTRUCTION-TOKEN-ZZ3',
  'sk-secret-value-ZZ8',
  'AUDIT-ROOT-TOKEN-ZZ9',
  WORKSPACE_ROOT,
  'audited-phase.phase.yaml',
  'open_questions > 0'
] as const;

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function document(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Phase', ...body, ''].join('\n');
}

/**
 * A document that clears the version gate and fails the kind gate, so a test
 * using it is pinning `unsupported-kind` and not whichever gate happens to run
 * first. A bare `kind: Deployment` would refuse as `unsupported-version`.
 *
 * The kind is foreign on purpose. This was `Pipeline` until feature 085 taught
 * the handler to read one; a fixture standing for "a kind this build does not
 * read" must not name a kind Schegent intends to add, or it quietly stops
 * testing the gate it was written for.
 */
const REFUSED_DOCUMENT = 'apiVersion: schegent/v1\nkind: Deployment\n';

/** A valid document with every planted token in it. */
const PLANTED_DOCUMENT = document([
  'metadata:',
  '  phaseId: audited-phase',
  '  name: NAME-TOKEN-ZZ1',
  '  description: DESCRIPTION-TOKEN-ZZ2',
  '  version: 5',
  'spec:',
  '  instruction: INSTRUCTION-TOKEN-ZZ3 and a planted sk-secret-value-ZZ8'
]);

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

interface PreflightRun {
  readonly result: PreflightProcessYamlResult;
  readonly audits: readonly AuditEntry[];
  readonly ack: CommandAckMessage;
  readonly warnings: readonly string[];
}

async function preflight(
  opened:
    | { readonly outcome: 'read'; readonly bytes: Uint8Array }
    | { readonly outcome: 'canceled' }
    | { readonly outcome: 'failed' },
  opts: {
    readonly user?: readonly unknown[];
    readonly workspace?: readonly unknown[];
    readonly auditThrows?: Error;
    readonly withAudit?: boolean;
  } = {}
): Promise<PreflightRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const warnings: string[] = [];
  const audit = {
    append: async (entry: AuditEntry) => {
      if (opts.auditThrows) throw opts.auditThrows;
      audits.push(entry);
      return undefined;
    }
  };
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: opts.user ?? [], workspace: opts.workspace ?? [] }),
      openProcessYamlDocument: async () => opened,
      ...(opts.withAudit === false ? {} : { audit }),
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'audit-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'audit-test-1',
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return {
    result: acks[0]!.result as PreflightProcessYamlResult,
    audits,
    ack: acks[0]!,
    warnings
  };
}

interface ExportRun {
  readonly audits: readonly AuditEntry[];
  readonly saved: readonly { suggestedFileName: string; text: string }[];
  readonly ack: CommandAckMessage;
}

async function exportPhase(
  resourceId: string,
  layers: { readonly user?: readonly unknown[]; readonly workspace?: readonly unknown[] }
): Promise<ExportRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: layers.user ?? [], workspace: layers.workspace ?? [] }),
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
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'audit-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: ExportProcessYamlCommand = {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'audit-test-1',
    payload: { resourceKind: 'phase', resourceId }
  };
  await exportHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { audits, saved, ack: acks[0]! };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly audits: readonly AuditEntry[];
  readonly writes: readonly { scope: string; value: readonly unknown[] }[];
}

/** The request the webview builds from a plan — the operator's scope, not the document's. */
function commitCommand(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  layer: readonly unknown[]
): SavePhasesCommand {
  const row = plan.rows.find(
    (candidate) => candidate.outcome === 'import' && candidate.resourceKind === 'phase'
  );
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import' || row.resourceKind !== 'phase') {
    throw new Error('unreachable');
  }
  const { phaseId, ...declared } = row.definition;
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'audit-test-1',
    payload: {
      scope,
      expectedRevision: plan.computedAgainstRevision[scope],
      mutation: { kind: 'import', phaseId },
      phases: [...layer, { id: phaseId, ...declared }]
    }
  };
}

async function commit(
  command: SavePhasesCommand,
  layers: { user: readonly unknown[]; workspace: readonly unknown[] }
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const writes: { scope: string; value: readonly unknown[] }[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: layers.user, workspace: layers.workspace }),
      updateConfig: async (key: string, value: unknown, scope: WritablePhaseDefinitionScope) => {
        expect(key).toBe('phases');
        writes.push({ scope, value: value as readonly unknown[] });
        layers[scope] = value as readonly unknown[];
      },
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'audit-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await saveHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { ack: acks[0]!, audits, writes };
}

async function planFor(text: string, layer: readonly unknown[] = []): Promise<ImportPlan> {
  const { result } = await preflight({ outcome: 'read', bytes: bytes(text) }, { user: layer });
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

beforeEach(() => {
  capabilities.clear();
});

// ---------------------------------------------------------------------------
// T052 — the exported document's key set is a closed allowlist
// ---------------------------------------------------------------------------

describe('Feature 084 — an exported document names only portable fields (T052, FR-009, SC-008)', () => {
  it('emits exactly the allowlisted keys for a maximally populated Phase', async () => {
    const run = await exportPhase('audited-phase', { user: [MAXIMAL_PHASE] });
    expect(run.saved).toHaveLength(1);

    const keys = run.saved[0]!.text
      .split('\n')
      .map((line) => line.match(/^\s*([A-Za-z][A-Za-z0-9]*):/)?.[1])
      .filter((key): key is string => key !== undefined);
    // Every emitted key, deduplicated, must be in the allowlist — and the
    // allowlist must be fully exercised, so a field the mapper silently stopped
    // emitting is a failure here too.
    expect([...new Set(keys)].sort()).toEqual([...DOCUMENT_KEY_ALLOWLIST]);
  });

  it('names no runtime-only field, session value, run history, audit field, result, or secret', async () => {
    const run = await exportPhase('audited-phase', { user: [MAXIMAL_PHASE] });
    const text = run.saved[0]!.text;
    for (const forbidden of FORBIDDEN_DOCUMENT_KEYS) {
      expect(text, `${forbidden} must not appear in an exported document`).not.toContain(forbidden);
    }
    // The allowlist itself is the guard: nothing forbidden is in it.
    for (const forbidden of FORBIDDEN_DOCUMENT_KEYS) {
      expect(DOCUMENT_KEY_ALLOWLIST as readonly string[]).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// T054 — the audit payload is bounded
// ---------------------------------------------------------------------------

describe('Feature 084 — the audit records the operation, not the document (T054, FR-047, FR-048)', () => {
  it('bounds an export entry to operation, ids, scope, outcomes, and counts', async () => {
    const run = await exportPhase('audited-phase', { user: [MAXIMAL_PHASE] });
    expect(run.audits).toHaveLength(1);
    const entry = run.audits[0]!;
    expect(Object.keys(entry.payload).sort()).toEqual([
      'counts',
      'operation',
      'outcomes',
      'resourceIds',
      'resourceKind',
      'scope'
    ]);
    // The id is what FR-047 permits; the name beside it in the same record is not.
    expect(entry.payload.resourceIds).toEqual(['audited-phase']);
  });

  it('bounds a refusal entry to the same five fields', async () => {
    const run = await preflight({ outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) });
    expect(run.audits).toHaveLength(1);
    expect(Object.keys(run.audits[0]!.payload).sort()).toEqual([
      'counts',
      'operation',
      'outcomes',
      'resourceIds',
      'resourceKind',
      'scope'
    ]);
  });

  it('carries no document content out of an export, though the document held all of it', async () => {
    const run = await exportPhase('audited-phase', { user: [MAXIMAL_PHASE] });
    // The document itself proves the tokens were reachable — otherwise the
    // absence below would say nothing.
    const text = run.saved[0]!.text;
    expect(text).toContain('NAME-TOKEN-ZZ1');
    expect(text).toContain('INSTRUCTION-TOKEN-ZZ3');
    expect(text).toContain('open_questions > 0');

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
  });

  it('carries no document content out of a refusal, and no refusal message', async () => {
    // A document that declares a name and an instruction and is still refused,
    // so the refusal path has content available to leak.
    const refused = [
      'apiVersion: schegent/v2',
      'kind: Phase',
      'metadata:',
      '  phaseId: audited-phase',
      '  name: NAME-TOKEN-ZZ1',
      'spec:',
      '  instruction: INSTRUCTION-TOKEN-ZZ3 and a planted sk-secret-value-ZZ8',
      ''
    ].join('\n');
    const run = await preflight({ outcome: 'read', bytes: bytes(refused) });

    expect(run.result.outcome).toBe('refused');
    if (run.result.outcome !== 'refused') throw new Error('unreachable');
    const message = run.result.refusal.message;

    const serialized = JSON.stringify(run.audits);
    for (const token of FORBIDDEN_AUDIT_TOKENS) {
      expect(serialized, `${token} must not reach the audit log`).not.toContain(token);
    }
    // The operator sees the message; the log sees only the code. A message
    // quotes what the document declared, which is exactly what FR-048 excludes.
    expect(message.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(message);
    expect(run.audits[0]!.payload.outcomes).toEqual(['unsupported-version']);
  });

  it('records the refusal code as one of the closed set, never document-derived text', async () => {
    // Every code that a document can trigger through this handler, so the
    // `outcomes` field is provably drawn from a fixed vocabulary.
    const cases = [
      { text: '', code: 'empty' },
      { text: 'apiVersion: schegent/v2\nkind: Phase\n', code: 'unsupported-version' },
      { text: 'apiVersion: schegent/v1\nkind: Deployment\n', code: 'unsupported-kind' },
      { text: 'apiVersion: schegent/v1\nkind: Phase\nmetadata: &a {}\n', code: 'disallowed-syntax' },
      { text: 'apiVersion: schegent/v1\nkind: Phase\n---\nkind: Phase\n', code: 'multi-document' },
      { text: 'x'.repeat(PHASE_YAML_MAX_BYTES + 1), code: 'too-large' }
    ] as const;

    const recorded: string[] = [];
    for (const testCase of cases) {
      const run = await preflight({ outcome: 'read', bytes: bytes(testCase.text) });
      expect(run.audits).toHaveLength(1);
      expect(run.audits[0]!.payload.outcomes).toEqual([testCase.code]);
      recorded.push(testCase.code);
    }
    // Distinct codes produce distinct records, so the log says which wall the
    // document hit rather than only that it hit one.
    expect(new Set(recorded).size).toBe(cases.length);
  });

  it('names no scope and no resource for a document-level refusal', async () => {
    const run = await preflight({ outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) });
    expect(run.audits[0]!.payload).toEqual({
      operation: 'import-preflight',
      resourceKind: 'phase',
      resourceIds: [],
      scope: null,
      outcomes: ['unsupported-kind'],
      counts: { refused: 1 }
    });
  });
});

// ---------------------------------------------------------------------------
// T055 — refusal, denial, and never-happened are distinguishable
// ---------------------------------------------------------------------------

describe('Feature 084 — a blocked import is distinguishable from one that never happened (T055, FR-049)', () => {
  it('records a refused document as a refusal', async () => {
    const run = await preflight({ outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) });
    expect(run.audits).toHaveLength(1);
    expect(run.audits[0]!.eventType).toBe('process-exchange-import-refused');
    expect(run.audits[0]!.outcome).toBe('info');
    expect(run.audits[0]!.runId).toBe('process-exchange:import-preflight');
  });

  it('records a capability denial as a denial, and writes nothing', async () => {
    capabilities.set('phases', false);
    const layers = { user: [] as readonly unknown[], workspace: [] as readonly unknown[] };
    const plan = await planFor(PLANTED_DOCUMENT);
    const revisionBefore = phaseLayerRevision(layers.user);

    const run = await commit(commitCommand(plan, 'user', layers.user), layers);

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('trust-denied');
    expect(run.writes).toHaveLength(0);
    expect(phaseLayerRevision(layers.user)).toBe(revisionBefore);

    const denials = run.audits.filter((entry) => entry.eventType === 'trust.capability-denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]!.payload).toMatchObject({ capability: 'phases' });
    // A denial is not an exchange operation, so it does not borrow the
    // exchange event type — the two are told apart by `eventType`.
    expect(run.audits.some((entry) => entry.eventType.startsWith('process-exchange'))).toBe(false);
  });

  it('records the workspace basename but never the root, on the denial path', async () => {
    capabilities.set('phases', false);
    const layers = { user: [] as readonly unknown[], workspace: [] as readonly unknown[] };
    const plan = await planFor(PLANTED_DOCUMENT);
    const run = await commit(commitCommand(plan, 'user', layers.user), layers);

    const serialized = JSON.stringify(run.audits);
    // Feature 059 I-6: the basename is the deliberate disclosure.
    expect(serialized).toContain('checkout');
    expect(serialized).not.toContain(WORKSPACE_ROOT);
    expect(serialized).not.toContain('AUDIT-ROOT-TOKEN-ZZ9');
  });

  it('records nothing when the operator closes the dialog', async () => {
    const run = await preflight({ outcome: 'canceled' });
    expect(run.result).toEqual({ outcome: 'canceled' });
    expect(run.audits).toEqual([]);
  });

  it('records nothing when the read fails before any document exists', async () => {
    const run = await preflight({ outcome: 'failed' });
    expect(run.result.outcome).toBe('failed');
    expect(run.audits).toEqual([]);
  });

  it('records nothing for a plan, because a plan changes nothing', async () => {
    const run = await preflight({ outcome: 'read', bytes: bytes(PLANTED_DOCUMENT) });
    expect(run.result.outcome).toBe('planned');
    expect(run.audits).toEqual([]);
  });

  it('still refuses when the audit cannot be written, and warns', async () => {
    const run = await preflight(
      { outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) },
      { auditThrows: new Error('log volume full') }
    );
    // The operator's answer is unchanged by a logging failure.
    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('refused');
    expect(run.result.outcome).toBe('refused');
    expect(run.warnings.some((line) => line.includes('audit append failed'))).toBe(true);
  });

  it('still refuses in a window with no audit sink at all', async () => {
    const run = await preflight(
      { outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) },
      { withAudit: false }
    );
    expect(run.result.outcome).toBe('refused');
    expect(run.ack.reason).toBe('refused');
  });
});

// ---------------------------------------------------------------------------
// T056 — the document cannot encode or influence the target scope
// ---------------------------------------------------------------------------

describe('Feature 084 — the document has no say in the target layer (T056, FR-010, FR-046)', () => {
  for (const field of ['scope', 'sourceScope', 'targetScope'] as const) {
    it(`rejects a document declaring metadata.${field}`, async () => {
      const plan = await planFor(
        document([
          'metadata:',
          '  phaseId: audited-phase',
          '  name: Audited Phase',
          '  version: 1',
          `  ${field}: workspace`,
          'spec:',
          '  instruction: Do the thing.'
        ])
      );
      expect(plan.counts).toEqual({ import: 0, skip: 0, invalid: 1, blocked: 0 });
      const row = plan.rows[0]!;
      expect(row.outcome).toBe('invalid');
      if (row.outcome !== 'invalid') throw new Error('unreachable');
      expect(row.defects.some((defect) => defect.field.includes(field))).toBe(true);
    });

    it(`rejects a document declaring spec.${field}`, async () => {
      const plan = await planFor(
        document([
          'metadata:',
          '  phaseId: audited-phase',
          '  name: Audited Phase',
          '  version: 1',
          'spec:',
          '  instruction: Do the thing.',
          `  ${field}: user`
        ])
      );
      expect(plan.counts.invalid).toBe(1);
    });
  }

  it('carries no scope on the plan or any of its rows', async () => {
    const plan = await planFor(PLANTED_DOCUMENT);
    expect(Object.keys(plan).sort()).toEqual(['computedAgainstRevision', 'counts', 'rows']);
    const row = plan.rows[0]!;
    expect(row.outcome).toBe('import');
    if (row.outcome !== 'import') throw new Error('unreachable');
    if (row.resourceKind === 'modelCatalog') throw new Error('unreachable');
    expect(Object.keys(row.definition)).not.toContain('scope');
    expect(Object.keys(row.definition)).not.toContain('sourceScope');
  });

  it('writes the same bytes to whichever layer the operator chose', async () => {
    for (const scope of ['user', 'workspace'] as const) {
      const layers = { user: [] as readonly unknown[], workspace: [] as readonly unknown[] };
      const plan = await planFor(PLANTED_DOCUMENT);
      const run = await commit(commitCommand(plan, scope, layers[scope]), layers);

      expect(run.ack.status).toBe('accepted');
      expect(run.writes).toHaveLength(1);
      expect(run.writes[0]!.scope).toBe(scope);
      // The layer the operator did not choose is untouched.
      const other = scope === 'user' ? 'workspace' : 'user';
      expect(layers[other]).toEqual([]);
      expect(layers[scope]).toHaveLength(1);
    }
  });

  it('records no scope for the preflight, because a preflight targets no layer', async () => {
    const run = await preflight({ outcome: 'read', bytes: bytes(REFUSED_DOCUMENT) });
    expect(run.audits[0]!.payload.scope).toBeNull();
  });

  it('records the layer an export actually resolved from, not one a document claimed', async () => {
    // The same id in both writable layers. The workspace layer wins, and the
    // audit says so, because the catalog decided it — not the document.
    const run = await exportPhase('audited-phase', {
      user: [MAXIMAL_PHASE],
      workspace: [{ ...MAXIMAL_PHASE, name: 'Workspace Wins' }]
    });
    expect(run.audits[0]!.payload.scope).toBe('workspace');
    expect(run.saved[0]!.text).toContain('name: Workspace Wins');
  });
});
