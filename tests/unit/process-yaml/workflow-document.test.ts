import { describe, expect, it } from 'vitest';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

function minimalWorkflowDefinition(
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  return {
    workflowId: 'feature-delivery',
    name: 'Feature Delivery',
    version: 7,
    description: 'Plan, build, and verify a feature.',
    inputs: [
      {
        portId: 'request-brief',
        label: 'Request Brief',
        type: 'text',
        required: true,
        description: 'Feature brief'
      }
    ],
    outputs: [
      {
        portId: 'release-packet',
        label: 'Release Packet',
        type: 'markdown',
        required: true,
        description: 'Final release artifact'
      }
    ],
    nodes: [
      { nodeId: 'plan-phase', kind: 'phase', phaseId: 'plan', label: 'Plan Phase' },
      { nodeId: 'impl-workflow', kind: 'workflow', workflowId: 'impl-flow', label: 'Implement Flow' }
    ],
    connections: [
      {
        from: { nodeId: 'plan-phase', portId: 'plan-doc' },
        to: { kind: 'node', nodeId: 'impl-workflow', portId: 'spec-bundle' },
        handoff: 'auto',
        condition: {
          left: { source: 'node-output', nodeId: 'plan-phase', field: 'plan-doc' },
          operator: 'exists'
        },
        priority: 1,
        isDefault: false,
        selection: 'first'
      },
      {
        from: { nodeId: 'impl-workflow', portId: 'bundle-out' },
        to: { kind: 'return', nodeId: 'return' },
        handoff: 'manual',
        isDefault: true
      }
    ],
    bindings: [
      {
        kind: 'input',
        nodeId: 'plan-phase',
        inputKey: 'feature-brief',
        type: 'text',
        required: true,
        source: { from: 'workflow-input', portId: 'request-brief' },
        selection: 'exactlyOne'
      },
      {
        kind: 'input',
        nodeId: 'impl-workflow',
        inputKey: 'spec-bundle',
        source: { from: 'node-output', nodeId: 'plan-phase', portId: 'plan-doc' }
      },
      {
        kind: 'output',
        nodeId: 'impl-workflow',
        portId: 'release-packet',
        outputKey: 'bundle-out',
        sourcePortId: 'bundle-out',
        type: 'markdown',
        label: 'Release Packet',
        selection: 'last'
      }
    ],
    startNodeIds: ['plan-phase'],
    executionDefaults: {
      runner: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      timeoutSeconds: 900
    },
    recommendedNext: ['release-workflow'],
    ...overrides
  };
}

function minimalChildWorkflowDefinition(
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  return {
    workflowId: 'impl-flow',
    name: 'Implementation Flow',
    version: 2,
    description: 'Child workflow for implementation.',
    inputs: [{ portId: 'spec-bundle', label: 'Spec Bundle', type: 'text', required: true }],
    outputs: [{ portId: 'bundle-out', label: 'Bundle Output', type: 'markdown', required: true }],
    nodes: [{ nodeId: 'code-phase', kind: 'phase', phaseId: 'code' }],
    connections: [
      {
        from: { nodeId: 'code-phase' },
        to: { kind: 'return', nodeId: 'return' }
      }
    ],
    bindings: [
      {
        kind: 'input',
        nodeId: 'code-phase',
        inputKey: 'spec-in',
        source: { from: 'workflow-input', portId: 'spec-bundle' }
      },
      {
        kind: 'output',
        nodeId: 'code-phase',
        portId: 'bundle-out',
        outputKey: 'artifact-out'
      }
    ],
    startNodeIds: ['code-phase'],
    ...overrides
  };
}

function minimalPhaseDefinition(overrides: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    phaseId: 'plan',
    name: 'Plan',
    version: 3,
    description: 'Draft the implementation plan.',
    instruction: 'Plan the feature.',
    ...overrides
  } as PhaseDefinition;
}

function parsePackageFromText(yaml: string) {
  const parsed = parseDocumentText(yaml);
  if (!parsed.ok) {
    return { ok: false as const, refusal: parsed.refusal };
  }
  return parseWorkflowPackage(parsed.node);
}

describe('Workflow YAML document round-trip and validation', () => {
  describe('documentFromWorkflowDefinition & serializeWorkflowDocument', () => {
    it('projects a composable WorkflowDefinition with included.workflows and included.phases and round-trips losslessly', () => {
      const root = minimalWorkflowDefinition();
      const child = minimalChildWorkflowDefinition();
      const planPhase = minimalPhaseDefinition();
      const codePhase = minimalPhaseDefinition({
        phaseId: 'code',
        name: 'Code'
      });

      const doc = documentFromWorkflowDefinition(root, {
        workflows: [child],
        phases: [planPhase, codePhase]
      });

      expect(doc.apiVersion).toBe('schegent/v1');
      expect(doc.kind).toBe('Workflow');
      expect(doc.metadata).toEqual({
        id: 'feature-delivery',
        name: 'Feature Delivery',
        description: 'Plan, build, and verify a feature.',
        version: 7
      });
      expect(doc.included?.workflows).toHaveLength(1);
      expect(doc.included?.workflows?.[0]?.metadata.id).toBe('impl-flow');
      expect(doc.included?.phases).toHaveLength(2);
      expect(doc.included?.phases?.map((p) => p.metadata.phaseId)).toEqual(['plan', 'code']);

      const yaml = serializeWorkflowDocument(doc);
      expect(yaml).toContain('apiVersion: schegent/v1');
      expect(yaml).toContain('kind: Workflow');
      expect(yaml).toContain('phaseId: plan');
      expect(yaml).toContain('workflowId: impl-flow');
      expect(yaml).toContain('kind: return');
      expect(yaml).toContain('handoff: auto');
      expect(yaml).toContain('handoff: manual');
      expect(yaml).toContain('recommendedNext:');

      const parsed = parsePackageFromText(yaml);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.resources).toHaveLength(4);
      const [rootRes, childRes, phase1Res, phase2Res] = parsed.resources;
      expect(rootRes).toEqual({ ok: true, resourceKind: 'workflow', definition: root });
      expect(childRes).toEqual({ ok: true, resourceKind: 'workflow', definition: child });
      expect(phase1Res?.ok).toBe(true);
      expect(phase2Res?.ok).toBe(true);

      const reprojected = documentFromWorkflowDefinition(root, {
        workflows: [child],
        phases: [planPhase, codePhase]
      });
      expect(serializeWorkflowDocument(reprojected)).toBe(yaml);
    });

    it('omits empty included sub-sections and optional fields when absent', () => {
      const minimal: WorkflowDefinition = {
        workflowId: 'feature-delivery',
        name: 'Feature Delivery',
        version: 7,
        description: 'Plan, build, and verify a feature.',
        nodes: [{ nodeId: 'plan-phase', kind: 'phase', phaseId: 'plan' }],
        connections: [],
        startNodeIds: ['plan-phase']
      };

      const doc = documentFromWorkflowDefinition(minimal);
      expect(doc.included).toBeUndefined();
      expect(doc.spec.executionDefaults).toBeUndefined();
      expect(doc.spec.recommendedNext).toBeUndefined();

      const yaml = serializeWorkflowDocument(doc);
      expect(yaml).not.toContain('included:');
      expect(yaml).not.toContain('executionDefaults:');
      expect(yaml).not.toContain('recommendedNext:');

      const parsed = parsePackageFromText(yaml);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.resources).toHaveLength(1);
    });

    it('supports list literals in condition.right', () => {
      const wf = minimalWorkflowDefinition({
        connections: [
          {
            from: { nodeId: 'plan-phase' },
            to: { kind: 'node', nodeId: 'impl-workflow' },
            condition: {
              left: { source: 'node-status', nodeId: 'plan-phase' },
              operator: 'in',
              right: ['completed', 'failed']
            }
          }
        ]
      });

      const doc = documentFromWorkflowDefinition(wf);
      const yaml = serializeWorkflowDocument(doc);
      const parsed = parsePackageFromText(yaml);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.resources[0]).toEqual({
        ok: true,
        resourceKind: 'workflow',
        definition: wf
      });
    });
  });

  describe('parseWorkflowPackage — legacy rejection and structural validation', () => {
    it('rejects kind: Pipeline with unsupported-kind', () => {
      const yaml = [
        'apiVersion: schegent/v1',
        'kind: Pipeline',
        'metadata:',
        '  id: legacy-pipe',
        '  name: Legacy Pipe',
        '  version: 1',
        'spec:',
        '  phaseIds:',
        '    - plan',
        ''
      ].join('\n');

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('unsupported-kind');
    });

    it('rejects legacy workflow node fields (pipelineId), legacy binding sources (pipeline-input, phase-output, phaseIndex), and included.pipelines', () => {
      const yaml = [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: legacy-wf',
        '  name: Legacy Workflow',
        '  version: 1',
        'spec:',
        '  nodes:',
        '    - nodeId: n1',
        '      pipelineId: old-pipe',
        '  bindings:',
        '    - kind: input',
        '      nodeId: n1',
        '      phaseIndex: 0',
        '      inputKey: p1',
        '      source:',
        '        from: pipeline-input',
        '        portId: in1',
        '    - kind: output',
        '      nodeId: n1',
        '      portId: p2',
        '      from: phase-output',
        '  startNodeIds:',
        '    - n1',
        'included:',
        '  pipelines:',
        '    - metadata:',
        '        id: old-pipe',
        ''
      ].join('\n');

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const root = result.resources[0];
      expect(root?.ok).toBe(false);
      if (root === undefined || root.ok) return;
      const fields = root.defects.map((d) => d.field);
      expect(fields).toContain('included.pipelines');
      expect(fields.some((f) => f.includes('pipelineId'))).toBe(true);
    });

    it('rejects nested included blocks inside included.workflows[i] with unknown-field', () => {
      const yaml = [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: root-wf',
        '  name: Root Workflow',
        '  version: 1',
        'spec:',
        '  nodes:',
        '    - nodeId: n1',
        '      kind: workflow',
        '      workflowId: child-wf',
        '  startNodeIds:',
        '    - n1',
        'included:',
        '  workflows:',
        '    - metadata:',
        '        id: child-wf',
        '        name: Child Workflow',
        '        version: 1',
        '      spec:',
        '        nodes:',
        '          - nodeId: p1',
        '            kind: phase',
        '            phaseId: plan',
        '        startNodeIds:',
        '          - p1',
        '      included:',
        '        phases:',
        '          - metadata:',
        '              phaseId: plan',
        ''
      ].join('\n');

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const child = result.resources[1];
      expect(child?.ok).toBe(false);
      if (child === undefined || child.ok) return;
      expect(child.defects.some((d) => d.code === 'unknown-field' && d.field === 'included')).toBe(
        true
      );
    });

    it('rejects duplicate workflow IDs across root and included.workflows with duplicate-id', () => {
      const yaml = [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: dup-wf',
        '  name: Root',
        '  version: 1',
        'spec:',
        '  nodes:',
        '    - nodeId: n1',
        '      kind: phase',
        '      phaseId: plan',
        '  startNodeIds:',
        '    - n1',
        'included:',
        '  workflows:',
        '    - metadata:',
        '        id: dup-wf',
        '        name: Duplicate Child',
        '        version: 1',
        '      spec:',
        '        nodes:',
        '          - nodeId: n1',
        '            kind: phase',
        '            phaseId: plan',
        '        startNodeIds:',
        '          - n1',
        ''
      ].join('\n');

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('duplicate-id');
    });

    it('rejects duplicate phase IDs inside included.phases with duplicate-id', () => {
      const yaml = [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: root-wf',
        '  name: Root',
        '  version: 1',
        'spec:',
        '  nodes:',
        '    - nodeId: n1',
        '      kind: phase',
        '      phaseId: dup-phase',
        '  startNodeIds:',
        '    - n1',
        'included:',
        '  phases:',
        '    - metadata:',
        '        phaseId: dup-phase',
        '        name: Phase One',
        '        version: 1',
        '      spec:',
        '        instruction: One',
        '    - metadata:',
        '        phaseId: dup-phase',
        '        name: Phase Two',
        '        version: 1',
        '      spec:',
        '        instruction: Two',
        ''
      ].join('\n');

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('duplicate-id');
    });

    it('rejects intra-workflow transition cycles in root or included.workflows with graph-cycle', () => {
      const cyclicRoot: WorkflowDefinition = {
        workflowId: 'feature-delivery',
        name: 'Feature Delivery',
        version: 7,
        description: 'Plan, build, and verify a feature.',
        nodes: [
          { nodeId: 'n1', kind: 'phase', phaseId: 'plan' },
          { nodeId: 'n2', kind: 'phase', phaseId: 'code' }
        ],
        connections: [
          {
            from: { nodeId: 'n1' },
            to: { kind: 'node', nodeId: 'n2' }
          },
          {
            from: { nodeId: 'n2' },
            to: { kind: 'node', nodeId: 'n1' }
          }
        ],
        startNodeIds: ['n1']
      };
      const doc = documentFromWorkflowDefinition(cyclicRoot);
      const yaml = serializeWorkflowDocument(doc);

      const result = parsePackageFromText(yaml);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('graph-cycle');
    });

    it('rejects payloads exceeding PHASE_YAML_MAX_BYTES with too-large', () => {
      const huge = 'a'.repeat(1_048_577);
      const result = parsePackageFromText(huge);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('too-large');
    });
  });
});
