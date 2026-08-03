// Feature 085 T030 — package preflight, end to end through the sidebar command.
//
// Two things this file exists to pin, and they are the two halves of FR-055a.
//
//   1. The REQUEST carries no resource kind. The operator opens a document; the
//      host reads its declared `kind:` and dispatches on that. Asking an
//      operator to classify a file before opening it makes "chose the wrong
//      per-kind action" a reachable failure, and the fix is to make it
//      unrepresentable rather than to handle it. The same command object,
//      byte for byte, is sent for a Phase document and for a package below.
//
//   2. An `import` row carries the definition the confirmed write will store,
//      VERBATIM (FR-029a/b). The host retains nothing between preflight and
//      confirmation, so the plan is the only place that value can live. It is
//      the one field on the row that is deliberately not sanitized or bounded:
//      FR-046a forbids rewriting a declared value, and the display caps would
//      truncate an instruction. The sanitizer test below asserts exactly that
//      split — the rendered `name` is redacted, the carried `definition` is not.
//
// The harness mirrors `phase-preflight.test.ts`, adding `readPipelineConfig`,
// because the package path scans both catalogs.

import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';

type OpenResult =
  | { outcome: 'read'; bytes: Uint8Array }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; message: string };

interface Harness {
  readonly ctx: Parameters<typeof preflightHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly writePhaseConfig: ReturnType<typeof vi.fn>;
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    text?: string;
    pipelines?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
    phases?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
    sanitize?: (value: string) => string;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const writePhaseConfig = vi.fn();
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

  const openProcessYamlDocument = async (): Promise<OpenResult> => ({
    outcome: 'read',
    bytes: new Uint8Array(Buffer.from(opts.text ?? '', 'utf8'))
  });

  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        user: opts.phases?.user ?? [],
        workspace: opts.phases?.workspace ?? []
      }),
      readPipelineConfig: () => ({
        user: opts.pipelines?.user ?? [],
        workspace: opts.pipelines?.workspace ?? []
      }),
      writePhaseConfig,
      updateConfig,
      executeCommand,
      openProcessYamlDocument,
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: opts.sanitize ?? ((s: string) => s)
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'pipeline-preflight-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, acks, writePhaseConfig, updateConfig, executeCommand };
}

/**
 * The whole command. There is no kind on it, and no location, scope, or bytes
 * either — the document says what it is.
 */
const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'pipeline-preflight-1',
  payload: {}
});

function resultOf(h: Harness): PreflightProcessYamlResult {
  expect(h.acks).toHaveLength(1);
  return h.acks[0]!.result as PreflightProcessYamlResult;
}

async function preflight(opts: Parameters<typeof buildHarness>[0]): Promise<{
  readonly harness: Harness;
  readonly result: PreflightProcessYamlResult;
}> {
  const harness = buildHarness(opts);
  await preflightHandler(harness.ctx, COMMAND);
  return { harness, result: resultOf(harness) };
}

const PHASE_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Phase',
  'metadata:',
  '  phaseId: ship-it-phase',
  '  name: Ship It Phase',
  '  version: 1',
  'spec:',
  '  instruction: Ship the thing.',
  ''
].join('\n');

/** A package with every field the format carries, so `definition` is worth comparing. */
const PACKAGE_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Pipeline',
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  '  description: Specify, then plan.',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - plan',
  '  inputs:',
  '    - portId: feature-brief',
  '      label: Feature brief',
  '      type: text',
  '      required: true',
  '  outputs:',
  '    - portId: plan-document',
  '      label: Plan',
  '      type: markdown',
  '  bindings:',
  '    - kind: input',
  '      phaseIndex: 0',
  '      inputKey: brief',
  '      source:',
  '        from: pipeline-input',
  '        portId: feature-brief',
  '  executionDefaults:',
  '    runner: claude',
  '    model: opus',
  '    effort: high',
  '    timeoutSeconds: 900',
  '  recommendedNext:',
  '    - review-it',
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
  '        skill: speckit-plan',
  '        effort: high',
  ''
].join('\n');

describe('Feature 085 — package preflight dispatches on the declared kind (FR-055a)', () => {
  it('carries no resource kind on the request', () => {
    // Structural, not stylistic: a kind on the request is a decision the
    // operator would have to make before opening the file, and therefore a way
    // to get it wrong. `PreflightProcessYamlRequest` is `Record<string, never>`.
    expect(Object.keys(COMMAND.payload)).toEqual([]);
  });

  it('routes a Pipeline document to the package path and a Phase document to the Phase path', async () => {
    // The same frozen command for both. Only the bytes differ.
    const pkg = await preflight({ text: PACKAGE_DOCUMENT });
    expect(pkg.result.outcome).toBe('planned');
    if (pkg.result.outcome !== 'planned') return;
    expect(pkg.result.plan.rows.map((row) => row.resourceKind)).toEqual([
      'pipeline',
      'phase',
      'phase'
    ]);

    const phase = await preflight({ text: PHASE_DOCUMENT });
    expect(phase.result.outcome).toBe('planned');
    if (phase.result.outcome !== 'planned') return;
    expect(phase.result.plan.rows.map((row) => row.resourceKind)).toEqual(['phase']);
  });

  it('refuses a kind this build does not read, with no plan', async () => {
    // Foreign on purpose — naming a kind Schegent intends to add would make this
    // pass for the wrong reason the release that kind ships.
    const { result } = await preflight({
      text: 'apiVersion: schegent/v1\nkind: Deployment\nmetadata:\n  id: ship-it\n'
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('unsupported-kind');
    expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
  });

  it('writes nothing while planning a package', async () => {
    const { harness } = await preflight({ text: PACKAGE_DOCUMENT });

    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
    expect(harness.updateConfig).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });
});

describe('Feature 085 — an import row carries what the write will store (FR-029a/b)', () => {
  it('carries the root Pipeline definition verbatim, absent lists read back as empty', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'pipeline') return;
    // `toEqual`, not `toMatchObject`: a field the mapper starts dropping or
    // inventing has to fail here rather than surface later as a lossy round trip.
    expect(root.definition).toEqual({
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 3,
      description: 'Specify, then plan.',
      phaseIds: ['specify', 'plan'],
      inputs: [
        { portId: 'feature-brief', label: 'Feature brief', type: 'text', required: true }
      ],
      outputs: [{ portId: 'plan-document', label: 'Plan', type: 'markdown' }],
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'feature-brief' }
        }
      ],
      executionDefaults: {
        runner: 'claude',
        model: 'opus',
        effort: 'high',
        timeoutSeconds: 900
      },
      recommendedNext: ['review-it']
    });
  });

  it('carries each included Phase definition verbatim', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const included = result.plan.rows
      .filter((row) => row.resourceKind === 'phase')
      .map((row) => (row.outcome === 'import' ? row.definition : null));

    expect(included).toEqual([
      { phaseId: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { phaseId: 'plan', name: 'Plan', version: 5, skill: 'speckit-plan', effort: 'high' }
    ]);
  });

  it('sanitizes the rendered name and leaves the carried definition untouched', async () => {
    // The split is the point. `name` is rendered to the operator, so it goes
    // through the redactor; `definition` is forwarded to the save command, whose
    // own validator is the gate, so rewriting it would silently change what the
    // operator agreed to import.
    const { result } = await preflight({
      text: PACKAGE_DOCUMENT,
      sanitize: (value) => value.replaceAll('Ship', '[redacted]')
    });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'pipeline') return;
    expect(root.name).toBe('[redacted] It');
    expect(root.definition.name).toBe('Ship It');
    expect(root.definition.pipelineId).toBe('ship-it');
  });

  it('reports both writable layer revisions the plan was computed against', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(Object.keys(result.plan.computedAgainstRevision).sort()).toEqual([
      'user',
      'workspace'
    ]);
    expect(BUILT_IN_PIPELINES.some((pipeline) => pipeline.id === 'ship-it')).toBe(false);
  });

  it('counts one bucket per outcome, summing to the row count (FR-028)', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const { counts, rows } = result.plan;
    expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
    expect(counts).toEqual({ import: 3, skip: 0, blocked: 0, invalid: 0 });
  });
});

// Feature 085 T051/T054 — FR-031 at the boundary the operator actually hits.
//
// `pipeline-document.test.ts` pins the rule against the reader; this pins that a
// document-level refusal survives the whole command path — refused, named, no
// plan, and nothing the document declared echoed back.
describe('Feature 085 — a package cannot declare one id twice (FR-031)', () => {
  const DUPLICATED = PACKAGE_DOCUMENT.replace(
    ['    - metadata:', '        phaseId: plan', '        name: Plan', '        version: 5'].join(
      '\n'
    ),
    ['    - metadata:', '        phaseId: specify', '        name: Plan', '        version: 5'].join(
      '\n'
    )
  );

  it('refuses the document rather than letting one of the two win', async () => {
    const { harness, result } = await preflight({ text: DUPLICATED });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('duplicate-id');
    expect(result.refusal.message).toContain('specify');

    // FR-029 — no plan, not even an empty one, and no partial plan holding the
    // one resource that was unambiguous.
    expect(Object.keys(result).sort()).toEqual(['outcome', 'refusal']);
    expect(harness.acks[0]!.status).toBe('rejected');
    expect(harness.acks[0]!.reason).toBe('refused');
  });

  it('writes nothing, because a refusal never reaches a save', async () => {
    const harness = buildHarness({ text: DUPLICATED });
    await preflightHandler(harness.ctx, COMMAND);
    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
    expect(harness.updateConfig).not.toHaveBeenCalled();
  });

  it('still plans the same document once the duplicate is resolved', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
  });
});
