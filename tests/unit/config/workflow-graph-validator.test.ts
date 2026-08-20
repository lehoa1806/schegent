import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type {
  WorkflowCondition,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowFieldError,
  WorkflowNode
} from '../../../src/contracts/workflow-definitions';
import { WORKFLOW_ERROR_FIELD_MAX } from '../../../src/config/workflow-definition-validator';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { invalidPipelineCauses } from '../../../src/config/workflow-catalog';

/**
 * `standard` carries one port of every shape the compatibility table distinguishes, so a test
 * can pick a compatible pair, an incompatible pair, or a collection-into-single pair without
 * inventing a new Pipeline each time.
 */
const STANDARD: PipelineDefinition = {
  pipelineId: 'standard',
  name: 'Standard',
  version: 1,
  phaseIds: ['plan'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text' },
    { portId: 'folder', label: 'Folder', type: 'local-folder' },
    { portId: 'list', label: 'List', type: 'source-list' },
    { portId: 'link', label: 'Link', type: 'web-url' },
    { portId: 'feed', label: 'Feed', type: 'pipeline-output' }
  ],
  outputs: [
    { portId: 'plan', label: 'Plan', type: 'markdown' },
    { portId: 'bundle', label: 'Bundle', type: 'file-set' },
    { portId: 'data', label: 'Data', type: 'structured-data' }
  ],
  bindings: [],
  recommendedNext: []
};

/** No `structured-data` or `pipeline-output` output — cannot back a `node-output` operand. */
const PLAIN: PipelineDefinition = {
  pipelineId: 'plain',
  name: 'Plain',
  version: 1,
  phaseIds: ['plan'],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
  outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
  bindings: [],
  recommendedNext: []
};

const CATALOG = [STANDARD, PLAIN];

const node = (nodeId: string, pipelineId = 'standard'): WorkflowNode => ({ nodeId, pipelineId });

const link = (
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
  extra: Partial<WorkflowConnection> = {}
): WorkflowConnection => ({
  from: { nodeId: from, portId: fromPort },
  to: { nodeId: to, portId: toPort },
  ...extra
});

const graph = (
  nodes: readonly WorkflowNode[],
  connections: readonly WorkflowConnection[],
  startNodeIds: readonly string[] = [nodes[0]?.nodeId ?? 'a']
): WorkflowDefinition => ({
  workflowId: 'wf',
  name: 'Workflow',
  version: 1,
  nodes,
  connections,
  startNodeIds
});

const codes = (errors: readonly WorkflowFieldError[]): string[] => errors.map((e) => e.code);
const only = (errors: readonly WorkflowFieldError[], code: string): WorkflowFieldError[] =>
  errors.filter((e) => e.code === code);

/** A two-node chain whose single connection is type-compatible and whose graph is clean. */
const CLEAN = graph([node('a'), node('b')], [link('a', 'plan', 'b', 'brief')]);

describe('clean graph', () => {
  it('reports nothing for a valid two-node graph', () => {
    expect(validateWorkflowGraph(CLEAN, CATALOG)).toEqual([]);
  });

  it('bounds every reported field path to the projection cap', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b', 'missing-pipeline')],
        [link('a', 'ghost', 'b', 'nowhere')],
        ['a']
      ),
      CATALOG
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.field.length).toBeLessThanOrEqual(WORKFLOW_ERROR_FIELD_MAX);
      expect(error.workflowId).toBe('wf');
    }
  });
});

describe('unresolved-endpoint (FR-010)', () => {
  it('reports a connection naming a node that does not exist', () => {
    const errors = validateWorkflowGraph(
      graph([node('a')], [link('a', 'plan', 'ghost', 'brief')], ['a']),
      CATALOG
    );
    const unresolved = only(errors, 'unresolved-endpoint');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].field).toBe('connections[0].to');
    expect(unresolved[0].message).toContain('ghost');
  });

  it('reports a connection naming a port the Pipeline does not declare', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'nope', 'b', 'brief')]),
      CATALOG
    );
    const unresolved = only(errors, 'unresolved-endpoint');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].field).toBe('connections[0].from');
    expect(unresolved[0].message).toContain('nope');
  });

  it('reports both endpoints of one connection independently', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'nope', 'b', 'nowhere')]),
      CATALOG
    );
    expect(only(errors, 'unresolved-endpoint').map((e) => e.field)).toEqual([
      'connections[0].from',
      'connections[0].to'
    ]);
  });

  it('does not also report an incompatible type for an endpoint it could not resolve', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'nope', 'b', 'folder')]),
      CATALOG
    );
    expect(codes(errors)).not.toContain('incompatible-port-types');
  });
});

describe('duplicate-input-binding (FR-010a)', () => {
  it('names the port and every connection binding it', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c')],
        [
          link('a', 'plan', 'c', 'brief'),
          link('a', 'plan', 'b', 'brief'),
          link('b', 'plan', 'c', 'brief')
        ]
      ),
      CATALOG
    );
    const duplicates = only(errors, 'duplicate-input-binding');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].field).toBe('connections[0].to');
    expect(duplicates[0].message).toContain('brief');
    expect(duplicates[0].message).toContain('0');
    expect(duplicates[0].message).toContain('2');
  });

  it('allows one output to fan out to several distinct inputs', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c')],
        [link('a', 'plan', 'b', 'brief'), link('a', 'plan', 'c', 'brief')]
      ),
      CATALOG
    );
    expect(codes(errors)).not.toContain('duplicate-input-binding');
  });
});

describe('incompatible-port-types (FR-011)', () => {
  it('rejects an output type the input type does not accept and names the pair', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'plan', 'b', 'folder')]),
      CATALOG
    );
    const incompatible = only(errors, 'incompatible-port-types');
    expect(incompatible).toHaveLength(1);
    expect(incompatible[0].field).toBe('connections[0]');
    expect(incompatible[0].message).toContain('markdown');
    expect(incompatible[0].message).toContain('local-folder');
  });

  it('accepts every pair in the frozen compatibility table', () => {
    const accepted: readonly (readonly [string, string])[] = [
      ['plan', 'brief'],
      ['bundle', 'list'],
      ['data', 'feed']
    ];
    for (const [fromPort, toPort] of accepted) {
      const errors = validateWorkflowGraph(
        graph([node('a'), node('b')], [link('a', fromPort, 'b', toPort)]),
        CATALOG
      );
      expect(codes(errors)).not.toContain('incompatible-port-types');
    }
  });
});

describe('multiple-default-branches (FR-012)', () => {
  it('rejects a second default outgoing connection on one source node', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c')],
        [
          link('a', 'plan', 'b', 'brief', { isDefault: true }),
          link('a', 'bundle', 'c', 'list', { isDefault: true })
        ]
      ),
      CATALOG
    );
    const defaults = only(errors, 'multiple-default-branches');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].field).toBe('connections[1].isDefault');
    expect(defaults[0].message).toContain('a');
  });

  it('allows one default per source node', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c')],
        [
          link('a', 'plan', 'b', 'brief', { isDefault: true }),
          link('b', 'plan', 'c', 'brief', { isDefault: true })
        ]
      ),
      CATALOG
    );
    expect(codes(errors)).not.toContain('multiple-default-branches');
  });
});

describe('graph-cycle (FR-013)', () => {
  it('names every member of a two-cycle', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief'), link('b', 'plan', 'a', 'brief')]
      ),
      CATALOG
    );
    const cycles = only(errors, 'graph-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].message).toContain('a');
    expect(cycles[0].message).toContain('b');
  });

  it('reports a self-edge as a cycle of one', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'plan', 'a', 'brief')], ['a']),
      CATALOG
    );
    const cycles = only(errors, 'graph-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].message).toContain('a');
  });

  it('reports two disjoint cycles as two defects', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('x'), node('y')],
        [
          link('a', 'plan', 'b', 'brief'),
          link('b', 'plan', 'a', 'brief'),
          link('x', 'plan', 'y', 'brief'),
          link('y', 'plan', 'x', 'brief')
        ],
        ['a', 'x']
      ),
      CATALOG
    );
    expect(only(errors, 'graph-cycle')).toHaveLength(2);
  });
});

describe('unreachable-node (FR-014)', () => {
  it('reports a node no allowed start can reach', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b'), node('island')], [link('a', 'plan', 'b', 'brief')], ['a']),
      CATALOG
    );
    const unreachable = only(errors, 'unreachable-node');
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].field).toBe('nodes[2].nodeId');
    expect(unreachable[0].message).toContain('island');
  });

  it('treats a start with no incoming connection as reachable (FR-015)', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [], ['a', 'b']),
      CATALOG
    );
    expect(codes(errors)).not.toContain('unreachable-node');
  });

  it('accepts a start that is also a connection target', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'plan', 'b', 'brief')], ['a', 'b']),
      CATALOG
    );
    expect(errors).toEqual([]);
  });
});

describe('unknown-pipeline and pipeline-invalid (FR-016, FR-017)', () => {
  it('reports a node whose Pipeline is absent from the effective catalog', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b', 'nowhere')], [], ['a', 'b']),
      CATALOG
    );
    const unknown = only(errors, 'unknown-pipeline');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].field).toBe('nodes[1].pipelineId');
    expect(unknown[0].message).toContain('nowhere');
  });

  it('reports a node whose Pipeline resolved but is invalid, naming the transitive cause', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b', 'broken')], [], ['a', 'b']),
      CATALOG,
      new Map([['broken', 'phase "review" is not in the effective catalog']])
    );
    const invalid = only(errors, 'pipeline-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].field).toBe('nodes[1].pipelineId');
    expect(invalid[0].message).toContain('phase "review" is not in the effective catalog');
    expect(codes(errors)).not.toContain('unknown-pipeline');
  });
});

describe('selection-rule-required (FR-018)', () => {
  it('requires a rule for a collection source feeding a single-valued target', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'bundle', 'b', 'folder')]),
      CATALOG
    );
    const required = only(errors, 'selection-rule-required');
    expect(required).toHaveLength(1);
    expect(required[0].field).toBe('connections[0].selection');
  });

  it('accepts the same connection once a rule is declared', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'bundle', 'b', 'folder', { selection: 'first' })]),
      CATALOG
    );
    expect(errors).toEqual([]);
  });

  it('does not require a rule for a collection source feeding a collection target', () => {
    const errors = validateWorkflowGraph(
      graph([node('a'), node('b')], [link('a', 'bundle', 'b', 'list')]),
      CATALOG
    );
    expect(errors).toEqual([]);
  });
});

const statusCondition = (nodeId: string, right: unknown = 'completed'): WorkflowCondition =>
  ({
    left: { source: 'node-status', nodeId },
    operator: 'equals',
    right
  }) as WorkflowCondition;

const outputCondition = (nodeId: string, field = 'verdict'): WorkflowCondition => ({
  left: { source: 'node-output', nodeId, field },
  operator: 'equals',
  right: 'ok'
});

describe('unsupported-condition (FR-021)', () => {
  it('rejects a condition that is a string before inspecting its content', () => {
    // The field validator rejects this shape first; the guard here is the second boundary, for
    // a caller that builds a definition object without going through it.
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: 'a.status === "completed"' as never })]
      ),
      CATALOG
    );
    const unsupported = only(errors, 'unsupported-condition');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].field).toBe('connections[0].condition');
    // Content was never inspected: no operand defect is reported alongside it.
    expect(codes(errors)).not.toContain('condition-operand-unknown');
  });

  it('rejects an operator outside the closed set (FR-020)', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', {
            condition: { left: { source: 'node-status', nodeId: 'a' }, operator: 'matches' } as never
          })
        ]
      ),
      CATALOG
    );
    expect(codes(errors)).toContain('unsupported-condition');
  });
});

describe('condition-operand-unknown (FR-022)', () => {
  it('rejects an operand naming a node that does not exist', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: statusCondition('ghost') })]
      ),
      CATALOG
    );
    const unknown = only(errors, 'condition-operand-unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].message).toContain('ghost');
  });

  it('rejects a node-output operand on a Pipeline that declares no structured output port', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a', 'plain'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: outputCondition('a') })]
      ),
      CATALOG
    );
    const unknown = only(errors, 'condition-operand-unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].field).toBe('connections[0].condition.left');
  });

  it('accepts a node-output operand on a Pipeline that declares one', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: outputCondition('a') })]
      ),
      CATALOG
    );
    expect(errors).toEqual([]);
  });
});

describe('condition-operand-not-ancestor (FR-023)', () => {
  it('rejects an operand naming a node that cannot have run when the branch is evaluated', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('side')],
        [
          link('a', 'plan', 'b', 'brief', { condition: statusCondition('side') }),
          link('a', 'bundle', 'side', 'list')
        ],
        ['a']
      ),
      CATALOG
    );
    const notAncestor = only(errors, 'condition-operand-not-ancestor');
    expect(notAncestor).toHaveLength(1);
    expect(notAncestor[0].message).toContain('side');
  });

  it('accepts an operand naming the branching node itself', () => {
    // FR-022's clarification names "the source node's terminal run status" as the allowlisted
    // operand, so the branching node is inside its own condition scope.
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: statusCondition('a') })]
      ),
      CATALOG
    );
    expect(errors).toEqual([]);
  });

  it('accepts an operand naming a transitive ancestor', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c')],
        [
          link('a', 'plan', 'b', 'brief'),
          link('b', 'plan', 'c', 'brief', { condition: statusCondition('a') })
        ]
      ),
      CATALOG
    );
    expect(errors).toEqual([]);
  });
});

describe('condition-right-invalid (FR-024)', () => {
  it('rejects a node-status compared against a value outside the terminal enum', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [link('a', 'plan', 'b', 'brief', { condition: statusCondition('a', 'running') })]
      ),
      CATALOG
    );
    const invalid = only(errors, 'condition-right-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].field).toBe('connections[0].condition.right');
  });

  it('accepts each member of the terminal enum', () => {
    for (const status of ['completed', 'failed', 'canceled']) {
      const errors = validateWorkflowGraph(
        graph(
          [node('a'), node('b')],
          [link('a', 'plan', 'b', 'brief', { condition: statusCondition('a', status) })]
        ),
        CATALOG
      );
      expect(errors).toEqual([]);
    }
  });

  it('rejects a right operand on exists', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', {
            condition: {
              left: { source: 'node-output', nodeId: 'a', field: 'verdict' },
              operator: 'exists',
              right: 'ok'
            }
          })
        ]
      ),
      CATALOG
    );
    expect(codes(errors)).toContain('condition-right-invalid');
  });

  it('requires a non-empty literal array for in', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', {
            condition: {
              left: { source: 'node-output', nodeId: 'a', field: 'verdict' },
              operator: 'in',
              right: 'ok'
            }
          })
        ]
      ),
      CATALOG
    );
    expect(codes(errors)).toContain('condition-right-invalid');
  });

  it('accepts a literal array for in and no right for exists', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', {
            condition: {
              left: { source: 'node-output', nodeId: 'a', field: 'verdict' },
              operator: 'in',
              right: ['ok', 'partial']
            }
          }),
          link('a', 'bundle', 'b', 'list', {
            condition: {
              left: { source: 'node-output', nodeId: 'a', field: 'verdict' },
              operator: 'exists'
            }
          })
        ]
      ),
      CATALOG
    );
    expect(errors).toEqual([]);
  });
});

describe('accumulation and the one ordering dependency (FR-019, research R11)', () => {
  it('reports five independent defects in one pass', () => {
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b'), node('c', 'nowhere'), node('island')],
        [
          link('a', 'plan', 'b', 'folder'),
          link('a', 'bundle', 'b', 'brief', { isDefault: true }),
          link('a', 'data', 'b', 'brief', { isDefault: true })
        ],
        ['a']
      ),
      CATALOG
    );

    expect(codes(errors)).toEqual(
      expect.arrayContaining([
        'incompatible-port-types',
        'duplicate-input-binding',
        'multiple-default-branches',
        'unknown-pipeline',
        'unreachable-node'
      ])
    );
  });

  it('suppresses condition-operand defects on a cyclic graph and reports the cycle', () => {
    // Ancestry is undefined while a cycle exists, so operand scope cannot be decided; reporting
    // a speculative not-ancestor defect would send the operator chasing the wrong repair.
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', { condition: statusCondition('b') }),
          link('b', 'plan', 'a', 'brief')
        ]
      ),
      CATALOG
    );

    expect(codes(errors)).toContain('graph-cycle');
    expect(codes(errors)).not.toContain('condition-operand-not-ancestor');
  });

  it('still reports condition shape and right-operand defects on a cyclic graph', () => {
    // Only the ancestry-dependent check is suppressed; shape does not depend on the graph.
    const errors = validateWorkflowGraph(
      graph(
        [node('a'), node('b')],
        [
          link('a', 'plan', 'b', 'brief', { condition: statusCondition('a', 'running') }),
          link('b', 'plan', 'a', 'brief')
        ]
      ),
      CATALOG
    );

    expect(codes(errors)).toContain('graph-cycle');
    expect(codes(errors)).toContain('condition-right-invalid');
  });
});

// Feature 083 (US3, T042) — the dependency closure, resolved for real.
//
// The two cases above hand `validateWorkflowGraph` a cause map built by hand,
// which proves it forwards a cause but not that a cause exists to forward.
// SC-003 is a claim about the whole closure: Workflow -> Pipeline -> Phase. So
// these cases resolve an actual Phase catalog, feed it to an actual Pipeline
// catalog, derive the causes with `invalidPipelineCauses`, and only then
// validate the graph — the same chain `cmd-save-workflows.ts` builds.
describe('dependency closure (US3, T042)', () => {
  const PHASE_ROWS: readonly unknown[] = [
    { id: 'plan', name: 'Plan', version: 1, instruction: 'Plan it.' }
  ];

  /** Names a Phase the catalog does not define, so it cannot resolve (FR-017). */
  const BROKEN_PIPELINE = {
    id: 'broken',
    name: 'Broken',
    version: 1,
    phases: ['plan', 'review'],
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
    outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }]
  };

  const HEALTHY_PIPELINE = {
    id: 'healthy',
    name: 'Healthy',
    version: 1,
    phases: ['plan'],
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
    outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }]
  };

  /** Resolves the real chain and returns exactly what the save path passes down. */
  function closure(
    rows: readonly unknown[]
  ): { effective: readonly PipelineDefinition[]; causes: ReadonlyMap<string, string> } {
    const catalog = resolvePipelineCatalog({
      rows,
      revision: 'rev-pipeline-closure',
      phaseCatalog: resolvePhaseCatalog({ rows: PHASE_ROWS, revision: 'rev-phase-closure' })
        .effective
    });
    return {
      effective: catalog.effective,
      causes: invalidPipelineCauses({ effective: catalog.effective, records: catalog.records })
    };
  }

  it('names the unresolved Phase when a node rests on a Pipeline with a bad Phase (FR-017, SC-003)', () => {
    const { effective, causes } = closure([HEALTHY_PIPELINE, BROKEN_PIPELINE]);

    // Guards the fixture: the cause has to come from the real resolution, not
    // from this test, or the assertion below proves nothing.
    expect(causes.get('broken')).toBeDefined();

    const errors = validateWorkflowGraph(
      graph([node('a', 'healthy'), node('b', 'broken')], [], ['a', 'b']),
      effective,
      causes
    );
    const invalid = only(errors, 'pipeline-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].field).toBe('nodes[1].pipelineId');
    // The operator has to be able to act on this: the failing Phase is named,
    // two levels down from the Workflow they were editing.
    expect(invalid[0].message).toContain('review');
    expect(codes(errors)).not.toContain('unknown-pipeline');
  });

  it('distinguishes a Pipeline that is absent from one that is present but invalid (FR-016)', () => {
    const { effective, causes } = closure([HEALTHY_PIPELINE, BROKEN_PIPELINE]);

    const errors = validateWorkflowGraph(
      graph([node('a', 'broken'), node('b', 'never-authored')], [], ['a', 'b']),
      effective,
      causes
    );
    // Two different repairs: fix the Pipeline, versus author or import it.
    expect(only(errors, 'pipeline-invalid')[0].field).toBe('nodes[0].pipelineId');
    expect(only(errors, 'unknown-pipeline')[0].field).toBe('nodes[1].pipelineId');
  });

  // US3 scenario 3, in the two directions the shipped resolution rule produces.
  //
  // Feature 099 (T496f, FR-042) — the rule used to be scope precedence: an
  // invalid higher-scope row fell through to the next scope that had a usable
  // definition. There is one catalog now, and two rows claiming one id are both
  // invalidated (FR-040). The invariant these two cases were written for is
  // untouched and is what they still assert from opposite sides: the graph
  // validator's verdict is whatever the *effective* catalog says, and never what
  // a raw stored row says.
  it('reads the effective catalog, not the stored rows, when a healthy row is contended', () => {
    const { effective, causes } = closure([
      { ...HEALTHY_PIPELINE, id: 'shared' },
      { ...BROKEN_PIPELINE, id: 'shared' }
    ]);

    // A perfectly usable row for `shared` is sitting in the catalog, and it is
    // still not effective: the second claim on the id invalidated both. Reading
    // the raw rows would have let the node through, which is the mistake this
    // asserts against.
    expect(effective.map((pipeline) => pipeline.pipelineId)).not.toContain('shared');

    const errors = validateWorkflowGraph(
      graph([node('a', 'shared')], [], ['a']),
      effective,
      causes
    );
    expect(only(errors, 'pipeline-invalid')[0].field).toBe('nodes[0].pipelineId');
    expect(codes(errors)).not.toContain('unknown-pipeline');
  });

  it('reports the transitive defect when the only row for that id is invalid', () => {
    const { effective, causes } = closure([{ ...BROKEN_PIPELINE, id: 'shared' }]);

    expect(effective.map((pipeline) => pipeline.pipelineId)).not.toContain('shared');

    const invalid = only(
      validateWorkflowGraph(graph([node('a', 'shared')], [], ['a']), effective, causes),
      'pipeline-invalid'
    );
    expect(invalid).toHaveLength(1);
    // The operator gets the Phase two levels down, not just "this is broken".
    expect(invalid[0].message).toContain('review');
  });

  it('reports one defect per node even when several rest on the same broken Pipeline', () => {
    const { effective, causes } = closure([BROKEN_PIPELINE]);

    const errors = validateWorkflowGraph(
      graph([node('a', 'broken'), node('b', 'broken')], [], ['a', 'b']),
      effective,
      causes
    );
    // Anchored per node: the builder marks both, not just the first.
    expect(only(errors, 'pipeline-invalid').map((error) => error.field)).toEqual([
      'nodes[0].pipelineId',
      'nodes[1].pipelineId'
    ]);
  });
});

// Feature 083 (US4, T046) — FR-021 is satisfied by construction, not by a
// blocklist: a condition is structured data, so there is no expression text to
// hand to a parser, evaluator, template engine, or sandbox. That property is
// invisible in behavioral tests — every one of them would keep passing on the
// day someone adds `jsonata` and an `expr` escape hatch — so it is pinned here
// against the module source instead (research R6).
//
// The rule is deliberately stricter than "no expression library": these modules
// import nothing but relative project paths. An allowlist of forbidden package
// names would have to be maintained forever and would still miss the next
// engine published; "no external dependency at all" cannot.
describe('Feature 083 T046 — the condition path has nothing that could evaluate an expression', () => {
  // `workflow-definition-validator.ts` is scanned alongside the graph validator
  // because `readCondition` lives there and runs first. Guarding only the graph
  // validator would leave the larger half of the condition path open.
  const CONDITION_MODULES = [
    'src/config/workflow-graph-validator.ts',
    'src/config/workflow-definition-validator.ts'
  ] as const;

  const REPO_ROOT = resolvePath(__dirname, '..', '..', '..');

  function moduleSource(relativePath: string): string {
    return readFileSync(resolvePath(REPO_ROOT, relativePath), 'utf8');
  }

  /** Every module specifier: static `from '...'`, side-effect `import '...'`, `require('...')`. */
  function importSpecifiers(source: string): string[] {
    const found: string[] = [];
    const patterns = [
      /\bfrom\s+['"]([^'"]+)['"]/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) found.push(match[1]);
    }
    return found;
  }

  const isProjectRelative = (specifier: string): boolean => specifier.startsWith('.');

  /** Each is a way to turn a string into running code without importing anything. */
  const FORBIDDEN_CONSTRUCTS: readonly { label: string; pattern: RegExp; sample: string }[] = [
    { label: 'eval', pattern: /\beval\s*\(/, sample: 'eval(authored)' },
    { label: 'the Function constructor', pattern: /\bFunction\s*\(/, sample: 'new Function(src)' },
    { label: 'constructor access', pattern: /\.constructor\b/, sample: 'x.constructor("y")' },
    { label: 'dynamic import', pattern: /(^|[^.\w])import\s*\(/, sample: 'await import(name)' },
    { label: 'require', pattern: /\brequire\s*\(/, sample: "require('jsonata')" },
    { label: 'the vm module', pattern: /\bnode:vm\b|['"]vm['"]/, sample: "import 'node:vm'" }
  ];

  it.each(CONDITION_MODULES)('finds the imports it is meant to inspect in %s', (relativePath) => {
    // A scanner that matched nothing would make every assertion below vacuous.
    expect(importSpecifiers(moduleSource(relativePath)).length).toBeGreaterThan(0);
  });

  it.each(CONDITION_MODULES)('imports only relative project modules in %s', (relativePath) => {
    const external = importSpecifiers(moduleSource(relativePath)).filter(
      (specifier) => !isProjectRelative(specifier)
    );

    expect(
      external,
      'an expression parser, template engine, or sandbox could only arrive as an external import'
    ).toEqual([]);
  });

  it.each(CONDITION_MODULES)('contains no way to execute authored text in %s', (relativePath) => {
    const source = moduleSource(relativePath);
    const present = FORBIDDEN_CONSTRUCTS.filter((construct) => construct.pattern.test(source)).map(
      (construct) => construct.label
    );

    expect(present).toEqual([]);
  });

  it.each(FORBIDDEN_CONSTRUCTS)('the $label matcher recognizes its own construct', (construct) => {
    // Proves the matchers discriminate: a pattern that matches nothing would
    // report a clean module forever.
    expect(construct.pattern.test(construct.sample)).toBe(true);
  });

  it.each(['jsonata', 'expr-eval', 'handlebars', 'nunjucks', 'jexl', 'acorn', 'node:vm', 'mathjs'])(
    'treats %s as an external import',
    (specifier) => {
      expect(isProjectRelative(specifier)).toBe(false);
    }
  );

  it.each(['./workflow-graph', '../contracts/workflow-definitions'])(
    'treats %s as a project module',
    (specifier) => {
      expect(isProjectRelative(specifier)).toBe(true);
    }
  );
});

// Feature 083 (T063, SC-009) — the validation-latency ceiling.
//
// SC-009 budgets 100 ms for a graph of up to 20 nodes and 40 connections,
// "measured over the validation itself". So the graph is built once, outside
// the timed region, and only `validateWorkflowGraph` is inside it.
//
// The fixture is a *clean* graph on purpose. Every defect the validator can
// report is a short-circuit somewhere — an unresolved Pipeline skips that
// node's port checks, a cycle skips the condition ancestry walk — so a graph
// with errors does less work, not more. A clean graph at the stated size is
// the honest worst case for this shape.
//
// A single sample on a shared CI runner is noise, not a measurement, so the
// assertion is on the median of repeated runs after a warm-up. That still
// measures the validator: the median is a real observation, unlike a mean
// that one scheduler preemption can drag past the budget.
describe('validation latency (SC-009)', () => {
  const SC009_NODE_COUNT = 20;
  const SC009_CONNECTION_COUNT = 40;
  const SC009_BUDGET_MS = 100;

  const id = (index: number): string => `n${String(index).padStart(2, '0')}`;

  /**
   * A layered DAG: every connection runs from a lower index to a higher one, so
   * the graph is acyclic by construction and every node is reachable from
   * `n00` through the spine. Each `(toNode, toPort)` pair is used once, which
   * keeps the duplicate-input-binding check satisfied.
   */
  const buildGraph = (): WorkflowDefinition => {
    const nodes = Array.from({ length: SC009_NODE_COUNT }, (_, index) => node(id(index)));
    const connections: WorkflowConnection[] = [];

    // Spine: 19 connections, markdown into text.
    for (let index = 1; index < SC009_NODE_COUNT; index += 1) {
      connections.push(link(id(index - 1), 'plan', id(index), 'brief'));
    }
    // Skip-level: 18 connections, file-set into source-list. Both sides are
    // collection-typed, so no `selection` rule is required (FR-018).
    for (let index = 2; index < SC009_NODE_COUNT; index += 1) {
      connections.push(link(id(index - 2), 'bundle', id(index), 'list'));
    }
    // Conditional: 3 connections, structured-data into pipeline-output, each
    // guarded by an operand on an ancestor so the ancestry walk actually runs.
    for (let index = 3; index <= 5; index += 1) {
      connections.push(
        link(id(index - 3), 'data', id(index), 'feed', {
          condition: outputCondition(id(index - 3))
        })
      );
    }

    return graph(nodes, connections, [id(0)]);
  };

  const SC009_GRAPH = buildGraph();

  it('builds a fixture at exactly the size SC-009 names', () => {
    // The budget is meaningless if the fixture drifts below the stated size.
    expect(SC009_GRAPH.nodes).toHaveLength(SC009_NODE_COUNT);
    expect(SC009_GRAPH.connections).toHaveLength(SC009_CONNECTION_COUNT);
    expect(codes(validateWorkflowGraph(SC009_GRAPH, CATALOG))).toEqual([]);
  });

  it(`validates a ${SC009_NODE_COUNT}-node, ${SC009_CONNECTION_COUNT}-connection graph within ${SC009_BUDGET_MS} ms`, () => {
    for (let run = 0; run < 5; run += 1) validateWorkflowGraph(SC009_GRAPH, CATALOG);

    const samples: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const started = performance.now();
      validateWorkflowGraph(SC009_GRAPH, CATALOG);
      samples.push(performance.now() - started);
    }

    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)];
    const worst = samples[samples.length - 1];

    expect(
      median,
      `SC-009: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms over ${samples.length} runs`
    ).toBeLessThanOrEqual(SC009_BUDGET_MS);
  });
});
