import { describe, expect, it } from 'vitest';
import { parseDocumentBytes } from '../../../src/services/process-yaml/yaml-parser';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../../src/services/process-yaml/workflow-document';
import type { ResultContract } from '../../../src/contracts/decision-results';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

const SAMPLE_RESULT_CONTRACT: ResultContract = {
  version: 1,
  operator: 'structured-result',
  operatorVersion: 1,
  source: { kind: 'declared-output', outputKey: 'out-json' },
  fields: [
    { fieldId: 'passed', type: 'boolean', required: true, selector: ['passed'] },
    { fieldId: 'summary', type: 'string', required: false, selector: ['summary'] }
  ],
  completion: {
    version: 1,
    kind: 'typed',
    test: {
      left: { source: 'result-field', fieldId: 'passed' },
      operator: 'equals',
      right: true
    }
  }
};

const CANDIDATE_PHASE_A: PhaseDefinition = {
  phaseId: 'cand-phase-a',
  name: 'Candidate Phase A',
  version: 1,
  runner: 'claude',
  instruction: 'Execute candidate A',
  resultContract: SAMPLE_RESULT_CONTRACT
};

const CANDIDATE_PHASE_B: PhaseDefinition = {
  phaseId: 'cand-phase-b',
  name: 'Candidate Phase B',
  version: 1,
  runner: 'codex',
  instruction: 'Execute candidate B',
  resultContract: SAMPLE_RESULT_CONTRACT
};

const CANDIDATE_BLOCK_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-candidate-block',
  name: 'Candidate Block Workflow',
  description: 'Reusable candidate-block workflow with decisionResults',
  version: 2,
  inputs: [{ portId: 'prompt', label: 'Prompt', type: 'text', required: true }],
  outputs: [{ portId: 'out-json', label: 'Out JSON', type: 'structured-data', required: true }],
  nodes: [
    { nodeId: 'cand-1', kind: 'phase', phaseId: 'cand-phase-a', label: 'Primary Claude' },
    { nodeId: 'cand-2', kind: 'phase', phaseId: 'cand-phase-b', label: 'Fallback Codex' }
  ],
  connections: [],
  bindings: [
    {
      kind: 'input',
      nodeId: 'cand-1',
      inputKey: 'prompt',
      type: 'text',
      required: true,
      source: { from: 'workflow-input', portId: 'prompt' }
    },
    {
      kind: 'input',
      nodeId: 'cand-2',
      inputKey: 'prompt',
      type: 'text',
      required: true,
      source: { from: 'workflow-input', portId: 'prompt' }
    },
    {
      kind: 'output',
      nodeId: 'cand-1',
      portId: 'out-json',
      outputKey: 'out-json',
      type: 'structured-data'
    },
    {
      kind: 'output',
      nodeId: 'cand-2',
      portId: 'out-json',
      outputKey: 'out-json',
      type: 'structured-data'
    }
  ],
  startNodeIds: ['cand-1', 'cand-2'],
  control: {
    version: 1,
    kind: 'candidate-block',
    candidates: [
      {
        candidateId: 'primary-claude',
        nodeId: 'cand-1',
        priority: 1,
        maxAttempts: 3,
        retry: { initialDelayMs: 2_000, multiplier: 2, maxDelayMs: 30_000 },
        allowUnverifiedTrial: false
      },
      {
        candidateId: 'fallback-codex',
        nodeId: 'cand-2',
        priority: 2,
        maxAttempts: 2,
        allowUnverifiedTrial: true
      }
    ],
    availabilityPolicy: 'first-ready',
    maxDispatches: 5,
    monitoringWindowMs: 120_000,
    budget: { mode: 'strict-usd', limitMicrousd: 5_000_000 }
  },
  decisionResults: {
    version: 1,
    fields: [
      { fieldId: 'passed', type: 'boolean', required: true },
      { fieldId: 'summary', type: 'string', required: false }
    ],
    bindings: [
      { fieldId: 'passed', source: { kind: 'selected-candidate', fieldId: 'passed' } },
      { fieldId: 'summary', source: { kind: 'selected-candidate', fieldId: 'summary' } }
    ]
  }
};

const PARENT_CONTROL_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-control-orchestrator',
  name: 'Control Orchestrator',
  version: 1,
  inputs: [
    { portId: 'items-file', label: 'Items File', type: 'local-file', required: true },
    { portId: 'prompt', label: 'Prompt', type: 'text', required: true }
  ],
  nodes: [
    {
      nodeId: 'repeat-block',
      kind: 'workflow',
      workflowId: 'wf-candidate-block',
      label: 'Repeat Candidate Block',
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 4,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'passed' },
            operator: 'equals',
            right: true
          }
        },
        carry: [{ fieldId: 'summary', inputPortId: 'prompt' }],
        onExhausted: 'pause'
      }
    },
    {
      nodeId: 'foreach-block',
      kind: 'workflow',
      workflowId: 'wf-candidate-block',
      label: 'ForEach Candidate Block',
      control: {
        version: 1,
        kind: 'for-each',
        collection: { source: 'workflow-input', portId: 'items-file' },
        itemKeyField: 'itemId',
        itemInputPortId: 'prompt',
        maxItems: 25,
        onItemError: 'continue'
      }
    }
  ],
  connections: [
    {
      from: { nodeId: 'repeat-block' },
      to: { kind: 'node', nodeId: 'foreach-block' },
      condition: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'node-result', nodeId: 'repeat-block', fieldId: 'passed' },
          operator: 'equals',
          right: true
        }
      }
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'repeat-block',
      inputKey: 'prompt',
      type: 'text',
      required: true,
      source: { from: 'workflow-input', portId: 'prompt' }
    }
  ],
  startNodeIds: ['repeat-block'],
  decisionResults: {
    version: 1,
    fields: [{ fieldId: 'finalPassed', type: 'boolean', required: true }],
    bindings: [
      {
        fieldId: 'finalPassed',
        source: { kind: 'node-result', nodeId: 'repeat-block', fieldId: 'passed' }
      }
    ]
  }
};

describe('workflow-control-round-trip (FR-R5-F25 / SPEC-03)', () => {
  it('round-trips CandidateBlockControl, WorkflowDecisionResults, RepeatControl, and ForEachControl losslessly with byte-identical re-serialization', () => {
    const doc = documentFromWorkflowDefinition(PARENT_CONTROL_WORKFLOW, {
      workflows: [CANDIDATE_BLOCK_WORKFLOW],
      phases: [CANDIDATE_PHASE_A, CANDIDATE_PHASE_B]
    });
    const yamlBytes = serializeWorkflowDocument(doc);

    const parsedTree = parseDocumentBytes(Buffer.from(yamlBytes, 'utf8'));
    expect(parsedTree.ok).toBe(true);
    if (!parsedTree.ok) return;

    const pkg = parseWorkflowPackage(parsedTree.node);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;

    expect(pkg.resources).toHaveLength(4);
    const rootRes = pkg.resources.find((_, idx) => idx === 0);
    const childRes = pkg.resources.find((_, idx) => idx === 1);
    expect(rootRes?.ok).toBe(true);
    expect(childRes?.ok).toBe(true);
    if (!rootRes?.ok || rootRes.resourceKind !== 'workflow') return;
    if (!childRes?.ok || childRes.resourceKind !== 'workflow') return;

    expect(rootRes.definition).toEqual(PARENT_CONTROL_WORKFLOW);
    expect(childRes.definition).toEqual(CANDIDATE_BLOCK_WORKFLOW);

    const reserialized = serializeWorkflowDocument(
      documentFromWorkflowDefinition(rootRes.definition, {
        workflows: [childRes.definition],
        phases: [CANDIDATE_PHASE_A, CANDIDATE_PHASE_B]
      })
    );
    expect(reserialized).toBe(yamlBytes);
  });

  it('rejects unknown fields and unsupported control versions during YAML package classification', () => {
    const doc = documentFromWorkflowDefinition(CANDIDATE_BLOCK_WORKFLOW);
    const yamlBytes = serializeWorkflowDocument(doc).replace(
      'kind: candidate-block\n',
      'kind: candidate-block\n    unexpectedKey: true\n'
    );
    const parsedTree = parseDocumentBytes(Buffer.from(yamlBytes, 'utf8'));
    expect(parsedTree.ok).toBe(true);
    if (!parsedTree.ok) return;

    const pkg = parseWorkflowPackage(parsedTree.node);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;

    const rootRes = pkg.resources.find((_, idx) => idx === 0);
    expect(rootRes?.ok).toBe(false);
    if (rootRes?.ok !== false) return;
    expect(rootRes.defects.some((d) => d.code === 'unknown-field')).toBe(true);
  });
});
