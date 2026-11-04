// Feature 086 / Feature 263 (FR-R5-F04) — Composable Workflow export, end to end.

import { describe, expect, it, vi } from 'vitest';

import { WORKFLOW_ID_MAX_LEN } from '../../../src/config/workflow-definition-validator';
import { validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { CMD_EXPORT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult,
  WorkflowExportInclusion
} from '../../../src/contracts/sidebar-ipc';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';
import { MUTATING_COMMANDS } from '../../../src/ui/sidebar/message-router';
import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';

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
  readonly workflows?: readonly unknown[];
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
      readPipelineConfig: () => ({ rows: [], revision: FIXTURE_REVISION }),
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

function phaseRow(
  phaseId: string,
  name = phaseId,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { phaseId, name, version: 1, instruction: `Run ${name}.`, ...extra };
}

const PHASE_LAYER = Object.freeze([
  phaseRow('draft', 'Draft'),
  phaseRow('review', 'Review')
]);

const AUTHORING_WORKFLOW = Object.freeze({
  workflowId: 'spec-authoring',
  name: 'Spec Authoring',
  version: 1,
  inputs: Object.freeze([{ portId: 'brief', label: 'Brief', type: 'text', required: false }]),
  outputs: Object.freeze([{ portId: 'spec-document', label: 'Spec', type: 'markdown' }]),
  nodes: Object.freeze([{ nodeId: 'draft-node', kind: 'phase', phaseId: 'draft' }]),
  connections: Object.freeze([]),
  bindings: Object.freeze([
    {
      kind: 'input',
      nodeId: 'draft-node',
      inputKey: 'brief',
      source: { from: 'workflow-input', portId: 'brief' }
    },
    {
      kind: 'output',
      nodeId: 'draft-node',
      portId: 'spec-document',
      outputKey: 'spec-document'
    }
  ]),
  startNodeIds: Object.freeze(['draft-node']),
  recommendedNext: Object.freeze([])
});

const REVIEW_WORKFLOW = Object.freeze({
  workflowId: 'spec-review',
  name: 'Spec Review',
  version: 1,
  inputs: Object.freeze([{ portId: 'spec', label: 'Spec', type: 'text' }]),
  outputs: Object.freeze([{ portId: 'verdict', label: 'Verdict', type: 'markdown' }]),
  nodes: Object.freeze([{ nodeId: 'review-node', kind: 'phase', phaseId: 'review' }]),
  connections: Object.freeze([]),
  bindings: Object.freeze([
    {
      kind: 'input',
      nodeId: 'review-node',
      inputKey: 'spec',
      source: { from: 'workflow-input', portId: 'spec' }
    },
    {
      kind: 'output',
      nodeId: 'review-node',
      portId: 'verdict',
      outputKey: 'verdict'
    }
  ]),
  startNodeIds: Object.freeze(['review-node']),
  recommendedNext: Object.freeze([])
});

const CHILD_WORKFLOWS = Object.freeze([AUTHORING_WORKFLOW, REVIEW_WORKFLOW]);

const AUTHORED_WORKFLOW = Object.freeze({
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  description: 'Draft, then review.',
  version: 4,
  nodes: Object.freeze([
    { nodeId: 'draft', kind: 'workflow', workflowId: 'spec-authoring', label: 'Draft the spec' },
    { nodeId: 'review', kind: 'workflow', workflowId: 'spec-review' }
  ]),
  connections: Object.freeze([
    {
      from: { nodeId: 'draft', portId: 'spec-document' },
      to: { kind: 'node', nodeId: 'review', portId: 'spec' },
      condition: {
        left: { source: 'node-status', nodeId: 'draft' },
        operator: 'in',
        right: Object.freeze(['completed', 'failed'])
      },
      priority: 10,
      isDefault: false
    }
  ]),
  bindings: Object.freeze([
    {
      kind: 'input',
      nodeId: 'review',
      inputKey: 'spec',
      source: { from: 'node-output', nodeId: 'draft', portId: 'spec-document' }
    }
  ]),
  startNodeIds: Object.freeze(['draft'])
});

const GHOST_WORKFLOW = Object.freeze({
  ...AUTHORED_WORKFLOW,
  nodes: Object.freeze([
    { nodeId: 'draft', kind: 'workflow', workflowId: 'ghost-authoring', label: 'Draft the spec' },
    { nodeId: 'review', kind: 'workflow', workflowId: 'ghost-review' }
  ])
});

const GHOST_PHASE_WORKFLOW = Object.freeze({
  workflowId: 'phase-only-flow',
  name: 'Phase Only Flow',
  version: 2,
  inputs: Object.freeze([{ portId: 'brief', label: 'Brief', type: 'text' }]),
  outputs: Object.freeze([{ portId: 'spec-out', label: 'Spec Out', type: 'markdown' }]),
  nodes: Object.freeze([{ nodeId: 'draft', kind: 'phase', phaseId: 'ghost-phase' }]),
  connections: Object.freeze([
    {
      from: { nodeId: 'draft' },
      to: { kind: 'return' }
    }
  ]),
  bindings: Object.freeze([
    {
      kind: 'input',
      nodeId: 'draft',
      inputKey: 'brief',
      source: { from: 'workflow-input', portId: 'brief' }
    },
    {
      kind: 'output',
      nodeId: 'draft',
      portId: 'spec-out',
      outputKey: 'spec-document'
    }
  ]),
  startNodeIds: Object.freeze(['draft'])
});

const ZULU_WORKFLOW = Object.freeze({
  ...AUTHORED_WORKFLOW,
  nodes: Object.freeze([
    { nodeId: 'draft', kind: 'workflow', workflowId: 'zulu-authoring', label: 'Draft the spec' },
    { nodeId: 'review', kind: 'workflow', workflowId: 'alpha-review' }
  ])
});

describe('Feature 086 / 263 — export one Workflow, references-only', () => {
  it('writes a package document naming the Workflow, its nodes, connection, and start set', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
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
    expect(text).toContain('      kind: workflow');
    expect(text).toContain('      workflowId: spec-authoring');
    expect(text).toContain('      label: Draft the spec');
    expect(text).toContain('    - nodeId: review');
    expect(text).toContain('      workflowId: spec-review');
    expect(text).toContain(['  startNodeIds:', '    - draft', ''].join('\n'));
  });

  it('writes both endpoints structurally and the condition as data', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
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
        '        kind: node',
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
    expect(text).not.toMatch(/^\s{6}(?:from|to): \S/m);
    expect(text).not.toContain('condition: ');
    expect(text).not.toContain('connectionId');
  });

  it('exports nothing when one id names two rows — neither copy wins', async () => {
    const h = buildHarness({
      workflows: [
        { ...AUTHORED_WORKFLOW, name: 'First Copy' },
        { ...AUTHORED_WORKFLOW, name: 'Second Copy', version: 7 },
        ...CHILD_WORKFLOWS
      ],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('writes no included section at all in references-only mode', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('included');
    expect(text).not.toContain('kind: Phase');
    expect(text).not.toContain('instruction:');
    const topLevel = text
      .split('\n')
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(':')[0]);
    expect(topLevel).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
  });
});

describe('Feature 263 — references-only never requires child Workflows or Phases to resolve', () => {
  it('exports a Workflow whose child Workflows are missing from every layer, nodes intact', async () => {
    const h = buildHarness({ workflows: [GHOST_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('      workflowId: ghost-authoring');
    expect(text).toContain('      workflowId: ghost-review');
  });

  it('exports a Workflow whose Phase nodes are missing from every layer, nodes intact', async () => {
    const h = buildHarness({ workflows: [GHOST_PHASE_WORKFLOW] });
    await exportHandler(h.ctx, command('phase-only-flow'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('      phaseId: ghost-phase');
  });

  it('relaxes only the reference-class defects, never a structural one', async () => {
    const h = buildHarness({
      workflows: [
        {
          ...GHOST_WORKFLOW,
          connections: [
            ...GHOST_WORKFLOW.connections,
            {
              from: { nodeId: 'review', portId: 'verdict' },
              to: { kind: 'node', nodeId: 'draft', portId: 'brief' }
            }
          ]
        }
      ]
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });
});

describe('Feature 263 — the transport boundary admits only references-only and include-closure', () => {
  const envelope = (payload: unknown): unknown => ({
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'workflow-export-gate-2',
    payload
  });

  it.each(['references-only', 'include-closure'])(
    'admits a Workflow export in %s mode',
    (inclusion) => {
      expect(
        validateInboundMessage(
          envelope({ resourceKind: 'workflow', resourceId: 'ship-it-flow', inclusion })
        )
      ).toMatchObject({ ok: true });
    }
  );

  it('refuses a Workflow export using the retired include-pipelines mode', () => {
    expect(
      validateInboundMessage(
        envelope({
          resourceKind: 'workflow',
          resourceId: 'ship-it-flow',
          inclusion: 'include-pipelines'
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

  it('refuses the retired pipeline resourceKind on export', () => {
    expect(
      validateInboundMessage(
        envelope({ resourceKind: 'pipeline', resourceId: 'default', inclusion: 'references-only' })
      )
    ).toMatchObject({ ok: false, reason: 'invalid-resource-kind' });
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
    expect(MUTATING_COMMANDS.has(CMD_EXPORT_PROCESS_YAML)).toBe(true);
  });

  it('writes no configuration and runs no command', async () => {
    const workflows: readonly unknown[] = [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS];
    const before = JSON.stringify(workflows);
    const h = buildHarness({
      workflows,
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(workflows)).toBe(before);
  });

  it('hands the adapter a bare name and no location', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
      phases: PHASE_LAYER
    });
    await exportHandler(h.ctx, command('ship-it-flow'));

    expect(h.saved[0]!.suggestedFileName).toBe('ship-it-flow.workflow.yaml');
    expect(h.saved[0]!.suggestedFileName).not.toContain('/');
    expect(h.saved[0]!.suggestedFileName).not.toContain('\\');
  });

  it('turns an adapter throw into a generic failure and keeps the detail in the log', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
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
});

describe('Feature 263 — export the full transitive closure (include-closure)', () => {
  const FULL = {
    workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS],
    phases: PHASE_LAYER
  } as const;

  it('carries every child Workflow and every Phase behind them', async () => {
    const h = buildHarness(FULL);
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    const text = h.saved[0]!.text;
    expect(text).toContain('  workflows:\n');
    expect(text).toContain('        id: spec-authoring');
    expect(text).toContain('        id: spec-review');
    expect(text).toContain('  phases:\n');
    expect(text).toContain('        phaseId: draft');
    expect(text).toContain('        phaseId: review');
    expect(text.indexOf('  workflows:')).toBeLessThan(text.indexOf('  phases:'));
  });

  it('produces byte-identical documents on two exports of an unchanged catalog', async () => {
    for (const inclusion of [
      'references-only',
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

  it('nests the two modes: include-closure starts with references-only and adds included', async () => {
    const texts: string[] = [];
    for (const inclusion of ['references-only', 'include-closure'] as const) {
      const h = buildHarness(FULL);
      await exportHandler(h.ctx, command('ship-it-flow', inclusion));
      expect(h.acks[0]!.result, inclusion).toEqual({ outcome: 'saved' });
      texts.push(h.saved[0]!.text);
    }

    expect(texts[1]!.startsWith(texts[0]!)).toBe(true);
    expect(texts[1]!.length).toBeGreaterThan(texts[0]!.length);
  });

  it('refuses when a child Workflow in the closure does not resolve, naming it in node order', async () => {
    const h = buildHarness({ workflows: [ZULU_WORKFLOW] });
    await exportHandler(h.ctx, command('ship-it-flow', 'include-closure'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'workflow', resourceId: 'zulu-authoring' }
    });
  });

  it('refuses when a Phase in the closure does not resolve, naming it', async () => {
    const h = buildHarness({
      workflows: [AUTHORED_WORKFLOW, ...CHILD_WORKFLOWS]
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
});
