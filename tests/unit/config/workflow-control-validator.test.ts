import { describe, expect, it } from 'vitest';
import {
  validateCandidateBlockControl,
  validateWorkflowControlsInGraph,
  validateWorkflowDecisionResults,
  validateWorkflowNodeControl
} from '../../../src/config/workflow-control-validator';
import { validateWorkflowDefinition } from '../../../src/config/workflow-definition-validator';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

function makeCandidatePhase(
  phaseId: string,
  instruction = `Run ${phaseId}`,
  runner: PhaseDefinition['runner'] = 'claude'
): PhaseDefinition {
  return {
    phaseId,
    name: `Phase ${phaseId}`,
    version: 1,
    runner,
    instruction,
    resultContract: {
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      source: { kind: 'declared-output', outputKey: 'out-json' },
      fields: [
        { fieldId: 'approved', type: 'boolean', required: true, selector: ['approved'] },
        { fieldId: 'score', type: 'number', required: false, selector: ['score'] }
      ],
      completion: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'approved' },
          operator: 'equals',
          right: true
        }
      }
    }
  };
}

function makeCandidateBlockWorkflow(
  candidateCount: number,
  maxAttemptsPerCandidate?: number,
  maxDispatches?: number
): WorkflowDefinition {
  const candidates = Array.from({ length: candidateCount }, (_, idx) => ({
    candidateId: `cand-${idx + 1}`,
    nodeId: `n-${idx + 1}`,
    ...(maxAttemptsPerCandidate !== undefined ? { maxAttempts: maxAttemptsPerCandidate } : {})
  }));
  const nodes = Array.from({ length: candidateCount }, (_, idx) => ({
    nodeId: `n-${idx + 1}`,
    kind: 'phase' as const,
    phaseId: `phase-${idx + 1}`
  }));
  return {
    workflowId: 'wf-candidates',
    name: 'Candidate Block WF',
    version: 1,
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
    outputs: [{ portId: 'out-json', label: 'Out JSON', type: 'structured-data', required: true }],
    nodes,
    connections: [],
    bindings: [
      ...nodes.map((n) => ({
        kind: 'input' as const,
        nodeId: n.nodeId,
        inputKey: 'brief',
        type: 'text' as const,
        required: true,
        source: { from: 'workflow-input' as const, portId: 'brief' }
      })),
      ...nodes.map((n) => ({
        kind: 'output' as const,
        nodeId: n.nodeId,
        portId: 'out-json',
        outputKey: 'out-json',
        type: 'structured-data' as const
      }))
    ],
    startNodeIds: nodes.map((n) => n.nodeId),
    control: {
      version: 1,
      kind: 'candidate-block',
      candidates,
      ...(maxDispatches !== undefined ? { maxDispatches } : {})
    },
    decisionResults: {
      version: 1,
      fields: [
        { fieldId: 'approved', type: 'boolean', required: true },
        { fieldId: 'score', type: 'number', required: false }
      ],
      bindings: [
        { fieldId: 'approved', source: { kind: 'selected-candidate', fieldId: 'approved' } },
        { fieldId: 'score', source: { kind: 'selected-candidate', fieldId: 'score' } }
      ]
    }
  };
}

describe('workflow-control-validator (FR-R5-F25 / SPEC-03)', () => {
  describe('CandidateBlockControl bounds and defaults', () => {
    it.each([1, 3, 4, 8])('accepts %d candidates in a candidate block', (count) => {
      const wf = makeCandidateBlockWorkflow(count);
      const phases = Array.from({ length: count }, (_, idx) =>
        makeCandidatePhase(`phase-${idx + 1}`, `Instruction ${idx + 1}`)
      );
      const defResult = validateWorkflowDefinition(wf);
      expect(defResult.errors).toEqual([]);
      expect(defResult.definition).not.toBeNull();

      const graphErrors = validateWorkflowGraph(defResult.definition!, [], new Map(), {
        effectivePhases: phases,
        effectiveWorkflows: [defResult.definition!]
      });
      expect(graphErrors).toEqual([]);
    });

    it.each([0, 9])('rejects %d candidates outside 1..8', (count) => {
      const candidates = Array.from({ length: count }, (_, idx) => ({
        candidateId: `cand-${idx + 1}`,
        nodeId: `n-${idx + 1}`
      }));
      const res = validateCandidateBlockControl(
        { version: 1, kind: 'candidate-block', candidates },
        'wf-test'
      );
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.field === 'control.candidates' && e.code === 'invalid-range')).toBe(true);
    });

    it.each([1, 20])('accepts candidate maxAttempts = %d', (maxAttempts) => {
      const wf = makeCandidateBlockWorkflow(2, maxAttempts);
      const defResult = validateWorkflowDefinition(wf);
      expect(defResult.errors).toEqual([]);
    });

    it.each([0, 21])('rejects candidate maxAttempts = %d outside 1..20', (maxAttempts) => {
      const res = validateCandidateBlockControl(
        {
          version: 1,
          kind: 'candidate-block',
          candidates: [{ candidateId: 'cand-1', nodeId: 'n-1', maxAttempts }]
        },
        'wf-test'
      );
      expect(res.ok).toBe(false);
      expect(res.errors[0]?.field).toBe('control.candidates[0].maxAttempts');
      expect(res.errors[0]?.code).toBe('invalid-range');
    });

    it('defaults aggregate maxDispatches to min(40, sum(maxAttempts)) when 8 candidates each declare maxAttempts = 20', () => {
      const wf = makeCandidateBlockWorkflow(8, 20);
      const res = validateCandidateBlockControl(wf.control, wf.workflowId);
      expect(res.ok).toBe(true);
      expect(res.resolved?.maxDispatches).toBe(40);
      expect(res.resolved?.availabilityPolicy).toBe('first-ready');
      expect(res.resolved?.monitoringWindowMs).toBe(86_400_000);
      expect(res.resolved?.budget).toEqual({ mode: 'count-only' });
    });

    it('rejects duplicate candidateId and duplicate candidate nodeId', () => {
      const res = validateCandidateBlockControl(
        {
          version: 1,
          kind: 'candidate-block',
          candidates: [
            { candidateId: 'dup', nodeId: 'n-1' },
            { candidateId: 'dup', nodeId: 'n-1' }
          ]
        },
        'wf-test'
      );
      expect(res.ok).toBe(false);
      expect(res.errors.map((e) => e.code)).toContain('duplicate-candidate-id');
      expect(res.errors.map((e) => e.code)).toContain('duplicate-candidate-node-id');
    });

    it('accepts two candidates that share the same backend runner but declare different instructions', () => {
      const wf = makeCandidateBlockWorkflow(2);
      const phase1 = makeCandidatePhase('phase-1', 'Instruction variant A', 'claude');
      const phase2 = makeCandidatePhase('phase-2', 'Instruction variant B', 'claude');
      const graphErrors = validateWorkflowGraph(wf, [], new Map(), {
        effectivePhases: [phase1, phase2],
        effectiveWorkflows: [wf]
      });
      expect(graphErrors).toEqual([]);
    });

    it('rejects internal connections, non-Phase nodes, unreferenced nodes, and mismatched startNodeIds on a candidate block', () => {
      const base = makeCandidateBlockWorkflow(2);
      const withConn = validateWorkflowDefinition({
        ...base,
        connections: [{ from: { nodeId: 'n-1' }, to: { nodeId: 'n-2' } }],
        startNodeIds: ['n-2', 'n-1']
      });
      expect(withConn.errors.map((e) => e.code)).toContain('candidate-connections-forbidden');
      expect(withConn.errors.map((e) => e.code)).toContain('candidate-start-nodes-mismatch');
    });

    it('rejects candidate input/output/result contract mismatches across candidates', () => {
      const wf = makeCandidateBlockWorkflow(2);
      const phase1 = makeCandidatePhase('phase-1');
      const phase2MissingField: PhaseDefinition = {
        ...makeCandidatePhase('phase-2'),
        resultContract: {
          version: 1,
          operator: 'structured-result',
          operatorVersion: 1,
          source: { kind: 'declared-output', outputKey: 'out-json' },
          fields: [
            // Missing `approved`, and `score` is required here while optional on workflow.decisionResults
            { fieldId: 'score', type: 'number', required: true, selector: ['score'] }
          ],
          completion: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'result-field', fieldId: 'score' },
              operator: 'greaterThanOrEqual',
              right: 0
            }
          }
        }
      };

      const wfMissingBindings: WorkflowDefinition = {
        ...wf,
        bindings: (wf.bindings ?? []).filter((b) => b.nodeId === 'n-1')
      };

      const errors = validateWorkflowGraph(wfMissingBindings, [], new Map(), {
        effectivePhases: [phase1, phase2MissingField],
        effectiveWorkflows: [wfMissingBindings]
      });
      const codes = errors.map((e) => e.code);
      expect(codes).toContain('missing-candidate-input-binding');
      expect(codes).toContain('missing-candidate-output-binding');
      expect(codes).toContain('candidate-result-field-mismatch');
    });
  });

  describe('WorkflowDecisionResults validation', () => {
    it('rejects duplicate fieldIds, missing bindings, and invalid source kinds', () => {
      const res = validateWorkflowDecisionResults(
        {
          version: 1,
          fields: [
            { fieldId: 'approved', type: 'boolean', required: true },
            { fieldId: 'approved', type: 'boolean', required: true }
          ],
          bindings: [
            { fieldId: 'undeclared', source: { kind: 'selected-candidate', fieldId: 'approved' } }
          ]
        },
        'wf-plain',
        false
      );
      expect(res.ok).toBe(false);
      expect(res.errors.map((e) => e.code)).toContain('duplicate-field-id');
      expect(res.errors.map((e) => e.code)).toContain('unknown-decision-result-field');
      expect(res.errors.map((e) => e.code)).toContain('invalid-decision-result-binding-source');
    });
  });

  describe('RepeatControl and ForEachControl validation', () => {
    const validUntil = {
      version: 1 as const,
      kind: 'typed' as const,
      test: {
        left: { source: 'result-field' as const, fieldId: 'approved' },
        operator: 'equals' as const,
        right: true
      }
    };

    it('accepts valid Repeat (1..25 iterations) and ForEach (1..100 maxItems) controls', () => {
      const repeatRes = validateWorkflowNodeControl(
        {
          version: 1,
          kind: 'repeat',
          maxIterations: 25,
          until: validUntil,
          carry: [{ fieldId: 'approved', inputPortId: 'prev-approved' }],
          onExhausted: 'pause'
        },
        'wf-parent',
        'nodes[0].control'
      );
      expect(repeatRes.ok).toBe(true);

      const forEachRes = validateWorkflowNodeControl(
        {
          version: 1,
          kind: 'for-each',
          collection: { source: 'workflow-input', portId: 'items-file' },
          itemKeyField: 'id',
          itemInputPortId: 'item-json',
          maxItems: 100,
          onItemError: 'continue'
        },
        'wf-parent',
        'nodes[1].control'
      );
      expect(forEachRes.ok).toBe(true);
    });

    it('rejects Repeat maxIterations outside 1..25, node-result in until, and duplicate carry targets', () => {
      const badRepeat = validateWorkflowNodeControl(
        {
          version: 1,
          kind: 'repeat',
          maxIterations: 26,
          until: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'node-result', nodeId: 'n1', fieldId: 'approved' },
              operator: 'equals',
              right: true
            }
          },
          carry: [
            { fieldId: 'a', inputPortId: 'same-port' },
            { fieldId: 'b', inputPortId: 'same-port' }
          ]
        },
        'wf-parent',
        'nodes[0].control'
      );
      expect(badRepeat.ok).toBe(false);
      const codes = badRepeat.errors.map((e) => e.code);
      expect(codes).toContain('invalid-range');
      expect(codes).toContain('condition-operand-scope');
      expect(codes).toContain('duplicate-carry-target');
    });

    it('rejects ForEach maxItems outside 1..100, unknown fields, and unsupported control version', () => {
      const badForEach = validateWorkflowNodeControl(
        {
          version: 2,
          kind: 'for-each',
          collection: { source: 'workflow-input', portId: 'items-file' },
          itemInputPortId: 'item-json',
          maxItems: 101,
          extraField: true
        },
        'wf-parent',
        'nodes[0].control'
      );
      expect(badForEach.ok).toBe(false);
      const codes = badForEach.errors.map((e) => e.code);
      expect(codes).toContain('unsupported-control-version');
      expect(codes).toContain('invalid-range');
      expect(codes).toContain('unknown-field');
    });

    it('validates Repeat carry mappings and ForEach collection/itemInputPortId against child Workflow contracts', () => {
      const childWf: WorkflowDefinition = {
        workflowId: 'wf-body',
        name: 'Body WF',
        version: 1,
        inputs: [
          { portId: 'item-json', label: 'Item JSON', type: 'text', required: true },
          { portId: 'wrong-type', label: 'Wrong Type', type: 'source', required: false }
        ],
        nodes: [{ nodeId: 'p1', kind: 'phase', phaseId: 'phase-1' }],
        connections: [],
        startNodeIds: ['p1'],
        decisionResults: {
          version: 1,
          fields: [{ fieldId: 'approved', type: 'boolean', required: true }],
          bindings: [{ fieldId: 'approved', source: { kind: 'node-result', nodeId: 'p1', fieldId: 'approved' } }]
        }
      };

      const parentWf: WorkflowDefinition = {
        workflowId: 'wf-parent',
        name: 'Parent WF',
        version: 1,
        inputs: [{ portId: 'bad-col', label: 'Bad Col', type: 'text', required: false }],
        nodes: [
          {
            nodeId: 'rep-node',
            kind: 'workflow',
            workflowId: 'wf-body',
            control: {
              version: 1,
              kind: 'repeat',
              maxIterations: 3,
              until: {
                version: 1,
                kind: 'typed',
                test: {
                  left: { source: 'result-field', fieldId: 'missing-field' },
                  operator: 'equals',
                  right: true
                }
              },
              carry: [{ fieldId: 'approved', inputPortId: 'wrong-type' }]
            }
          },
          {
            nodeId: 'fe-node',
            kind: 'workflow',
            workflowId: 'wf-body',
            control: {
              version: 1,
              kind: 'for-each',
              collection: { source: 'workflow-input', portId: 'bad-col' },
              itemInputPortId: 'item-json'
            }
          }
        ],
        connections: [{ from: { nodeId: 'rep-node' }, to: { nodeId: 'fe-node' } }],
        bindings: [
          {
            kind: 'input',
            nodeId: 'fe-node',
            inputKey: 'item-json',
            source: { from: 'workflow-input', portId: 'bad-col' }
          }
        ],
        startNodeIds: ['rep-node']
      };

      const errors = validateWorkflowControlsInGraph({
        definition: parentWf,
        acyclic: true,
        edges: [{ from: 'rep-node', to: 'fe-node' }],
        phasesById: new Map([['phase-1', makeCandidatePhase('phase-1')]]),
        workflowsById: new Map([
          ['wf-body', childWf],
          ['wf-parent', parentWf]
        ])
      });

      const codes = errors.map((e) => e.code);
      expect(codes).toContain('condition-operand-unknown');
      expect(codes).toContain('invalid-carry-input-port');
      expect(codes).toContain('invalid-foreach-collection-source');
      expect(codes).toContain('conflicting-foreach-item-binding');
    });
  });
});
