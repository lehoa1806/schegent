// Feature 086 T031/T033 — Workflow package preflight, end to end through the
// sidebar command.
//
// The third kind reaches the same command the other two do, and the request is
// still empty (FR-058). That is the property worth pinning at this level: the
// operator opens a document, the host reads its declared `kind:` and dispatches
// on that. A kind on the REQUEST would be a decision the operator has to make
// before opening the file, and therefore a way to get it wrong — the fix is to
// make it unrepresentable rather than to handle it. The same frozen command
// object is sent for a Phase document, a Pipeline package, and a Workflow
// package below.
//
// The other half is refusal. A document-level refusal is a statement about the
// whole document, so it produces NO plan — not an empty one, and not the rows
// read before the problem was found (FR-026, FR-027, SC-010, SC-020). Each code
// is asserted through the real command path rather than against the reader,
// because a refusal that the reader produces and the command turns into a plan
// with zero rows would satisfy a unit test and still mislead an operator.
//
// The harness mirrors `pipeline-preflight.test.ts`, adding `readWorkflowConfig`,
// because a Workflow package is planned against three catalogs.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { DEFECT_FIELD_MAX } from '../../../src/services/process-yaml/phase-yaml-validator';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';

type OpenResult =
  | { outcome: 'read'; bytes: Uint8Array }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; message: string };

interface Harness {
  readonly ctx: Parameters<typeof preflightHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly warnings: string[];
  readonly writePhaseConfig: ReturnType<typeof vi.fn>;
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    text?: string;
    bytes?: Uint8Array;
    workflows?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
    pipelines?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
    phases?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
    sanitize?: (value: string) => string;
    /** Feature 086 T071 — what the host-side read reports, when not a clean read. */
    open?: OpenResult;
    /** Feature 086 T071 — the adapter rejecting rather than reporting. */
    openThrows?: Error;
    /** Feature 086 T071 — a window with no read seam wired at all. */
    withOpenAdapter?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const writePhaseConfig = vi.fn();
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

  const openProcessYamlDocument = async (): Promise<OpenResult> => {
    if (opts.openThrows) throw opts.openThrows;
    return (
      opts.open ?? {
        outcome: 'read',
        bytes: opts.bytes ?? new Uint8Array(Buffer.from(opts.text ?? '', 'utf8'))
      }
    );
  };

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
      readWorkflowConfig: () => ({
        user: opts.workflows?.user ?? [],
        workspace: opts.workflows?.workspace ?? []
      }),
      writePhaseConfig,
      updateConfig,
      executeCommand,
      ...(opts.withOpenAdapter === false ? {} : { openProcessYamlDocument }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: opts.sanitize ?? ((s: string) => s)
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'workflow-preflight-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, acks, warnings, writePhaseConfig, updateConfig, executeCommand };
}

/**
 * The whole command, for all three kinds. No kind on it, and no location, scope,
 * or bytes either — the document says what it is.
 */
const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'workflow-preflight-1',
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

async function refusalOf(opts: Parameters<typeof buildHarness>[0]): Promise<{
  readonly code: string;
  readonly keys: readonly string[];
  readonly harness: Harness;
}> {
  const { harness, result } = await preflight(opts);
  expect(result.outcome).toBe('refused');
  if (result.outcome !== 'refused') throw new Error(`expected a refusal, got ${result.outcome}`);
  return { code: result.refusal.code, keys: Object.keys(result).sort(), harness };
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

const PIPELINE_DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Pipeline',
  'metadata:',
  '  id: spec-authoring',
  '  name: Spec Authoring',
  '  version: 2',
  'spec:',
  '  phaseIds:',
  '    - ship-it-phase',
  ''
].join('\n');

/** One `included.*` entry at the indent the emitter writes it, for either kind. */
function includedResource(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

const INCLUDED_SPEC_AUTHORING = includedResource(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  [
    'phaseIds:',
    '  - specify',
    'outputs:',
    '  - portId: spec-document',
    '    label: Spec',
    '    type: markdown'
  ]
);

const INCLUDED_SPEC_REVIEW = includedResource(
  ['id: spec-review', 'name: Spec Review', 'version: 1'],
  [
    'phaseIds:',
    '  - specify',
    'inputs:',
    '  - portId: spec',
    '    label: Spec',
    // `text`, not `markdown`: `markdown` is an OUTPUT type, and the compatibility
    // table maps a `markdown` output to a `text` or `source` input. The fixture is
    // a graph US5's endpoint checks will accept, so a US5 change shows up there as
    // a real regression rather than as this fixture finally being read.
    '    type: text'
  ]
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

function workflowDocument(body: {
  readonly metadata?: readonly string[];
  readonly spec?: readonly string[];
  readonly pipelines?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
}): string {
  const lines = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    ...(body.metadata ?? ['id: ship-it-flow', 'name: Ship It Flow', 'version: 3']).map(
      (line) => `  ${line}`
    ),
    'spec:',
    ...(body.spec ?? DEFAULT_SPEC).map((line) => `  ${line}`)
  ];
  if (body.pipelines !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.pipelines !== undefined) lines.push('  pipelines:', ...body.pipelines.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

/** Two nodes, one connection between them, one start. */
const DEFAULT_SPEC = [
  'nodes:',
  '  - nodeId: draft',
  '    pipelineId: spec-authoring',
  '  - nodeId: review',
  '    pipelineId: spec-review',
  'connections:',
  '  - from:',
  '      nodeId: draft',
  '      portId: spec-document',
  '    to:',
  '      nodeId: review',
  '      portId: spec',
  'startNodeIds:',
  '  - draft'
];

/** Every field the format carries, so `definition` is worth comparing. */
const PACKAGE_DOCUMENT = workflowDocument({
  metadata: [
    'id: ship-it-flow',
    'name: Ship It Flow',
    'version: 3',
    'description: Draft, then review.'
  ],
  pipelines: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
  phases: [INCLUDED_SPECIFY]
});

describe('Feature 086 T033 — the host dispatches on the declared kind, for three kinds now (FR-058)', () => {
  it('carries no resource kind on the request', () => {
    // Structural, not stylistic: `PreflightProcessYamlRequest` is
    // `Record<string, never>`, and adding a third kind did not add a field.
    expect(Object.keys(COMMAND.payload)).toEqual([]);
  });

  it('routes a Workflow document to the Workflow path, with the request unchanged', async () => {
    // The same frozen command for all three. Only the bytes differ.
    const workflow = await preflight({ text: PACKAGE_DOCUMENT });
    expect(workflow.result.outcome).toBe('planned');
    if (workflow.result.outcome !== 'planned') return;
    expect(workflow.result.plan.rows.map((row) => row.resourceKind)).toEqual([
      'workflow',
      'pipeline',
      'pipeline',
      'phase'
    ]);

    const pipeline = await preflight({ text: PIPELINE_DOCUMENT });
    expect(pipeline.result.outcome).toBe('planned');
    if (pipeline.result.outcome !== 'planned') return;
    expect(pipeline.result.plan.rows.map((row) => row.resourceKind)).toEqual(['pipeline']);

    const phase = await preflight({ text: PHASE_DOCUMENT });
    expect(phase.result.outcome).toBe('planned');
    if (phase.result.outcome !== 'planned') return;
    expect(phase.result.plan.rows.map((row) => row.resourceKind)).toEqual(['phase']);
  });

  it('names all three kinds when it refuses one it does not read', async () => {
    // Foreign on purpose — naming a kind Schegent intends to add would make this
    // pass for the wrong reason the release that kind ships.
    const { result } = await preflight({
      text: 'apiVersion: schegent/v1\nkind: Deployment\nmetadata:\n  id: ship-it-flow\n'
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('unsupported-kind');
    // The message says what this build DOES read, so an operator who exported
    // from a newer build learns which kinds are available rather than only that
    // theirs is not.
    expect(result.refusal.message).toContain('Workflow');
  });

  it('writes nothing while planning a Workflow package (SC-008)', async () => {
    const { harness } = await preflight({ text: PACKAGE_DOCUMENT });

    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
    expect(harness.updateConfig).not.toHaveBeenCalled();
    expect(harness.executeCommand).not.toHaveBeenCalled();
  });
});

describe('Feature 086 T033 — an import row carries what the write will store (FR-029a/b)', () => {
  it('carries the root Workflow definition verbatim, absent lists read back as empty', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;
    // `toEqual`, not `toMatchObject`: a field the reader starts dropping or
    // inventing has to fail here rather than surface later as a lossy round trip.
    expect(root.definition).toEqual({
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 3,
      description: 'Draft, then review.',
      nodes: [
        { nodeId: 'draft', pipelineId: 'spec-authoring' },
        { nodeId: 'review', pipelineId: 'spec-review' }
      ],
      connections: [
        {
          from: { nodeId: 'draft', portId: 'spec-document' },
          to: { nodeId: 'review', portId: 'spec' }
        }
      ],
      startNodeIds: ['draft']
    });
  });

  it('carries each included definition verbatim, in the order the document declared', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const included = result.plan.rows
      .slice(1)
      .map((row) => (row.resourceKind !== 'modelCatalog' && row.outcome === 'import' ? row.definition : null));

    // The empty lists and `required: true` are the CATALOG's normalization, not the
    // exchange path rewriting a declared value: `readInputs`/`readOutputs`/
    // `readBindings`/`readRecommendedNext` return `[]` for an absent list, and an
    // input port's absent `required` defaults to true
    // (`src/config/pipeline-definition-validator.ts`). An import row carries the
    // definition the write will store, so it carries the validated value. What
    // `toEqual` pins here is that nothing ELSE was added, dropped, or altered —
    // `description` and `executionDefaults`, absent from the fixture, stay absent
    // rather than being materialized as undefined.
    expect(included).toEqual([
      {
        pipelineId: 'spec-authoring',
        name: 'Spec Authoring',
        version: 2,
        phaseIds: ['specify'],
        inputs: [],
        outputs: [{ portId: 'spec-document', label: 'Spec', type: 'markdown' }],
        bindings: [],
        recommendedNext: []
      },
      {
        pipelineId: 'spec-review',
        name: 'Spec Review',
        version: 1,
        phaseIds: ['specify'],
        inputs: [{ portId: 'spec', label: 'Spec', type: 'text', required: true }],
        outputs: [],
        bindings: [],
        recommendedNext: []
      },
      { phaseId: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' }
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
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;
    expect(root.name).toBe('[redacted] It Flow');
    expect(root.definition.name).toBe('Ship It Flow');
    expect(root.definition.workflowId).toBe('ship-it-flow');
  });

  it('reports one revision per layer this plan can write (FR-036)', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    for (const revisions of [
      result.plan.computedAgainstRevision,
      result.plan.computedAgainstPipelineRevision,
      result.plan.computedAgainstWorkflowRevision
    ]) {
      expect(Object.keys(revisions ?? {}).sort()).toEqual(['user', 'workspace']);
    }
    // The fixture's ids must not collide with a built-in, or a `skip` would be
    // asserted above as an `import` for the wrong reason.
    expect(BUILT_IN_PIPELINES.some((pipeline) => pipeline.id === 'spec-authoring')).toBe(false);
  });

  it('counts one bucket per outcome, summing to the row count (FR-028)', async () => {
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const { counts, rows } = result.plan;
    expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
    expect(counts).toEqual({ import: 4, skip: 0, blocked: 0, invalid: 0 });
  });

  it('bounds a Workflow defect field to the width the Workflow family already uses', async () => {
    // `connections[0].condition.left.source` is 36 characters. The Workflow
    // catalog validator and its projector both cap a field at 48 for exactly this
    // reason; a 32-cap at this boundary would hand the operator
    // `connections[0].condition.left.so` and no way to know what was cut.
    // Written out rather than spliced into `DEFAULT_SPEC`: `condition` is a sibling
    // of `from`/`to` on the connection item, and one indent level too deep makes it
    // an unknown field of `from` instead — a different defect, on a shorter path,
    // which would pass a `toBeLessThanOrEqual` assertion for the wrong reason.
    const withBadOperand = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    pipelineId: spec-authoring',
        '  - nodeId: review',
        '    pipelineId: spec-review',
        'connections:',
        '  - from:',
        '      nodeId: draft',
        '      portId: spec-document',
        '    to:',
        '      nodeId: review',
        '      portId: spec',
        '    condition:',
        '      left:',
        '        source: guesswork',
        '        nodeId: draft',
        '      operator: equals',
        '      right: done',
        'startNodeIds:',
        '  - draft'
      ],
      pipelines: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
      phases: [INCLUDED_SPECIFY]
    });

    const { result } = await preflight({ text: withBadOperand });
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    const [root] = result.plan.rows;
    expect(root?.outcome).toBe('invalid');
    if (root?.outcome !== 'invalid') return;
    expect(root.defects.map((defect) => defect.field)).toContain(
      'connections[0].condition.left.source'
    );
    for (const defect of root.defects) {
      expect(defect.field.length).toBeLessThanOrEqual(DEFECT_FIELD_MAX);
    }
  });
});

// Feature 086 T031 — every document-level refusal, through the command.
//
// A document-level refusal is a statement about the whole document: it produces
// no plan, not even an empty one, and not a partial plan holding the resources
// that were unambiguous (FR-026, FR-027, SC-010, SC-020). Eight codes reach this
// path; `graph-cycle` is the only one feature 086 adds, and it is asserted
// alongside the seven it inherits so a regression in any of them fails here.
describe('Feature 086 T031 — a refused Workflow document produces no plan (FR-027)', () => {
  it('refuses a cycle in the authored graph, which no traversal order can satisfy', async () => {
    // New in 086, and a document-level refusal rather than a field defect: a
    // cycle is a property of the graph as a whole, so there is no one node or
    // connection whose row could carry it.
    const cyclic = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    pipelineId: spec-authoring',
        '  - nodeId: review',
        '    pipelineId: spec-review',
        'connections:',
        '  - from:',
        '      nodeId: draft',
        '      portId: spec-document',
        '    to:',
        '      nodeId: review',
        '      portId: spec',
        '  - from:',
        '      nodeId: review',
        '      portId: verdict',
        '    to:',
        '      nodeId: draft',
        '      portId: notes',
        'startNodeIds:',
        '  - draft'
      ],
      pipelines: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_REVIEW],
      phases: [INCLUDED_SPECIFY]
    });

    const { code, keys, harness } = await refusalOf({ text: cyclic });

    expect(code).toBe('graph-cycle');
    expect(keys).toEqual(['outcome', 'refusal']);
    expect(harness.acks[0]!.status).toBe('rejected');
    expect(harness.acks[0]!.reason).toBe('refused');
    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
    expect(harness.updateConfig).not.toHaveBeenCalled();
  });

  it('refuses a self-edge, which is a cycle of one', async () => {
    const selfEdge = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    pipelineId: spec-authoring',
        'connections:',
        '  - from:',
        '      nodeId: draft',
        '      portId: spec-document',
        '    to:',
        '      nodeId: draft',
        '      portId: notes',
        'startNodeIds:',
        '  - draft'
      ]
    });

    const { code } = await refusalOf({ text: selfEdge });
    expect(code).toBe('graph-cycle');
  });

  it('refuses a document declaring one id twice, rather than letting one win', async () => {
    for (const text of [
      workflowDocument({ pipelines: [INCLUDED_SPEC_AUTHORING, INCLUDED_SPEC_AUTHORING] }),
      workflowDocument({ phases: [INCLUDED_SPECIFY, INCLUDED_SPECIFY] })
    ]) {
      const { code, keys } = await refusalOf({ text });
      expect(code).toBe('duplicate-id');
      expect(keys).toEqual(['outcome', 'refusal']);
    }
  });

  it('refuses a second document in the same file', async () => {
    const { code, keys } = await refusalOf({
      text: `${PACKAGE_DOCUMENT}---\napiVersion: schegent/v1\nkind: Workflow\n`
    });
    expect(code).toBe('multi-document');
    expect(keys).toEqual(['outcome', 'refusal']);
  });

  it('refuses a kind and an apiVersion this build does not read, version first', async () => {
    // Version before kind, matching both readers and the dispatch: a `kind` this
    // build does not know, under an `apiVersion` it does not know either, is a
    // document from another format, and naming its kind unsupported would judge
    // it by a vocabulary that may not be its own.
    expect((await refusalOf({ text: 'apiVersion: schegent/v1\nkind: Fleet\n' })).code).toBe(
      'unsupported-kind'
    );
    expect((await refusalOf({ text: 'apiVersion: schegent/v9\nkind: Fleet\n' })).code).toBe(
      'unsupported-version'
    );
  });

  it('refuses syntax outside the closed subset, before any declared value is built', async () => {
    // An anchor on a Workflow document, which the scanner refuses whatever the
    // kind: the exchange path has no general YAML parser to widen.
    const anchored = PACKAGE_DOCUMENT.replace('  id: ship-it-flow', '  id: &id ship-it-flow');

    const { code, keys } = await refusalOf({ text: anchored });
    expect(code).toBe('disallowed-syntax');
    expect(keys).toEqual(['outcome', 'refusal']);
  });

  it('refuses an empty document', async () => {
    for (const text of ['', '   \n\n']) {
      expect((await refusalOf({ text })).code).toBe('empty');
    }
  });

  it('decides too-large before the scanner is entered, so no oversized text is walked', async () => {
    // The bound is on BYTES and is checked first (SC-020). These bytes are valid
    // UTF-8 and syntactically fine — a reader that scanned first and measured
    // afterwards would report `disallowed-syntax` or plan the document, and would
    // have already walked past the bound to find out.
    const oversized = new Uint8Array(PHASE_YAML_MAX_BYTES + 1).fill(0x20);
    oversized.set(Buffer.from('apiVersion: schegent/v1\nkind: Workflow\n', 'utf8'));

    const { code, keys, harness } = await refusalOf({ bytes: oversized });
    expect(code).toBe('too-large');
    expect(keys).toEqual(['outcome', 'refusal']);
    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
  });

  it('still plans the same document once the refusal is resolved', async () => {
    // So a refusal test cannot pass because the fixture was broken in some other
    // way the reader also refuses.
    const { result } = await preflight({ text: PACKAGE_DOCUMENT });
    expect(result.outcome).toBe('planned');
  });
});

// ---------------------------------------------------------------------------
// Feature 086 — FR-057
// ---------------------------------------------------------------------------

// Feature 086 T071 — a read that cannot produce bytes says so, and says nothing
// else.
//
// The write half of FR-057 is pinned where the write happens
// (`workflow-export.test.ts`, `'Could not write the document.'`); this is the read
// half, which had no coverage at all. Three things can stop a read: the seam is not
// wired, the adapter reported a failure, or the adapter threw. Each lands on a
// fixed string.
//
// The adapter's own message is the dangerous one. `EACCES: permission denied, open
// …` and `cannot open file:///…` both carry the location in the text, and an
// adapter is free to word its errors however it likes — so a handler that forwarded
// them would leak a path through a family whose whole point is that no path crosses
// it. The assertions below are therefore mostly negative: not that a message
// appears, but that the adapter's does not, and that the sanitized detail survives
// only in the log.
describe('Feature 086 T071 — a read failure reports generically (FR-057)', () => {
  /** Shaped like the messages the host read APIs actually produce. */
  const ADAPTER_DETAIL =
    'EACCES: permission denied, open /Users/someone/private/ship-it.schegent.yaml';

  /** What the operator may be told when a read does not yield bytes. */
  const GENERIC = 'Could not read the document.';

  function failureOf(result: PreflightProcessYamlResult): string {
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error(`expected a failure, got ${result.outcome}`);
    // A failure is an outcome and a message, and nothing else — a third field is
    // where a location would most plausibly ride along.
    expect(Object.keys(result).sort()).toEqual(['message', 'outcome']);
    return result.message;
  }

  it('discards the message the adapter reported', async () => {
    const { result, harness } = await preflight({
      open: { outcome: 'failed', message: ADAPTER_DETAIL }
    });

    expect(failureOf(result)).toBe(GENERIC);
    // Not merely "different text": none of the adapter's words, and no separator
    // from the path it named.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('EACCES');
    expect(serialized).not.toContain('someone');
    expect(serialized).not.toMatch(/[/\\]/);
    // Nothing was written on the way to failing, and no plan was built.
    expect(harness.writePhaseConfig).not.toHaveBeenCalled();
    expect(harness.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps the sanitized detail in the log when the adapter throws', async () => {
    // The detail is worth keeping — an operator debugging a failed import needs
    // it — so it goes to the log through `sanitize`, and the operator-facing
    // message stays generic. Both halves are asserted, because a handler that
    // dropped the detail entirely would also pass the negative half.
    const { result, harness } = await preflight({
      openThrows: new Error(ADAPTER_DETAIL),
      sanitize: (value) => value.replace(/\/Users\/\S+/, '<redacted>')
    });

    expect(failureOf(result)).toBe(GENERIC);
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]).toContain('preflight read failed');
    // Through `sanitize`, not around it.
    expect(harness.warnings[0]).toContain('<redacted>');
    expect(harness.warnings[0]).not.toContain('/Users/someone');
  });

  it('reports the same generic message however the adapter fails', async () => {
    // A reported failure and a thrown one are the same event to the operator.
    // Two spellings would invite reading the difference as a diagnostic.
    const reported = await preflight({ open: { outcome: 'failed', message: 'disk is on fire' } });
    const thrown = await preflight({ openThrows: new Error('disk is on fire') });
    expect(failureOf(reported.result)).toBe(failureOf(thrown.result));
  });

  it('survives an adapter that throws with no message at all', async () => {
    // `throw new Error()` leaves `message` empty, and the handler's fallback runs.
    // Worth pinning because a template over `undefined` is how a handler crashes
    // on the path that is supposed to be its safety net.
    const { result, harness } = await preflight({ openThrows: new Error() });
    expect(failureOf(result)).toBe(GENERIC);
    expect(harness.warnings).toHaveLength(1);
  });

  it('says the window has no importer, without naming what is missing', async () => {
    const { result } = await preflight({ withOpenAdapter: false });
    expect(failureOf(result)).toBe('Import is unavailable in this window.');
    // Distinct from a read failure — this one is not retryable, and telling the
    // operator to try again would be wrong. It still names no location and no
    // internal symbol.
    expect(JSON.stringify(result)).not.toMatch(/[/\\]|openProcessYamlDocument/);
  });

  it('does not dress a cancel up as a failure', async () => {
    // The operator closing the dialog is not an error, so it carries no message to
    // report generically or otherwise. Collapsing it into `failed` would put a
    // failure in front of someone who chose to stop.
    const { result } = await preflight({ open: { outcome: 'canceled' } });
    expect(result).toEqual({ outcome: 'canceled' });
  });

  it('builds every failure message from a literal, so none can interpolate a cause', () => {
    // The structural half. The tests above cover the three failure sites that exist
    // today; this one covers the fourth, whenever it is added. A message built as a
    // template over the caught error would be the whole defect, and it would be
    // invisible to a test that only exercises the paths someone remembered.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'src/ui/sidebar/commands/cmd-preflight-process-yaml.ts'),
      'utf8'
    );
    const sites = [...source.matchAll(/outcome: 'failed'/g)].length;
    // A single-quoted literal with no interpolation in it. A template, a
    // concatenation, or a variable does not match, which is the point.
    const literals = [...source.matchAll(/outcome: 'failed',\s*message: ('[^'`$]*')/g)].map(
      (match) => match[1]!
    );

    // The scan must find the sites; a regex that stopped matching would pass this
    // test forever.
    expect(sites).toBeGreaterThanOrEqual(3);
    expect(literals, 'every failed outcome must carry a literal message').toHaveLength(sites);
    for (const literal of literals) {
      expect(literal).not.toMatch(/[/\\]/);
    }
    expect(literals).toContain("'Could not read the document.'");
    expect(literals).toContain("'Import is unavailable in this window.'");
  });
});
