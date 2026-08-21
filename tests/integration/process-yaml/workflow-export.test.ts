// Feature 086 T012 — Workflow export, references-only, end to end.
//
// The 084/085 handler is extended a third time rather than duplicated, so this
// file mirrors `pipeline-export.test.ts`'s harness and asserts what the Workflow
// branch adds. Three things carry over unchanged and are re-pinned here because
// a third branch is a third place they could drift: the document is read from
// the EFFECTIVE catalog (FR-014), a references-only document carries NO
// dependency payload at all (FR-015), and a write failure reports one generic
// sentence that names no location (FR-057).
//
// One thing is genuinely new. A Workflow's closure is two levels deep, so the
// reference-relaxed second pass of research R11 has to relax a level that
// `resolvePipelineCatalog` never had to: `resolveWorkflowCatalog` nulls a row's
// definition on ANY error, and `unknown-pipeline` is a reference-class one. The
// relaxation therefore needs a placeholder Pipeline in the slot — and unlike
// `placeholderPhase`, which is identifier-only because the Pipeline binding
// validator reads its Phase catalog for exactly one thing (the set of known
// ids), a placeholder Pipeline must be PORT-BEARING: `validateWorkflowGraph`
// checks a connection's `from.portId` against the source node's Pipeline
// `outputs` and its `to.portId` against the target's `inputs`. Those ports are
// derivable from the Workflow's own connections, which is why the ghost fixtures
// below give every endpoint a port to find.
//
// The hazard R11 names carries over with it: relax first and a row whose only
// defect is a missing Pipeline outranks one that genuinely resolves, and export
// emits bytes this installation does not run. Strict-first makes that
// unreachable, and the test named for FR-014 below is what keeps it so. The
// mirror-image hazard is new to this level and gets its own test: a placeholder
// must relax the reference, never a structural defect, so a ghost Workflow that
// ALSO contains a cycle stays unexportable.
//
// Feature 099 (T496f, FR-042) — the harness held `{ user, workspace }` layers
// and the FR-014 cases turned on which layer shadowed the other. There is one
// catalog now, so a second row under the same id is a duplicate rather than a
// shadow, and the resolver invalidates BOTH rows instead of picking a winner.
// Those cases are converted rather than dropped: each still asserts that no
// bytes leave for a definition this installation would not run.

import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';
import { CMD_EXPORT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult,
  WorkflowExportInclusion
} from '../../../src/contracts/sidebar-ipc';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { WORKFLOW_ID_MAX_LEN } from '../../../src/config/workflow-definition-validator';
import { MUTATING_COMMANDS } from '../../../src/ui/sidebar/message-router';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

interface Harness {
  readonly ctx: Parameters<typeof exportHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly audits: AuditEntry[];
  readonly saved: { suggestedFileName: string; text: string }[];
  readonly warnings: string[];
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  /** The stored rows of each catalog — one list per kind, not one per layer. */
  readonly workflows?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly phases?: readonly unknown[];
  readonly saveResult?: Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>;
  readonly saveThrows?: Error;
  readonly withSaveAdapter?: boolean;
}

function buildHarness(opts: HarnessOptions = {}): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];
  const warnings: string[] = [];
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

  const saveProcessYamlDocument = async (request: {
    suggestedFileName: string;
    text: string;
  }): Promise<Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>> => {
    if (opts.saveThrows) throw opts.saveThrows;
    saved.push({ ...request });
    return opts.saveResult ?? { outcome: 'saved' };
  };

  const ctx = {
    deps: {
      readWorkflowConfig: () => ({ rows: opts.workflows ?? [], revision: FIXTURE_REVISION }),
      readPipelineConfig: () => ({ rows: opts.pipelines ?? [], revision: FIXTURE_REVISION }),
      readPhaseConfig: () => ({ rows: opts.phases ?? [], revision: FIXTURE_REVISION }),
      updateConfig,
      executeCommand,
      ...(opts.withSaveAdapter === false ? {} : { saveProcessYamlDocument }),
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
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
    correlationId: 'workflow-export-1'
  } as any;

  return { ctx, acks, audits, saved, warnings, updateConfig, executeCommand };
}

function command(
  resourceId: string,
  inclusion: WorkflowExportInclusion = 'references-only'
): ExportProcessYamlCommand {
  return {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'workflow-export-1',
    payload: { resourceKind: 'workflow', resourceId, inclusion }
  };
}

/** A Phase row good enough to resolve, so a Pipeline may legally name its id. */
function phaseRow(phaseId: string, name = phaseId): Record<string, unknown> {
  return { phaseId, name, version: 1, instruction: `Run ${name}.` };
}

const PHASE_LAYER = Object.freeze([phaseRow('draft', 'Draft'), phaseRow('review', 'Review')]);

/**
 * Two Pipelines whose ports actually line up with the Workflow's connections:
 * `markdown` out feeding `text` in is a member of the frozen compatibility table,
 * so the authored graph resolves and its defects, when a test introduces one, are
 * the defect under test rather than a mis-built fixture.
 */
const AUTHORING_PIPELINE = Object.freeze({
  pipelineId: 'spec-authoring',
  name: 'Spec Authoring',
  version: 1,
  phaseIds: Object.freeze(['draft']),
  inputs: Object.freeze([{ portId: 'brief', label: 'Brief', type: 'text' }]),
  outputs: Object.freeze([{ portId: 'spec-document', label: 'Spec', type: 'markdown' }]),
  bindings: Object.freeze([]),
  recommendedNext: Object.freeze([])
});

const REVIEW_PIPELINE = Object.freeze({
  pipelineId: 'spec-review',
  name: 'Spec Review',
  version: 1,
  phaseIds: Object.freeze(['review']),
  inputs: Object.freeze([{ portId: 'spec', label: 'Spec', type: 'text' }]),
  outputs: Object.freeze([{ portId: 'verdict', label: 'Verdict', type: 'markdown' }]),
  bindings: Object.freeze([]),
  recommendedNext: Object.freeze([])
});

const PIPELINE_LAYER = Object.freeze([AUTHORING_PIPELINE, REVIEW_PIPELINE]);

/**
 * US1's independent test subject: two nodes, one conditional connection carrying
 * every optional a connection has, and a start set. Both endpoints are structured
 * (`nodeId` + `portId`), the condition is structured data, and the connection
 * carries no identifier of its own — the three absences the document must keep.
 */
const AUTHORED_WORKFLOW = Object.freeze({
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  description: 'Draft, then review.',
  version: 4,
  nodes: Object.freeze([
    { nodeId: 'draft', pipelineId: 'spec-authoring', label: 'Draft the spec' },
    { nodeId: 'review', pipelineId: 'spec-review' }
  ]),
  connections: Object.freeze([
    {
      from: { nodeId: 'draft', portId: 'spec-document' },
      to: { nodeId: 'review', portId: 'spec' },
      condition: {
        left: { source: 'node-status', nodeId: 'draft' },
        operator: 'in',
        right: Object.freeze(['completed', 'failed'])
      },
      priority: 10,
      isDefault: false
    }
  ]),
  startNodeIds: Object.freeze(['draft'])
});

/**
 * The same Workflow, naming Pipelines no layer defines. Nothing else differs —
 * the node ids, the ports, and the condition are untouched, so the only reason
 * the strict pass rejects it is `unknown-pipeline`.
 */
const GHOST_WORKFLOW = Object.freeze({
  ...AUTHORED_WORKFLOW,
  nodes: Object.freeze([
    { nodeId: 'draft', pipelineId: 'ghost-authoring', label: 'Draft the spec' },
    { nodeId: 'review', pipelineId: 'ghost-review' }
  ])
});

/**
 * The same shape again, with the two absent identifiers ordered so that node order
 * and alphabetical order disagree. `ghost-authoring` before `ghost-review` is first
 * under both readings, so it cannot tell FR-022's "first in reference order" apart
 * from "first when sorted" — this fixture can.
 */
const ZULU_WORKFLOW = Object.freeze({
  ...AUTHORED_WORKFLOW,
  nodes: Object.freeze([
    { nodeId: 'draft', pipelineId: 'zulu-authoring', label: 'Draft the spec' },
    { nodeId: 'review', pipelineId: 'alpha-review' }
  ])
});

/**
 * US2's independent test subject: three nodes naming two Pipelines, because a
 * Workflow may put one Pipeline at several points in a graph (FR-062). The document
 * must then carry that Pipeline once (FR-020) and still carry three nodes.
 *
 * `verdict` (markdown) feeding `brief` (text) is a member of the frozen
 * compatibility table, and the third node is reachable from the declared start
 * through the second, so the added edge introduces no defect of its own.
 */
const REPEATED_PIPELINE_WORKFLOW = Object.freeze({
  ...AUTHORED_WORKFLOW,
  nodes: Object.freeze([
    { nodeId: 'draft', pipelineId: 'spec-authoring', label: 'Draft the spec' },
    { nodeId: 'review', pipelineId: 'spec-review' },
    { nodeId: 'redraft', pipelineId: 'spec-authoring' }
  ]),
  connections: Object.freeze([
    ...AUTHORED_WORKFLOW.connections,
    {
      from: { nodeId: 'review', portId: 'verdict' },
      to: { nodeId: 'redraft', portId: 'brief' }
    }
  ])
});

describe('Feature 086 — export one Workflow, references-only (US1, FR-011..FR-014)', () => {
  it('writes a package document naming the Workflow, its nodes, connection, and start set', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.status).toBe('accepted');
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.saved).toHaveLength(1);

    const text = h.saved[0]!.text;
    expect(text).toContain('apiVersion: schegent/v1');
    expect(text).toContain('kind: Workflow');
    expect(text).toContain('  id: ship-it-flow');
    expect(text).toContain('  name: Ship It Flow');
    expect(text).toContain('  description: Draft, then review.');
    expect(text).toContain('  version: 4');
    expect(text).toContain('    - nodeId: draft');
    expect(text).toContain('      pipelineId: spec-authoring');
    expect(text).toContain('      label: Draft the spec');
    expect(text).toContain('    - nodeId: review');
    expect(text).toContain('      pipelineId: spec-review');
    expect(text).toContain(['  startNodeIds:', '    - draft', ''].join('\n'));
  });

  it('writes both endpoints structurally and the condition as data (FR-006, FR-012)', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(text).toContain(
      [
        '    - from:',
        '        nodeId: draft',
        '        portId: spec-document',
        '      to:',
        '        nodeId: review',
        '        portId: spec',
        '      condition:',
        '        left:',
        '          source: node-status',
        '          nodeId: draft',
        '        operator: in',
        '        right:',
        '          - completed',
        '          - failed',
        '      priority: 10',
        '      isDefault: false',
        ''
      ].join('\n')
    );
    // No dotted `nodeId.portId` string, and no expression form for the condition:
    // both would need a splitter or a parser on the way back in.
    expect(text).not.toMatch(/^\s*(?:from|to): \S/m);
    expect(text).not.toContain('condition: ');
    // A connection carries no identifier of its own — positional addressing is
    // for defect reporting only and must not leak into the document.
    expect(text).not.toContain('connectionId');
  });

  it('carries no derived ports (FR-012, standing hard rule)', async () => {
    // A Workflow's inputs and outputs are the unbound ports of its nodes'
    // Pipelines, derived on read. A serialized copy would be a second source of
    // truth that goes stale the moment a node's Pipeline changes shape.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('inputs:');
    expect(text).not.toContain('outputs:');
  });

  it('exports nothing when one id names two rows — neither copy wins (FR-014)', async () => {
    // Feature 099 (T496f, FR-042) — this was "exports the layer that actually
    // runs, not a shadowed copy", with the workspace copy expected in the bytes.
    // One catalog has no shadowing to arbitrate, so the two copies are a
    // duplicate id and the resolver invalidates both. The claim converts intact:
    // an export never emits bytes for a definition this installation would not
    // run, and here neither copy runs.
    const h = buildHarness({
      workflows: [
        { ...AUTHORED_WORKFLOW, name: 'First Copy' },
        { ...AUTHORED_WORKFLOW, name: 'Second Copy', version: 7 }
      ],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: h.audits[0] });
    expect(serialized).not.toContain('First Copy');
    expect(serialized).not.toContain('Second Copy');
  });

  it('is deterministic — ten exports of an unchanged Workflow are byte-identical', async () => {
    const texts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const h = buildHarness({
        workflows: [AUTHORED_WORKFLOW],
        pipelines: PIPELINE_LAYER,
        phases: PHASE_LAYER
      });
      await exportHandler(h.ctx, command('ship-it-flow'));
      texts.push(h.saved[0]!.text);
    }
    expect(new Set(texts).size).toBe(1);
  });
});

describe('Feature 086 — references-only carries no dependency payload (FR-015)', () => {
  it('writes no included section at all — not an empty one, absent', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('included');
    // Nor either level of body an inclusion export would carry: a referenced
    // Pipeline appears only as an identifier in `nodes[].pipelineId`.
    expect(text).not.toContain('kind: Pipeline');
    expect(text).not.toContain('kind: Phase');
    expect(text).not.toContain('phaseIds:');
    expect(text).not.toContain('instruction:');
    const topLevel = text
      .split('\n')
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(':')[0]);
    expect(topLevel).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
  });
});

describe('Feature 086 — references-only never requires the Pipelines to resolve (FR-016)', () => {
  it('exports a Workflow whose Pipelines are missing from every layer, nodes intact', async () => {
    // No Pipeline layer defines `ghost-authoring` or `ghost-review`, so the
    // strict resolution reports `unknown-pipeline` against both nodes and
    // produces no effective record. The document is still produced (R11).
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('      pipelineId: ghost-authoring');
    expect(text).toContain('      pipelineId: ghost-review');
  });

  it('succeeds when only one node names a Pipeline that resolves', async () => {
    // The mixed case, which the placeholder has to survive from both sides: a
    // real `markdown` output feeding a placeholder input, and a placeholder
    // output feeding a real input, in the same graph.
    const h = buildHarness({
      workflows: [
        {
          ...AUTHORED_WORKFLOW,
          nodes: [
            { nodeId: 'draft', pipelineId: 'spec-authoring', label: 'Draft the spec' },
            { nodeId: 'review', pipelineId: 'ghost-review' }
          ]
        }
      ],
      pipelines: [AUTHORING_PIPELINE],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.saved[0]!.text).toContain('      pipelineId: ghost-review');
  });

  it('a Pipeline that resolves nowhere is still only an identifier in the document', async () => {
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('included');
    expect(text).not.toContain('kind: Pipeline');
  });

  it('the relaxation rescues nothing the catalog refuses for a non-reference defect (FR-014)', async () => {
    // Feature 099 (T496f, FR-042) — the R11 hazard one level up was a relaxed
    // workspace row, defective only in a missing Pipeline, outranking a user row
    // that genuinely resolves. Layers are gone, so that promotion has no shape
    // to take; what survives is the half that still bites. Both rows below claim
    // `ship-it-flow`, so the strict pass refuses them as duplicates, and because
    // the second names Pipelines nothing defines, the relaxed pass DOES run: it
    // mints port-bearing placeholders and resolves again. It must still refuse,
    // because `duplicate-in-scope` is computed from the catalog's own shape and
    // no placeholder Pipeline can suppress it.
    const h = buildHarness({
      workflows: [
        { ...AUTHORED_WORKFLOW, name: 'Runs Here' },
        { ...GHOST_WORKFLOW, name: 'Never Runs' }
      ],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: h.audits[0] });
    expect(serialized).not.toContain('Runs Here');
    expect(serialized).not.toContain('Never Runs');
  });

  it('relaxes only the reference-class defects, never a structural one', async () => {
    // Same missing Pipelines, plus a second connection back into `draft`. The
    // cycle is computed from the graph's own edges, so no placeholder Pipeline
    // can suppress it and the row stays invalid through both passes.
    const h = buildHarness({
      workflows: [
        {
          ...GHOST_WORKFLOW,
          connections: [
            ...GHOST_WORKFLOW.connections,
            {
              from: { nodeId: 'review', portId: 'verdict' },
              to: { nodeId: 'draft', portId: 'brief' }
            }
          ]
        }
      ]
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('exports a ghost node a node-output condition reads a field from', async () => {
    // The graph validator skips the structured-output check while the operand
    // node's Pipeline is unresolved, so the relaxed pass — where it now resolves —
    // is the only pass that can fail this shape. A placeholder carrying only the
    // ports the connections address would introduce a defect the strict pass never
    // had, which is FR-016 broken by the mechanism meant to uphold it.
    const h = buildHarness({
      workflows: [
        {
          ...GHOST_WORKFLOW,
          connections: [
            {
              ...GHOST_WORKFLOW.connections[0],
              condition: {
                left: { source: 'node-output', nodeId: 'draft', field: 'status' },
                operator: 'equals',
                right: 'ready'
              }
            }
          ]
        }
      ]
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(text).toContain(
      ['        left:', '          source: node-output', '          nodeId: draft', '          field: status', ''].join(
        '\n'
      )
    );
    // The port the placeholder needed is a resolution-time artifact. It is not
    // part of the definition, so it reaches no document — the same reason a
    // Workflow's derived ports are never stored.
    expect(text).not.toContain('structured-output');
    expect(text).not.toContain('structured-data');
  });

  it('never reports dependency-does-not-resolve for a references-only export', async () => {
    // That reason belongs to the inclusion paths alone (FR-022). Reaching it
    // here would be FR-016 broken with a friendlier message.
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(JSON.stringify(h.acks[0]!)).not.toContain('dependency-does-not-resolve');
  });
});

describe('Feature 086 — the two absences stay told apart (FR-023)', () => {
  it('reports an intrinsically broken row as does-not-resolve', async () => {
    const h = buildHarness({
      workflows: [{ ...AUTHORED_WORKFLOW, version: 'not-a-number' }],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('reports an id no layer mentions as not-found (US1 scenario 3)', async () => {
    // The never-saved draft: the operator has a Workflow open in the builder
    // that no layer holds, so the export has nothing to read.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('no-such-workflow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'not-found' });
  });

  it('reports not-found rather than does-not-resolve when the catalog is empty', async () => {
    const h = buildHarness();
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'not-found' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['unavailable'] });
    // Feature 099 (T496f, FR-041) — the envelope carried `scope: null` here, the
    // one arm a refusal could report. The field is deleted rather than nulled,
    // and this exact key set is what holds a build to that.
    expect(Object.keys(h.audits[0]!.payload).sort()).toEqual([
      'counts',
      'operation',
      'outcomes',
      'resourceIds',
      'resourceKind'
    ]);
  });
});

// Feature 086 T068 — gate 2, the transport boundary, for the third export arm.
//
// Every test above dispatches to `exportHandler` directly, which is the right
// scope for the handler's own behavior and is exactly why this gap was invisible:
// the webview's message crosses `validateInboundMessage` FIRST, and a command
// rejected there is dropped at debug level and never reaches the handler at all.
// T005 widened the TYPE with the `workflow` arm, and both runtime gates narrow
// structurally without an exhaustiveness check, so the widening compiled while
// leaving the arm unreachable in the shipped extension.
//
// This is the same defect feature 085 shipped on the import-package path and the
// reason it is pinned here per kind rather than trusted to the type.
describe('Feature 086 — the third export arm crosses the transport boundary (T005, T068)', () => {
  const envelope = (payload: unknown): unknown => ({
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'workflow-export-gate-2',
    payload
  });

  it.each(['references-only', 'include-pipelines', 'include-closure'])(
    'admits a Workflow export in %s mode',
    (inclusion) => {
      expect(
        validateInboundMessage(
          envelope({ resourceKind: 'workflow', resourceId: 'ship-it-flow', inclusion })
        )
      ).toMatchObject({ ok: true });
    }
  );

  it('refuses a Workflow export whose inclusion belongs to the Pipeline vocabulary', () => {
    // `include-referenced` names one level of dependency. A Workflow has two, so
    // accepting it here would leave the handler to guess which the operator meant.
    expect(
      validateInboundMessage(
        envelope({
          resourceKind: 'workflow',
          resourceId: 'ship-it-flow',
          inclusion: 'include-referenced'
        })
      )
    ).toMatchObject({ ok: false, reason: 'invalid-inclusion' });
  });

  it('refuses a Workflow export with no inclusion at all', () => {
    expect(
      validateInboundMessage(envelope({ resourceKind: 'workflow', resourceId: 'ship-it-flow' }))
    ).toMatchObject({ ok: false, reason: 'invalid-inclusion' });
  });

  it('bounds the Workflow id at its own catalog’s length', () => {
    expect(
      validateInboundMessage(
        envelope({
          resourceKind: 'workflow',
          resourceId: 'w'.repeat(WORKFLOW_ID_MAX_LEN),
          inclusion: 'references-only'
        })
      )
    ).toMatchObject({ ok: true });
    expect(
      validateInboundMessage(
        envelope({
          resourceKind: 'workflow',
          resourceId: 'w'.repeat(WORKFLOW_ID_MAX_LEN + 1),
          inclusion: 'references-only'
        })
      )
    ).toMatchObject({ ok: false, reason: 'resource-id-too-long' });
  });

  it('still refuses a kind outside the closed set', () => {
    expect(
      validateInboundMessage(
        envelope({ resourceKind: 'queue', resourceId: 'default', inclusion: 'references-only' })
      )
    ).toMatchObject({ ok: false, reason: 'invalid-resource-kind' });
  });
});

describe('Feature 086 — export changes nothing and names no location (FR-057)', () => {
  it('registers no destructive-action confirmation', async () => {
    // Export is read-only: it writes a file the operator named in the host's own
    // dialog and changes no extension state, so the command is deliberately not
    // a member of `MUTATING_COMMANDS` and overwrite consent belongs to the
    // dialog rather than to a `useConfirm` action key.
    expect(MUTATING_COMMANDS.has(CMD_EXPORT_PROCESS_YAML)).toBe(false);
  });

  it('writes no configuration and runs no command', async () => {
    const workflows: readonly unknown[] = [AUTHORED_WORKFLOW];
    const before = JSON.stringify(workflows);
    const h = buildHarness({
      workflows,
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(workflows)).toBe(before);
  });

  it('hands the adapter a bare name and no location', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved[0]!.suggestedFileName).toBe('ship-it-flow.workflow.yaml');
    expect(h.saved[0]!.suggestedFileName).not.toContain('/');
    expect(h.saved[0]!.suggestedFileName).not.toContain('\\');
  });

  it('turns an adapter throw into a generic failure and keeps the detail in the log', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER,
      saveThrows: new Error('EACCES: permission denied writing the chosen location')
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const ack = h.acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.result).toEqual({ outcome: 'failed', message: 'Could not write the document.' });
    expect(JSON.stringify(ack)).not.toContain('EACCES');
    expect(h.warnings.join('\n')).toContain('EACCES');
    expect(h.audits[0]!.outcome).toBe('failure');
  });

  it('reports a canceled dialog without treating it as a failure', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER,
      saveResult: { outcome: 'canceled' }
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'canceled' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['canceled'], counts: { exported: 0 } });
    expect(h.audits[0]!.outcome).toBe('info');
  });

  it('rejects cleanly when the host wired no save adapter', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER,
      withSaveAdapter: false
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toMatchObject({ outcome: 'failed' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['failed'], counts: { exported: 0 } });
  });

  it('audits the Workflow kind with the same bounded envelope and no location', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.audits).toHaveLength(1);
    const entry = h.audits[0]!;
    expect(entry.eventType).toBe('process-exchange-export');
    // Feature 099 (T496f, FR-041) — `scope` sat at the end of this list and is
    // gone with the layer tier it named. This is an EXACT key set, so dropping it
    // here is not a loosening: a build that still emitted `scope` fails on it.
    expect(Object.keys(entry.payload).sort()).toEqual([
      'counts',
      'operation',
      'outcomes',
      'resourceIds',
      'resourceKind'
    ]);
    expect(entry.payload).toMatchObject({
      operation: 'export',
      resourceKind: 'workflow',
      resourceIds: ['ship-it-flow'],
      outcomes: ['saved'],
      counts: { exported: 1 }
    });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: entry });
    expect(serialized).not.toContain('.workflow.yaml');
    expect(serialized).not.toContain('/Users');
  });
});

// Feature 086 T020 — `include-pipelines`, end to end (US2).
//
// This mode is where `dependency-does-not-resolve` becomes reachable at all. The
// references-only branch above proves it never is there (FR-016), so the two tests
// together fence the outcome to the modes that actually require a dependency.
//
// FR-018 is the subtle half, and it is a claim about WHICH level must resolve. A
// Pipeline naming a Phase this machine does not hold is not effective —
// `resolvePipelineCatalog` pushes `unknown-phase` and nulls the definition — so
// resolving the included Pipelines against the strict effective catalog would let a
// missing PHASE refuse a mode that carries no Phase. That is FR-018 broken by the
// oracle rather than by the requirement, and the test named for it below is what
// keeps the per-Pipeline resolution reference-relaxed at the Phase level.
//
// It must relax the reference and nothing else, which is why the intrinsically
// broken Pipeline still refuses: `version: 'not-a-number'` is not reference-class,
// so no relaxation reaches it and the refusal names it. And when relaxation does
// apply, the document must carry the operator's AUTHORED definition, never the
// port-bearing placeholder the Workflow's own resolution needed — the placeholder's
// name is its identifier and its `phaseIds` is empty, so the authored name and the
// authored Phase references are what the assertions look for.

describe('Feature 086 — export one Workflow with its Pipelines (US2, FR-017, FR-020, FR-022)', () => {
  it('carries every referenced Pipeline and no Phase definition (FR-017)', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('\nincluded:\n');
    expect(text).toContain('  pipelines:\n');
    expect(text).toContain('        id: spec-authoring');
    expect(text).toContain('        id: spec-review');
    // The middle mode's whole point: the compositions move, the Phases stay put.
    expect(text).not.toContain('  phases:');
    expect(text).not.toContain('kind: Phase');
    expect(text).not.toContain('instruction:');
  });

  it('carries a Pipeline two nodes name exactly once, and still three nodes (FR-020, FR-062)', async () => {
    const h = buildHarness({
      workflows: [REPEATED_PIPELINE_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text.match(/^ {8}id: spec-authoring$/gm)).toHaveLength(1);
    expect(text.match(/^ {8}id: spec-review$/gm)).toHaveLength(1);
    // The lookup table de-duplicates; the graph does not. Three nodes, each with
    // its own identity, two of them on the one included definition.
    expect(text.match(/^ {6}pipelineId: spec-authoring$/gm)).toHaveLength(2);
    expect(text).toContain('    - nodeId: redraft');
  });

  it('refuses when a referenced Pipeline does not resolve, naming it (FR-022)', async () => {
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'pipeline', resourceId: 'ghost-authoring' }
    });
  });

  it('names the first unresolved reference in node order, not the first alphabetically', async () => {
    const h = buildHarness({ workflows: [ZULU_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.acks[0]!.result).toMatchObject({
      unresolvedDependency: { kind: 'pipeline', resourceId: 'zulu-authoring' }
    });
  });

  it('names the Pipeline of the second node when the first one resolves', async () => {
    // Only `spec-review` is absent, so the walk has to reach the second node before
    // it has anything to report — the counterpart to the test above, which reports
    // on the first.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: [AUTHORING_PIPELINE],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'pipeline', resourceId: 'spec-review' }
    });
  });

  it('refuses on an intrinsically broken Pipeline, which no relaxation reaches', async () => {
    // A missing Phase is reference-class and FR-018 forgives it. A `version` that
    // is not a number is the Pipeline's own defect, and forgiving it would export a
    // definition that cannot be imported back.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: [AUTHORING_PIPELINE, { ...REVIEW_PIPELINE, version: 'not-a-number' }],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'pipeline', resourceId: 'spec-review' }
    });
  });

  it('writes no partial document and audits the refusal without a location', async () => {
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.saved).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.payload).toEqual({
      operation: 'export',
      resourceKind: 'workflow',
      resourceIds: ['ship-it-flow'],
      outcomes: ['unavailable'],
      counts: { exported: 0 }
    });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: h.audits[0] });
    expect(serialized).not.toContain('.workflow.yaml');
    expect(serialized).not.toContain('/Users');
  });

  it('is the inclusion choice alone that makes the same Workflow unexportable (FR-016)', async () => {
    const catalog = { workflows: [GHOST_WORKFLOW] };
    const references = buildHarness(catalog);
    const including = buildHarness(catalog);

    await exportHandler(references.ctx, command('ship-it-flow'));
    await exportHandler(including.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(references.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(including.acks[0]!.result).toMatchObject({ reason: 'dependency-does-not-resolve' });
  });
});

describe('Feature 086 — Pipeline inclusion never requires the Phases (US2, FR-018)', () => {
  /** Both Pipelines are present and well formed; nothing defines the Phases they name. */
  const PHASELESS = {
    workflows: [AUTHORED_WORKFLOW],
    pipelines: PIPELINE_LAYER
  } as const;

  it('exports Pipelines whose Phases no layer defines', async () => {
    const h = buildHarness(PHASELESS);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['saved'], counts: { exported: 1 } });
    expect(JSON.stringify(h.acks[0]!)).not.toContain('dependency-does-not-resolve');
  });

  it('carries the authored definitions, not the placeholders resolution needed', async () => {
    const h = buildHarness(PHASELESS);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    const text = h.saved[0]!.text;
    // A placeholder's name is its own identifier and its `phaseIds` is empty, so
    // the authored name and the authored Phase references are what tell them apart.
    expect(text).toContain('        name: Spec Authoring');
    expect(text).toContain('        name: Spec Review');
    expect(text).toContain(['        phaseIds:', '          - draft', ''].join('\n'));
    expect(text).toContain(['        phaseIds:', '          - review', ''].join('\n'));
    // A placeholder labels every port with the port's own identifier, so an
    // authored label is a second, independent witness that the authored row won.
    expect(text).toContain(
      ['          - portId: spec-document', '            label: Spec', '            type: markdown', ''].join('\n')
    );
  });

  it('still carries no Phase definition — the identifiers are all it owes (FR-017)', async () => {
    const h = buildHarness(PHASELESS);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('  phases:');
    expect(text).not.toContain('instruction:');
  });

  it('refuses on the Pipeline level even while forgiving the Phase level', async () => {
    // The two relaxations are at different levels and must not blur: one absent
    // Pipeline still refuses in a catalog where every Phase is also absent.
    const h = buildHarness({ workflows: [AUTHORED_WORKFLOW], pipelines: [REVIEW_PIPELINE] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-pipelines'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'pipeline', resourceId: 'spec-authoring' }
    });
  });
});

// Feature 086 T025/T026 — the closure mode: what it carries, and what it refuses
// to carry a partial version of (test-first).
//
// Determinism (FR-021, SC-006) is asserted as byte identity between two exports
// of an unchanged catalog, in every mode. It is worth pinning per mode rather than
// once, because each mode adds a section derived by a different walk, and the
// cheapest way to lose determinism is to let one of those walks read a `Map`
// iteration order or a resolver's completion order instead of the authored graph.
//
// The three modes are also asserted to NEST: references-only is a prefix of
// include-pipelines, which is a prefix of include-closure. That holds only while
// `included` is the last key of the document and `pipelines` precedes `phases`
// inside it, and it is the sharpest available statement of FR-009's second clause —
// a deeper mode ADDS, and cannot have rewritten a byte of the graph above it.
//
// The refusal half is FR-022 one level deeper than US2's. A Pipeline that resolves
// while naming a Phase this installation does not hold makes the closure mode
// unavailable and the middle mode fine (FR-018), so the two refusals are at
// different levels and must not blur into one. Nothing partial is written: no
// document, and in particular not a document carrying the Pipelines whose Phases
// failed — a reader cannot tell that from a complete package.
describe('Feature 086 — export the full transitive closure (US3, FR-019..FR-022)', () => {
  /** A second Pipeline naming the SAME Phase as the first, plus one of its own. */
  const SHARING_REVIEW_PIPELINE = Object.freeze({
    ...REVIEW_PIPELINE,
    phaseIds: Object.freeze(['draft', 'review'])
  });

  const FULL = {
    workflows: [AUTHORED_WORKFLOW],
    pipelines: PIPELINE_LAYER,
    phases: PHASE_LAYER
  } as const;

  it('carries every Pipeline and every Phase behind them (FR-019)', async () => {
    const h = buildHarness(FULL);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('        id: spec-authoring');
    expect(text).toContain('        id: spec-review');
    expect(text).toContain(
      [
        '  phases:',
        '    - metadata:',
        '        phaseId: draft',
        '        name: Draft',
        '        version: 1',
        '      spec:',
        '        instruction: Run Draft.',
        '    - metadata:',
        '        phaseId: review',
        '        name: Review',
        '        version: 1',
        '      spec:',
        '        instruction: Run Review.',
        ''
      ].join('\n')
    );
  });

  it('carries a Phase two Pipelines both name exactly once (FR-019, FR-020)', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: [AUTHORING_PIPELINE, SHARING_REVIEW_PIPELINE],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    // Closure-wide de-duplication, not per-Pipeline: `draft` is named by both
    // Pipelines and appears once in the lookup table, while both `phaseIds`
    // sequences still name it.
    expect(text.match(/^ {8}phaseId: draft$/gm)).toHaveLength(1);
    expect(text.match(/^ {8}phaseId: review$/gm)).toHaveLength(1);
    expect(text.match(/^ {10}- draft$/gm)).toHaveLength(2);
  });

  it('orders the Phases by reference, not alphabetically (FR-020, FR-021)', async () => {
    // `review` sorts before `spec`-anything's Phase order here only if the walk
    // sorts; authored order puts `draft` first because its Pipeline is node one.
    const h = buildHarness(FULL);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    const text = h.saved[0]!.text;
    expect(text.indexOf('phaseId: draft')).toBeLessThan(text.indexOf('phaseId: review'));
    // And the Pipelines still precede the Phases, one section each.
    expect(text.indexOf('  pipelines:')).toBeLessThan(text.indexOf('  phases:'));
  });

  it('produces byte-identical documents on two exports of an unchanged catalog (FR-021, SC-006)', async () => {
    for (const inclusion of [
      'references-only',
      'include-pipelines',
      'include-closure'
    ] as const satisfies readonly WorkflowExportInclusion[]) {
      const first = buildHarness(FULL);
      const second = buildHarness(FULL);
      await exportHandler(first.ctx, command('ship-it-flow', inclusion));
      await exportHandler(second.ctx, command('ship-it-flow', inclusion));

      expect(first.acks[0]!.result, inclusion).toEqual({ outcome: 'saved' });
      expect(second.saved[0]!.text, inclusion).toBe(first.saved[0]!.text);
      expect(second.saved[0]!.suggestedFileName, inclusion).toBe(
        first.saved[0]!.suggestedFileName
      );
    }
  });

  it('is deterministic across two exports from the same catalog object', async () => {
    // The same handler context twice, so a walk that mutated anything it read —
    // sorted an array in place, cached a resolved order — would show up as a
    // difference the two-harness form above cannot see.
    const h = buildHarness(FULL);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(2);
    expect(h.saved[1]!.text).toBe(h.saved[0]!.text);
  });

  it('nests the three modes: each deeper one adds a section and rewrites nothing (FR-009)', async () => {
    const texts: string[] = [];
    for (const inclusion of ['references-only', 'include-pipelines', 'include-closure'] as const) {
      const h = buildHarness(FULL);
      await exportHandler(h.ctx, command('ship-it-flow', inclusion));
      expect(h.acks[0]!.result, inclusion).toEqual({ outcome: 'saved' });
      texts.push(h.saved[0]!.text);
    }

    expect(texts[1]!.startsWith(texts[0]!)).toBe(true);
    expect(texts[2]!.startsWith(texts[1]!)).toBe(true);
    // Strictly deeper, not merely compatible: each mode carries more than the last.
    expect(texts[1]!.length).toBeGreaterThan(texts[0]!.length);
    expect(texts[2]!.length).toBeGreaterThan(texts[1]!.length);
  });

  it('refuses when a Phase in the closure does not resolve, naming it (FR-022, SC-007)', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'phase', resourceId: 'draft' }
    });
  });

  it('names the first unresolved Phase in closure order, not the first alphabetically', async () => {
    // The two absent Phases are ordered so authored order and alphabetical order
    // disagree: `zulu-phase` is reached first because its Pipeline is node one.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: [
        { ...AUTHORING_PIPELINE, phaseIds: ['zulu-phase'] },
        { ...REVIEW_PIPELINE, phaseIds: ['alpha-phase'] }
      ]
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toMatchObject({
      unresolvedDependency: { kind: 'phase', resourceId: 'zulu-phase' }
    });
  });

  it('reaches the second Pipeline’s Phase when the first one resolves', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER,
      phases: [phaseRow('draft', 'Draft')]
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'phase', resourceId: 'review' }
    });
  });

  it('writes no partial dependency payload — not even the Pipelines that did resolve', async () => {
    // The failure is at the Phase level, so every Pipeline in the closure resolved.
    // Writing them without their Phases would produce a document a reader cannot
    // distinguish from a complete middle-mode package, which is why FR-022 refuses
    // the whole export rather than the missing section.
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.payload).toMatchObject({
      operation: 'export',
      resourceKind: 'workflow',
      outcomes: ['unavailable'],
      counts: { exported: 0 }
    });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: h.audits[0] });
    expect(serialized).not.toContain('spec-authoring');
    expect(serialized).not.toContain('.workflow.yaml');
    expect(serialized).not.toContain('/Users');
  });

  it('refuses at the Phase level only in this mode — the middle mode still exports (FR-018)', async () => {
    // The same catalog, two depths. Blurring the two levels of relaxation would
    // either break FR-018 here or export an unresolvable closure above.
    const catalog = {
      workflows: [AUTHORED_WORKFLOW],
      pipelines: PIPELINE_LAYER
    } as const;
    const middle = buildHarness(catalog);
    const deep = buildHarness(catalog);

    await exportHandler(middle.ctx, command('ship-it-flow', 'include-pipelines'));
    await exportHandler(deep.ctx, command('ship-it-flow', 'include-closure'));

    expect(middle.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(deep.acks[0]!.result).toMatchObject({
      unresolvedDependency: { kind: 'phase', resourceId: 'draft' }
    });
  });

  it('refuses at the Pipeline level before it ever reaches the Phases', async () => {
    // An absent Pipeline is reported as a Pipeline, not as whatever Phase it might
    // have named: the walk cannot know the second level of a definition it does
    // not have.
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'pipeline', resourceId: 'ghost-authoring' }
    });
  });
});
