import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_DEFINITION_SCOPES,
  WORKFLOW_NODE_TERMINAL_STATUSES,
  WORKFLOW_SELECTION_RULES,
  WORKFLOW_WRITABLE_SCOPES,
  isWorkflowConditionOperator,
  isWorkflowDefinitionScope,
  isWorkflowNodeTerminalStatus,
  isWorkflowSelectionRule,
  isWritableWorkflowDefinitionScope
} from '../../../src/contracts/workflow-definitions';
import type {
  ScopedWorkflowSavePayload,
  WorkflowCatalogMutation,
  WorkflowCondition,
  WorkflowConditionOperand,
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowDefinitionScope,
  WorkflowDerivedPorts,
  WorkflowNode,
  WritableWorkflowDefinitionScope
} from '../../../src/contracts/workflow-definitions';
import type { HistoryTerminalStatus } from '../../../src/state/history-entry';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import { validateWorkflowGraph } from '../../../src/config/workflow-graph-validator';

const CONTRACT_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'contracts',
  'workflow-definitions.ts'
);

describe('workflow definition scopes', () => {
  it('declares the three catalog layers in the same authored order as the Pipeline family', () => {
    expect(WORKFLOW_DEFINITION_SCOPES).toEqual(['built-in', 'user', 'workspace']);
  });

  it('exposes only the two writable scopes', () => {
    expect(WORKFLOW_WRITABLE_SCOPES).toEqual(['user', 'workspace']);
  });

  it('narrows unknown strings away from the scope union', () => {
    expect(isWorkflowDefinitionScope('workspace')).toBe(true);
    expect(isWorkflowDefinitionScope('built-in')).toBe(true);
    expect(isWorkflowDefinitionScope('global')).toBe(false);
    expect(isWorkflowDefinitionScope(undefined)).toBe(false);
  });

  it('rejects built-in as a writable target (FR-026)', () => {
    expect(isWritableWorkflowDefinitionScope('user')).toBe(true);
    expect(isWritableWorkflowDefinitionScope('workspace')).toBe(true);
    expect(isWritableWorkflowDefinitionScope('built-in')).toBe(false);
  });
});

describe('closed condition operator union (FR-020)', () => {
  it('enumerates exactly the eight supported operators', () => {
    expect(WORKFLOW_CONDITION_OPERATORS).toEqual([
      'equals',
      'notEquals',
      'in',
      'exists',
      'greaterThan',
      'greaterThanOrEqual',
      'lessThan',
      'lessThanOrEqual'
    ]);
  });

  it('carries no duplicate member', () => {
    expect(new Set<string>(WORKFLOW_CONDITION_OPERATORS).size).toBe(
      WORKFLOW_CONDITION_OPERATORS.length
    );
  });

  it('narrows anything outside the closed set, including expression-shaped strings', () => {
    expect(isWorkflowConditionOperator('equals')).toBe(true);
    expect(isWorkflowConditionOperator('matches')).toBe(false);
    expect(isWorkflowConditionOperator('=== ')).toBe(false);
    expect(isWorkflowConditionOperator(null)).toBe(false);
  });
});

describe('closed selection rule set (FR-018)', () => {
  it('enumerates exactly the three collection selection rules', () => {
    expect(WORKFLOW_SELECTION_RULES).toEqual(['first', 'last', 'exactlyOne']);
  });

  it('narrows unknown strings away from the union', () => {
    expect(isWorkflowSelectionRule('exactlyOne')).toBe(true);
    expect(isWorkflowSelectionRule('any')).toBe(false);
    expect(isWorkflowSelectionRule(0)).toBe(false);
  });
});

describe('closed terminal run-status enum (FR-022)', () => {
  it('enumerates exactly the three shipped terminal statuses', () => {
    expect(WORKFLOW_NODE_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'canceled']);
  });

  it('mirrors the run-side HistoryTerminalStatus members exactly', () => {
    // A member added run-side without being added here would let a portable
    // definition compare against a status the run layer can never produce.
    const runSide: readonly HistoryTerminalStatus[] = ['completed', 'failed', 'canceled'];
    expect([...WORKFLOW_NODE_TERMINAL_STATUSES].sort()).toEqual([...runSide].sort());
  });

  it('uses the canonical single-l spelling of canceled', () => {
    expect(WORKFLOW_NODE_TERMINAL_STATUSES).toContain('canceled');
    expect(WORKFLOW_NODE_TERMINAL_STATUSES as readonly string[]).not.toContain('cancelled');
  });

  it('narrows non-terminal and unknown statuses away from the union', () => {
    expect(isWorkflowNodeTerminalStatus('completed')).toBe(true);
    expect(isWorkflowNodeTerminalStatus('running')).toBe(false);
    expect(isWorkflowNodeTerminalStatus('paused')).toBe(false);
    expect(isWorkflowNodeTerminalStatus('cancelled')).toBe(false);
  });
});

describe('mutation kind exhaustiveness (FR-029)', () => {
  const describeMutation = (mutation: WorkflowCatalogMutation): string => {
    switch (mutation.kind) {
      case 'create':
        return `create:${mutation.workflowId}`;
      case 'edit':
        return `edit:${mutation.workflowId}`;
      case 'duplicate':
        return `duplicate:${mutation.sourceScope}:${mutation.sourceWorkflowId}:${mutation.workflowId}`;
      case 'remove':
        return `remove:${mutation.workflowId}`;
      case 'reset':
        return 'reset';
      default: {
        const unreachable: never = mutation;
        return unreachable;
      }
    }
  };

  it('covers all five intents with no residual union member', () => {
    const mutations: readonly WorkflowCatalogMutation[] = [
      { kind: 'create', workflowId: 'alpha' },
      { kind: 'edit', workflowId: 'alpha' },
      { kind: 'duplicate', sourceScope: 'built-in', sourceWorkflowId: 'alpha', workflowId: 'beta' },
      { kind: 'remove', workflowId: 'alpha' },
      { kind: 'reset' }
    ];
    expect(mutations.map(describeMutation)).toEqual([
      'create:alpha',
      'edit:alpha',
      'duplicate:built-in:alpha:beta',
      'remove:alpha',
      'reset'
    ]);
  });
});

describe('contract shapes are structurally assignable', () => {
  it('accepts a fully populated definition and save payload', () => {
    const left: WorkflowConditionOperand = {
      source: 'node-output',
      nodeId: 'design',
      field: 'verdict'
    };
    const condition: WorkflowCondition = { left, operator: 'equals', right: 'approved' };
    const nodes: readonly WorkflowNode[] = [
      { nodeId: 'design', pipelineId: 'design-review', label: 'Design pass' },
      { nodeId: 'implement', pipelineId: 'standard' }
    ];
    const connections: readonly WorkflowConnection[] = [
      {
        from: { nodeId: 'design', portId: 'decision' },
        to: { nodeId: 'implement', portId: 'brief' },
        condition,
        priority: 10,
        isDefault: false,
        selection: 'first'
      }
    ];
    const definition: WorkflowDefinition = {
      workflowId: 'design-then-implement',
      name: 'Design then implement',
      description: 'Suggest the implementation Pipeline after design lands.',
      version: 1,
      nodes,
      connections,
      startNodeIds: ['design']
    };
    const scope: WritableWorkflowDefinitionScope = 'workspace';
    const payload: ScopedWorkflowSavePayload = {
      scope,
      expectedRevision: 'abc123',
      mutation: { kind: 'create', workflowId: 'design-then-implement' },
      workflows: [definition]
    };
    const anyScope: WorkflowDefinitionScope = scope;

    expect(payload.workflows).toHaveLength(1);
    expect(definition.connections).toHaveLength(1);
    expect(anyScope).toBe('workspace');
  });

  it('accepts a node-status operand with no field, and a bare connection', () => {
    const left: WorkflowConditionOperand = { source: 'node-status', nodeId: 'design' };
    const condition: WorkflowCondition = { left, operator: 'equals', right: 'completed' };
    const connection: WorkflowConnection = {
      from: { nodeId: 'design', portId: 'decision' },
      to: { nodeId: 'implement', portId: 'brief' }
    };

    expect(condition.right).toBe('completed');
    expect(connection.condition).toBeUndefined();
    expect(connection.priority).toBeUndefined();
    expect(connection.selection).toBeUndefined();
  });

  it('keeps the derived port set separate from the stored definition (FR-048)', () => {
    const derived: WorkflowDerivedPorts = {
      inputs: [{ nodeId: 'design', portId: 'brief', label: 'Brief', type: 'text' }],
      outputs: [{ nodeId: 'implement', portId: 'plan', label: 'Plan', type: 'markdown' }]
    };
    const definition: WorkflowDefinition = {
      workflowId: 'minimal',
      name: 'Minimal',
      version: 1,
      nodes: [{ nodeId: 'only', pipelineId: 'standard' }],
      connections: [],
      startNodeIds: ['only']
    };

    expect(derived.inputs).toHaveLength(1);
    // A Workflow-level port list is derived, never a field on the stored row.
    expect(Object.keys(definition)).not.toContain('inputs');
    expect(Object.keys(definition)).not.toContain('outputs');
  });
});

describe('the two senses of "Workflow" stay distinguishable (FR-046, SC-012)', () => {
  /**
   * The run-side family already owns these names. The definition-side contract is a
   * distinct vocabulary; a collision would make it impossible to tell from an import
   * whether a symbol describes a queued request in flight or a reusable graph.
   */
  const RUN_SIDE_EXPORTS: readonly string[] = [
    'WorkflowRun',
    'WorkflowRunPipeline',
    'WorkflowRunStatus',
    'WorkflowRunSummary',
    'WorkflowRunRepairedAuditEvent',
    'WorkflowRunRepairResult',
    'WorkflowRunFactory',
    'WorkflowRunFactoryDeps',
    'WorkflowStatus',
    'WorkflowSnapshot',
    'WorkflowPipelineReference',
    'WorkflowLifecycleAuditor',
    'WorkflowControllerDeps',
    'WorkflowControllerOptions'
  ];

  const exportedNames = (): readonly string[] => {
    const source = readFileSync(CONTRACT_SOURCE, 'utf8');
    const names: string[] = [];
    const pattern = /^export\s+(?:declare\s+)?(?:interface|type|const|function|class|enum)\s+(\w+)/gm;
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match !== null) {
      names.push(match[1]);
      match = pattern.exec(source);
    }
    return names;
  };

  it('exports at least the contract surface the data model names', () => {
    const names = new Set(exportedNames());
    for (const expected of [
      'WORKFLOW_DEFINITION_SCOPES',
      'WORKFLOW_WRITABLE_SCOPES',
      'WORKFLOW_CONDITION_OPERATORS',
      'WORKFLOW_SELECTION_RULES',
      'WORKFLOW_NODE_TERMINAL_STATUSES',
      'WorkflowDefinition',
      'WorkflowNode',
      'WorkflowConnection',
      'WorkflowCondition',
      'WorkflowConditionOperand',
      'WorkflowFieldError',
      'WorkflowSourceRecord',
      'WorkflowCatalogResolution',
      'WorkflowCatalogMutation',
      'ScopedWorkflowSavePayload',
      'WorkflowDerivedPort',
      'WorkflowDerivedPorts'
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('collides with no run-side exported name', () => {
    const collisions = exportedNames().filter((name) => RUN_SIDE_EXPORTS.includes(name));
    expect(collisions).toEqual([]);
  });

  it('imports no vscode surface, so the contract stays portable', () => {
    const source = readFileSync(CONTRACT_SOURCE, 'utf8');
    expect(source).not.toMatch(/from\s+'vscode'/);
    expect(source).not.toMatch(/require\(\s*'vscode'\s*\)/);
  });

  it('reuses the shipped port-type unions rather than redeclaring them', () => {
    const source = readFileSync(CONTRACT_SOURCE, 'utf8');
    expect(source).toMatch(/from\s+'\.\/pipeline-definitions'/);
    expect(source).not.toMatch(/PIPELINE_INPUT_PORT_TYPES\s*=/);
    expect(source).not.toMatch(/PIPELINE_OUTPUT_PORT_TYPES\s*=/);
  });
});

// Feature 083 (US6, T054) — parallelism is excluded by construction (FR-040).
//
// FR-040 is the kind of requirement that is satisfied by an absence, and an
// absence is what a later change silently fills in. There is no rejection rule
// to test, because the design's claim is stronger than a rejection rule: the
// vocabulary to *express* concurrency was never admitted. Several outgoing
// connections on one node are mutually exclusive alternatives resolved one at a
// time (FR-012), not a fan-out.
//
// So the assertions below are deliberately of three different kinds — a type
// that stops compiling, a source scan, and a behavioral check — because each
// one closes a hole the other two leave open.
describe('parallel execution is excluded by construction (US6, T054)', () => {
  /**
   * Every spelling by which a graph format in this space admits concurrency:
   * a per-connection fan-out marker, a per-node parallel-branch count, or a
   * "run all outgoing edges" flag.
   */
  type ConcurrencyKey =
    | 'concurrency'
    | 'maxConcurrency'
    | 'parallel'
    | 'parallelism'
    | 'parallelBranches'
    | 'concurrent'
    | 'simultaneous'
    | 'fanOut'
    | 'fanOutAll'
    | 'broadcast'
    | 'multicast'
    | 'forkJoin'
    | 'join'
    | 'waitForAll'
    | 'runAll';

  // Compile-time, not run-time: interfaces are erased, so no assertion made at
  // run time could see a field being added. These two annotations stop `tsc`
  // the day one of the names above is declared on either interface — which is
  // the only moment at which FR-040 could actually be broken.
  //
  // The bracket form is the non-distributive one; `Extract<...> extends never`
  // without it would also answer `true` for a union that happens to include a
  // forbidden key, and would quietly pass.
  const connectionDeclaresNoConcurrency: [Extract<keyof WorkflowConnection, ConcurrencyKey>] extends [
    never
  ]
    ? true
    : false = true;
  const nodeDeclaresNoConcurrency: [Extract<keyof WorkflowNode, ConcurrencyKey>] extends [never]
    ? true
    : false = true;

  it('declares no concurrency or fan-out field on either graph interface (FR-040)', () => {
    // The two constants above carry the assertion; referencing them here is
    // what ties the compile-time check to a named, reported test.
    expect(connectionDeclaresNoConcurrency).toBe(true);
    expect(nodeDeclaresNoConcurrency).toBe(true);
  });

  /** Matches the whole vocabulary, in any casing or separator style. */
  const CONCURRENCY_VOCABULARY =
    /parallel|concurren|fan[-_]?out|simultaneous|broadcast|multicast|fork[-_]?join|wait[-_]?for[-_]?all|run[-_]?all/i;

  it('names no concurrency concept anywhere in the two graph interface bodies', () => {
    const source = readFileSync(CONTRACT_SOURCE, 'utf8');
    for (const name of ['WorkflowNode', 'WorkflowConnection']) {
      const body = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
      expect(body, `${name} must be declared in the contract`).not.toBeNull();
      // The declaration body only — the file's prose explains *why* parallelism
      // is absent and necessarily uses the word.
      expect(body?.[1]).not.toMatch(CONCURRENCY_VOCABULARY);
    }
  });

  it('emits no defect code that names parallel execution (FR-040)', () => {
    // `WorkflowFieldError.code` is a plain `string`, not a closed union, so the
    // set to check is the set of codes the validators can actually emit. Read
    // from source for that reason: a union would have been checkable by type,
    // and this is the honest substitute.
    const emitted = new Set<string>();
    for (const file of ['workflow-definition-validator.ts', 'workflow-graph-validator.ts']) {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'src', 'config', file),
        'utf8'
      );
      for (const match of source.matchAll(/\bcode:\s*'([a-z][a-z0-9-]*)'|,\s*'([a-z][a-z0-9-]+)',\s*$/gm)) {
        const code = match[1] ?? match[2];
        if (code !== undefined) emitted.add(code);
      }
    }

    // Non-vacuity: the scan must actually be finding codes. Known emitters that
    // would disappear only if the extraction broke.
    expect(emitted.size).toBeGreaterThan(10);
    expect(emitted).toContain('graph-cycle');
    expect(emitted).toContain('unreachable-node');

    expect([...emitted].filter((code) => CONCURRENCY_VOCABULARY.test(code))).toEqual([]);
  });

  it('validates a node with several outgoing connections clean (FR-012, FR-040)', () => {
    const pipeline: PipelineDefinition = {
      pipelineId: 'standard',
      name: 'Standard',
      version: 1,
      phaseIds: ['plan'],
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
      outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
      bindings: [],
      recommendedNext: []
    };
    const edge = (to: string, extra: Partial<WorkflowConnection> = {}): WorkflowConnection => ({
      from: { nodeId: 'source', portId: 'plan' },
      to: { nodeId: to, portId: 'brief' },
      ...extra
    });
    // Three alternatives off one node: two guarded, one default. Under a
    // fan-out reading this is three simultaneous successors; under FR-012 it is
    // one choice among three, and either way the graph is well formed.
    const definition: WorkflowDefinition = {
      workflowId: 'branching',
      name: 'Branching',
      version: 1,
      nodes: [
        { nodeId: 'source', pipelineId: 'standard' },
        { nodeId: 'approved', pipelineId: 'standard' },
        { nodeId: 'rejected', pipelineId: 'standard' },
        { nodeId: 'fallback', pipelineId: 'standard' }
      ],
      connections: [
        edge('approved', {
          priority: 1,
          condition: {
            left: { source: 'node-status', nodeId: 'source' },
            operator: 'equals',
            right: 'completed'
          }
        }),
        edge('rejected', {
          priority: 2,
          condition: {
            left: { source: 'node-status', nodeId: 'source' },
            operator: 'equals',
            right: 'failed'
          }
        }),
        edge('fallback', { isDefault: true })
      ],
      startNodeIds: ['source']
    };

    expect(validateWorkflowGraph(definition, [pipeline])).toEqual([]);
  });
});
