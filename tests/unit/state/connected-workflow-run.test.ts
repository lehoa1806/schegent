// Feature 088 (T003, US1) — the connected-run aggregate's invariants.
//
// Seven properties, one per data-model.md invariant. They are asserted here
// rather than in the coordinator because they hold at construction and at every
// write, and a coordinator test can only ever sample the paths it happens to
// exercise.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';
import {
  COMPARED_MAX_LENGTH,
  ConnectedRunInvariantError,
  appendAttempt,
  appendDecision,
  assertConnectedRunInvariants,
  assertInvocationControlMarkers,
  createConnectedRun,
  createInvocationFrame,
  renderCompared,
  resolveBoundQueueId,
  type ConnectedWorkflowRun,
  type RoutingDecision,
  type WorkflowInvocationFrame
} from '../../../src/state/connected-workflow-run';

function graph(): WorkflowDefinition {
  return {
    workflowId: 'wf-triage',
    name: 'Triage',
    version: 1,
    nodes: [
      { nodeId: 'n-triage', pipelineId: 'p-triage' },
      { nodeId: 'n-fix', pipelineId: 'p-fix' },
      { nodeId: 'n-escalate', pipelineId: 'p-fix' }
    ],
    connections: [
      {
        from: { nodeId: 'n-triage', portId: 'verdict' },
        to: { nodeId: 'n-fix', portId: 'report' },
        condition: {
          left: { source: 'node-output', nodeId: 'n-triage', field: 'verdict' },
          operator: 'equals',
          right: 'fixable'
        }
      },
      {
        from: { nodeId: 'n-triage', portId: 'verdict' },
        to: { nodeId: 'n-escalate', portId: 'report' },
        isDefault: true
      }
    ],
    startNodeIds: ['n-triage']
  };
}

function pipelines(): Record<string, WorkflowRunPipeline> {
  return {
    'p-triage': { id: 'p-triage', name: 'Triage', phases: [{ id: 'specify', name: 'Specify' }] },
    'p-fix': { id: 'p-fix', name: 'Fix', phases: [{ id: 'implement', name: 'Implement' }] }
  };
}

function newRun(): ConnectedWorkflowRun {
  return createConnectedRun({
    connectedRunId: 'cr-1',
    workflowId: 'wf-triage',
    graph: graph(),
    pipelines: pipelines(),
    startedAt: 1_000
  });
}

function started(): ConnectedWorkflowRun {
  return appendAttempt(newRun(), 'n-triage', { queueItemId: 'q-1', startedAt: 1_001 });
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    nodeId: 'n-triage',
    attemptIndex: 0,
    decidedAt: 2_000,
    operands: [
      { source: 'node-output', nodeId: 'n-triage', field: 'verdict', resolved: true, compared: 'fixable' }
    ],
    connections: [
      { index: 0, matched: true, isDefault: false },
      { index: 1, matched: false, isDefault: true }
    ],
    defaultApplied: false,
    eligible: [0],
    ...overrides
  };
}

describe('connected run — invariant 1: frozen means frozen', () => {
  it('deep-freezes the graph snapshot', () => {
    const run = newRun();
    expect(Object.isFrozen(run.graph)).toBe(true);
    expect(Object.isFrozen(run.graph.nodes)).toBe(true);
    expect(Object.isFrozen(run.graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(run.graph.connections[0]?.condition)).toBe(true);
    expect(() => {
      (run.graph.nodes[0] as { pipelineId: string }).pipelineId = 'p-other';
    }).toThrow(TypeError);
  });

  it('deep-freezes every referenced Pipeline', () => {
    const run = newRun();
    expect(Object.isFrozen(run.pipelines)).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix'])).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix']?.phases)).toBe(true);
    expect(Object.isFrozen(run.pipelines['p-fix']?.phases[0])).toBe(true);
  });

  it('copies rather than aliases, so a later catalog edit cannot reach in', () => {
    const source = graph();
    const sourcePipelines = pipelines();
    const run = createConnectedRun({
      connectedRunId: 'cr-1',
      workflowId: 'wf-triage',
      graph: source,
      pipelines: sourcePipelines,
      startedAt: 1_000
    });
    (source.nodes as { nodeId: string; pipelineId: string }[]).push({
      nodeId: 'n-late',
      pipelineId: 'p-fix'
    });
    delete sourcePipelines['p-fix'];
    expect(run.graph.nodes).toHaveLength(3);
    expect(run.pipelines['p-fix']).toBeDefined();
  });

  it('leaves the graph and pipelines untouched across mutations', () => {
    const run = started();
    const next = appendDecision(run, decision());
    expect(next.graph).toBe(run.graph);
    expect(next.pipelines).toBe(run.pipelines);
  });
});

describe('connected run — invariant 2: attempts only grow', () => {
  it('appends without disturbing earlier entries', () => {
    const first = started();
    const second = appendAttempt(first, 'n-triage', { queueItemId: 'q-2', startedAt: 1_500 });
    expect(second.nodes['n-triage']?.attempts).toHaveLength(2);
    expect(second.nodes['n-triage']?.attempts[0]).toEqual({ queueItemId: 'q-1', startedAt: 1_001 });
    expect(second.nodes['n-triage']?.attempts[1]?.queueItemId).toBe('q-2');
  });

  it('leaves the prior aggregate unchanged', () => {
    const first = started();
    appendAttempt(first, 'n-triage', { queueItemId: 'q-2', startedAt: 1_500 });
    expect(first.nodes['n-triage']?.attempts).toHaveLength(1);
  });

  it('creates a node record only on its first attempt, and never empty', () => {
    const run = newRun();
    expect(run.nodes).toEqual({});
    expect(started().nodes['n-triage']?.attempts).toHaveLength(1);
  });

  it('refuses an attempt on a node the frozen graph does not contain', () => {
    expect(() => appendAttempt(newRun(), 'n-ghost', { queueItemId: 'q-9', startedAt: 1 })).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses a node record whose attempts are empty', () => {
    const run = started();
    expect(() =>
      assertConnectedRunInvariants({
        ...run,
        nodes: { ...run.nodes, 'n-fix': { nodeId: 'n-fix', attempts: [] } }
      })
    ).toThrow(ConnectedRunInvariantError);
  });
});

describe('connected run — invariant 4: decisions only grow', () => {
  it('appends chronologically and preserves earlier decisions', () => {
    const run = appendDecision(started(), decision());
    const next = appendDecision(run, decision({ decidedAt: 3_000 }));
    expect(next.decisions).toHaveLength(2);
    expect(next.decisions[0]?.decidedAt).toBe(2_000);
    expect(run.decisions).toHaveLength(1);
  });

  it('refuses a decision that references an attempt which does not exist', () => {
    expect(() => appendDecision(started(), decision({ attemptIndex: 4 }))).toThrow(
      ConnectedRunInvariantError
    );
    expect(() => appendDecision(started(), decision({ nodeId: 'n-fix' }))).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses a connection outcome outside the frozen graph', () => {
    expect(() =>
      appendDecision(
        started(),
        decision({ connections: [{ index: 7, matched: false, isDefault: false }], eligible: [] })
      )
    ).toThrow(ConnectedRunInvariantError);
  });

  it('refuses an eligible index that no connection outcome names', () => {
    expect(() => appendDecision(started(), decision({ eligible: [1, 5] }))).toThrow(
      ConnectedRunInvariantError
    );
  });

  it('refuses defaultApplied while an explicit condition matched (FR-027)', () => {
    expect(() => appendDecision(started(), decision({ defaultApplied: true }))).toThrow(
      ConnectedRunInvariantError
    );
  });
});

describe('connected run — invariant 5: revision strictly increases', () => {
  it('increments by exactly one per accepted mutation', () => {
    const run = newRun();
    expect(run.revision).toBe(1);
    const withAttempt = appendAttempt(run, 'n-triage', { queueItemId: 'q-1', startedAt: 1_001 });
    expect(withAttempt.revision).toBe(2);
    expect(appendDecision(withAttempt, decision()).revision).toBe(3);
  });

  it('refuses a revision that did not advance', () => {
    const run = started();
    expect(() => assertConnectedRunInvariants({ ...run, revision: 0 })).toThrow(
      ConnectedRunInvariantError
    );
  });
});

describe('connected run — invariant 6: no lifecycle duplication', () => {
  it('holds exactly the persisted field set and nothing lifecycle-shaped', () => {
    const run = appendDecision(started(), decision());
    expect(Object.keys(run).sort()).toEqual([
      'connectedRunId',
      'decisions',
      'graph',
      'nodes',
      'pipelines',
      'revision',
      'startedAt',
      'workflowId'
    ]);
    expect(Object.keys(run.nodes['n-triage'] ?? {}).sort()).toEqual(['attempts', 'nodeId']);
    expect(Object.keys(run.nodes['n-triage']?.attempts[0] ?? {}).sort()).toEqual([
      'queueItemId',
      'startedAt'
    ]);
  });

  it('refuses any field the aggregate does not declare', () => {
    const run = started();
    for (const key of ['status', 'phase', 'logs', 'outputs', 'currentNodeId']) {
      expect(() => assertConnectedRunInvariants({ ...run, [key]: 'x' } as ConnectedWorkflowRun)).toThrow(
        ConnectedRunInvariantError
      );
    }
    expect(() =>
      assertConnectedRunInvariants({
        ...run,
        nodes: { 'n-triage': { nodeId: 'n-triage', attempts: [{ queueItemId: 'q-1', startedAt: 1 }], status: 'running' } }
      } as unknown as ConnectedWorkflowRun)
    ).toThrow(ConnectedRunInvariantError);
  });
});

describe('connected run — invariant 7: no content', () => {
  it('caps the compared rendering and omits a longer one', () => {
    expect(COMPARED_MAX_LENGTH).toBe(64);
    expect(renderCompared('fixable')).toBe('fixable');
    expect(renderCompared(42)).toBe('42');
    expect(renderCompared(true)).toBe('true');
    expect(renderCompared('x'.repeat(COMPARED_MAX_LENGTH))).toHaveLength(COMPARED_MAX_LENGTH);
    expect(renderCompared('x'.repeat(COMPARED_MAX_LENGTH + 1))).toBeUndefined();
    expect(renderCompared(undefined)).toBeUndefined();
  });

  it('refuses an over-long compared value on a persisted decision', () => {
    const run = started();
    expect(() =>
      appendDecision(
        run,
        decision({
          operands: [
            {
              source: 'node-output',
              nodeId: 'n-triage',
              field: 'verdict',
              resolved: true,
              compared: 'x'.repeat(COMPARED_MAX_LENGTH + 1)
            }
          ]
        })
      )
    ).toThrow(ConnectedRunInvariantError);
  });

  it('refuses an absolute path in the only value-derived string there is', () => {
    const run = started();
    for (const compared of ['/Users/someone/secret/doc.md', 'C:\\Users\\someone\\doc.md']) {
      expect(() =>
        appendDecision(
          run,
          decision({
            operands: [
              { source: 'node-output', nodeId: 'n-triage', field: 'verdict', resolved: true, compared }
            ]
          })
        )
      ).toThrow(ConnectedRunInvariantError);
    }
  });

  it('carries no free-text field anywhere in the aggregate', () => {
    // The structural proof of FR-065: the only string fields are identifiers,
    // an output name, and the capped `compared`. There is no description, no
    // instructions, and no plan copy for operator-pasted text to reach.
    const run = appendDecision(started(), decision());
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk({ nodes: run.nodes, decisions: run.decisions, connectedRunId: run.connectedRunId });
    for (const value of strings) {
      expect(value.length).toBeLessThanOrEqual(COMPARED_MAX_LENGTH);
      expect(value.startsWith('/')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 092 (T071, T072, US3) — the queue binding.
//
// One additive optional field, and everything below is a property of its being
// optional: a record written before this feature carries none, so `undefined`
// has to mean the default queue at read time rather than "unbound". That is
// what makes the field additive with no migration entry (FR-046, plan D7) —
// `KEYS.connectedRuns` is a separate key precisely so pre-feature records
// resolve rather than fail, and a read-time default follows that precedent.
// ---------------------------------------------------------------------------

describe('connected run — the queue binding (FR-041, FR-045, FR-046)', () => {
  const known = new Set([DEFAULT_QUEUE_ID, 'q-release']);

  it('carries the binding as a declared field when one is supplied', () => {
    const run = createConnectedRun({
      connectedRunId: 'cr-1',
      workflowId: 'wf-triage',
      graph: graph(),
      pipelines: pipelines(),
      startedAt: 1_000,
      queueId: 'q-release'
    });
    expect(run.queueId).toBe('q-release');
    expect(Object.keys(run).sort()).toEqual([
      'connectedRunId',
      'decisions',
      'graph',
      'nodes',
      'pipelines',
      'queueId',
      'revision',
      'startedAt',
      'workflowId'
    ]);
  });

  it('is fixed at start: every later mutation carries it forward unchanged', () => {
    const run = createConnectedRun({
      connectedRunId: 'cr-1',
      workflowId: 'wf-triage',
      graph: graph(),
      pipelines: pipelines(),
      startedAt: 1_000,
      queueId: 'q-release'
    });
    const withAttempt = appendAttempt(run, 'n-triage', { queueItemId: 'q-1', startedAt: 1_001 });
    const withDecision = appendDecision(withAttempt, decision());
    expect(withAttempt.queueId).toBe('q-release');
    expect(withDecision.queueId).toBe('q-release');
    expect(resolveBoundQueueId(withDecision)).toBe('q-release');
  });

  it('resolves an absent binding to the default queue on read (FR-046)', () => {
    const run = started();
    expect(run.queueId).toBeUndefined(); // 2026-09-06 coincidental: a WorkflowRun, not a ScheduleEventPayloadCore
    expect(resolveBoundQueueId(run)).toBe(DEFAULT_QUEUE_ID);
    // No migration entry: a record with no binding satisfies the invariants as
    // it stands, which is what lets it load rather than be lifted.
    expect(() => assertConnectedRunInvariants(run, { knownQueueIds: known })).not.toThrow();
  });

  it('refuses a binding that names no registry entry, when the registry is in view', () => {
    const run = { ...started(), queueId: 'q-deleted' };
    expect(() => assertConnectedRunInvariants(run, { knownQueueIds: known })).toThrow(
      ConnectedRunInvariantError
    );
    // Without the registry the check is not merely skipped by accident — the
    // aggregate module holds no registry, and a caller that cannot supply one
    // (the migrator reading a memento) gets the shape checks and no more.
    expect(() => assertConnectedRunInvariants(run)).not.toThrow();
  });

  it('refuses a binding that is not a non-empty string', () => {
    for (const queueId of ['', 42, null]) {
      expect(() =>
        assertConnectedRunInvariants({ ...started(), queueId } as unknown as ConnectedWorkflowRun)
      ).toThrow(ConnectedRunInvariantError);
    }
  });
});

describe('a Task carries no Workflow graph (T072, FR-040a)', () => {
  // Decision D1 resolved to Reading B: a Workflow executes as N Tasks
  // coordinated by one aggregate. The graph and the traversal position live on
  // the aggregate; a Task stays a single-Pipeline unit of work. This is a
  // negative property of a persisted shape, so it is pinned by scanning the
  // declaration — the same way the forbidden-construct scan pins "a Workflow
  // condition has no string form".
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../src/queue/feature-request.ts'),
    'utf8'
  );
  const declaration = source.slice(
    source.indexOf('export interface FeatureRequest {'),
    source.indexOf('export interface QueueState {')
  );

  it('declares no graph blueprint and no in-item traversal cursor', () => {
    expect(declaration.length).toBeGreaterThan(0);
    for (const forbidden of [
      /^\s*(readonly\s+)?graph\??\s*:/m,
      /^\s*(readonly\s+)?workflow(Id|Graph|Definition)?\??\s*:/m,
      /^\s*(readonly\s+)?(current|cursor|currentNode|nodeCursor|nodeId)\??\s*:/m,
      /^\s*(readonly\s+)?connectedRunId\??\s*:/m
    ]) {
      expect(declaration).not.toMatch(forbidden);
    }
  });

  it('leaves the graph on the aggregate, which is where the binding also lives', () => {
    const run = createConnectedRun({
      connectedRunId: 'cr-1',
      workflowId: 'wf-triage',
      graph: graph(),
      pipelines: pipelines(),
      startedAt: 1_000,
      queueId: 'q-release'
    });
    // The aggregate references its children by queue-item id and nothing else,
    // so membership is readable in one direction only: aggregate → Task.
    expect(run.graph.nodes).toHaveLength(3);
    expect(Object.keys(run.nodes)).toEqual([]);
  });
});

describe('connected run — structural guards never throw raw TypeError (FR-R8-01 / 01-08)', () => {
  function expectInvariantError(fn: () => void, label: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, `${label}: expected ConnectedRunInvariantError`).toBeInstanceOf(
      ConnectedRunInvariantError
    );
    expect(caught, `${label}: must never throw raw TypeError`).not.toBeInstanceOf(TypeError);
  }

  it('rejects non-object top-level inputs and malformed top-level primitives with ConnectedRunInvariantError', () => {
    for (const bad of [null, undefined, 'string', 42, true, []]) {
      expectInvariantError(
        () => assertConnectedRunInvariants(bad as unknown as ConnectedWorkflowRun),
        `top-level ${String(bad)}`
      );
    }
    const base = started();
    const badTopFields: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['empty connectedRunId', { ...base, connectedRunId: '' }],
      ['numeric connectedRunId', { ...base, connectedRunId: 123 }],
      ['null workflowId', { ...base, workflowId: null }],
      ['NaN startedAt', { ...base, startedAt: Number.NaN }],
      ['Infinity startedAt', { ...base, startedAt: Number.POSITIVE_INFINITY }],
      ['string startedAt', { ...base, startedAt: '1000' }],
      ['NaN revision', { ...base, revision: Number.NaN }],
      ['float revision', { ...base, revision: 1.5 }]
    ];
    for (const [label, candidate] of badTopFields) {
      expectInvariantError(
        () => assertConnectedRunInvariants(candidate as unknown as ConnectedWorkflowRun),
        label
      );
    }
  });

  it('defeats the ES2015 Object.isFrozen(null|undefined|primitive) trap on every frozen field', () => {
    const base = started();
    const malformedCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['graph: null', { ...base, graph: null }],
      ['graph: primitive', { ...base, graph: 'frozen-primitive' }],
      ['graph: frozen array', { ...base, graph: Object.freeze([]) }],
      ['graph: empty frozen obj', { ...base, graph: Object.freeze({}) }],
      ['graph.nodes: null', { ...base, graph: Object.freeze({ nodes: null, connections: [] }) }],
      ['graph.nodes: [null]', { ...base, graph: Object.freeze({ nodes: [null], connections: [] }) }],
      ['graph.nodes: [{}]', { ...base, graph: Object.freeze({ nodes: [{}], connections: [] }) }],
      ['graph.connections: null', { ...base, graph: Object.freeze({ nodes: [{ nodeId: 'n-triage' }], connections: null }) }],
      ['graph.connections: [null]', { ...base, graph: Object.freeze({ nodes: [{ nodeId: 'n-triage' }], connections: [null] }) }],
      ['pipelines: null', { ...base, pipelines: null }],
      ['pipelines: primitive', { ...base, pipelines: 7 }],
      ['pipelines: frozen array', { ...base, pipelines: Object.freeze([]) }],
      ['pipelines entry null', { ...base, pipelines: Object.freeze({ p: null }) }],
      ['pipelines entry bad phases', { ...base, pipelines: Object.freeze({ p: Object.freeze({ id: 'p', phases: null }) }) }],
      ['frozenClosure: null', { ...base, frozenClosure: null }],
      ['frozenClosure: primitive', { ...base, frozenClosure: 'bad' }],
      ['frozenClosure: frozen array', { ...base, frozenClosure: Object.freeze([]) }],
      ['frozenClosure.workflowsById: null', { ...base, frozenClosure: Object.freeze({ workflowsById: null, phasesById: Object.freeze({}) }) }],
      ['frozenClosure.phasesById: null', { ...base, frozenClosure: Object.freeze({ workflowsById: Object.freeze({}), phasesById: null }) }],
      ['frozenClosure.workflowsById entry null', { ...base, frozenClosure: Object.freeze({ workflowsById: Object.freeze({ w: null }), phasesById: Object.freeze({}) }) }],
      ['invocations: null', { ...base, invocations: null }],
      ['invocations: frozen array', { ...base, invocations: Object.freeze([]) }],
      ['invocations frame null', { ...base, invocations: Object.freeze({ root: null }) }],
      [
        'invocations frame attemptsByNodeId null',
        {
          ...base,
          invocations: Object.freeze({
            root: Object.freeze({
              invocationId: 'root',
              parentInvocationId: null,
              status: 'in-flight',
              startedAt: 1,
              attemptsByNodeId: null
            })
          })
        }
      ],
      [
        'invocations frame attempts list null',
        {
          ...base,
          invocations: Object.freeze({
            root: Object.freeze({
              invocationId: 'root',
              parentInvocationId: null,
              status: 'in-flight',
              startedAt: 1,
              attemptsByNodeId: Object.freeze({ 'n-triage': null })
            })
          })
        }
      ],
      [
        'invocations frame attempt element null',
        {
          ...base,
          invocations: Object.freeze({
            root: Object.freeze({
              invocationId: 'root',
              parentInvocationId: null,
              status: 'in-flight',
              startedAt: 1,
              attemptsByNodeId: Object.freeze({ 'n-triage': Object.freeze([null]) })
            })
          })
        }
      ],
      [
        'invocations frame controlMarkers null',
        {
          ...base,
          invocations: Object.freeze({
            root: Object.freeze({
              invocationId: 'root',
              parentInvocationId: null,
              status: 'in-flight',
              startedAt: 1,
              controlMarkers: null,
              attemptsByNodeId: Object.freeze({})
            })
          })
        }
      ],
      ['inputEnvelopes: null', { ...base, inputEnvelopes: null }],
      ['inputEnvelopes: frozen object', { ...base, inputEnvelopes: Object.freeze({}) }],
      ['inputEnvelopes: [null]', { ...base, inputEnvelopes: Object.freeze([null]) }],
      ['launchContext: null', { ...base, launchContext: null }],
      ['launchContext: frozen array', { ...base, launchContext: Object.freeze([]) }],
      ['launchContext: bad arrays', { ...base, launchContext: Object.freeze({ supplemental: null, outputs: [] }) }],
      ['pendingHandoff: primitive', { ...base, pendingHandoff: 'bad' }],
      ['pendingHandoff: array', { ...base, pendingHandoff: [] }],
      ['recoveryDisposition: primitive', { ...base, recoveryDisposition: 99 }],
      ['commandReceipts: null', { ...base, commandReceipts: null }],
      ['commandReceipts: frozen object', { ...base, commandReceipts: Object.freeze({}) }],
      ['commandReceipts: [null]', { ...base, commandReceipts: Object.freeze([null]) }],
      ['decisionObservations: null', { ...base, decisionObservations: null }],
      ['decisionObservations: frozen object', { ...base, decisionObservations: Object.freeze({}) }],
      ['decisionObservations: [null]', { ...base, decisionObservations: Object.freeze([null]) }],
      ['controlState: null', { ...base, controlState: null }],
      ['controlState: frozen array', { ...base, controlState: Object.freeze([]) }]
    ];
    for (const [label, candidate] of malformedCases) {
      expectInvariantError(
        () => assertConnectedRunInvariants(candidate as unknown as ConnectedWorkflowRun),
        label
      );
    }
  });

  it('rejects malformed nodes, attempts, decisions, operands, and controlMarkers without TypeError', () => {
    const base = started();
    const malformedCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['nodes: null', { ...base, nodes: null }],
      ['nodes: array', { ...base, nodes: [] }],
      ['nodes record null', { ...base, nodes: { 'n-triage': null } }],
      ['nodes attempts null', { ...base, nodes: { 'n-triage': { nodeId: 'n-triage', attempts: null } } }],
      ['nodes attempts [null]', { ...base, nodes: { 'n-triage': { nodeId: 'n-triage', attempts: [null] } } }],
      ['nodes attempt bad queueItemId', { ...base, nodes: { 'n-triage': { nodeId: 'n-triage', attempts: [{ queueItemId: 42, startedAt: 1 }] } } }],
      ['decisions: null', { ...base, decisions: null }],
      ['decisions: object', { ...base, decisions: {} }],
      ['decisions: [null]', { ...base, decisions: [null] }],
      ['decision attemptIndex NaN', { ...base, decisions: [decision({ attemptIndex: Number.NaN })] }],
      ['decision prototype nodeId', { ...base, decisions: [decision({ nodeId: 'toString' })] }],
      ['decision connections null', { ...base, decisions: [{ ...decision(), connections: null }] }],
      ['decision connections [null]', { ...base, decisions: [{ ...decision(), connections: [null] }] }],
      ['decision eligible null', { ...base, decisions: [{ ...decision(), eligible: null }] }],
      ['decision eligible non-number', { ...base, decisions: [{ ...decision(), eligible: ['0'] }] }],
      ['decision operands null', { ...base, decisions: [{ ...decision(), operands: null }] }],
      ['decision operands [null]', { ...base, decisions: [{ ...decision(), operands: [null] }] }],
      [
        'decision operand compared null',
        {
          ...base,
          decisions: [
            {
              ...decision(),
              operands: [{ source: 'node-output', nodeId: 'n-triage', resolved: true, compared: null }]
            }
          ]
        }
      ],
      [
        'decision operand compared number',
        {
          ...base,
          decisions: [
            {
              ...decision(),
              operands: [{ source: 'node-output', nodeId: 'n-triage', resolved: true, compared: 123 }]
            }
          ]
        }
      ]
    ];
    for (const [label, candidate] of malformedCases) {
      expectInvariantError(
        () => assertConnectedRunInvariants(candidate as unknown as ConnectedWorkflowRun),
        label
      );
    }

    expectInvariantError(
      () => assertInvocationControlMarkers(null as unknown as WorkflowInvocationFrame),
      'assertInvocationControlMarkers(null)'
    );
    expectInvariantError(
      () =>
        assertInvocationControlMarkers({
          invocationId: 'inv-1',
          controlMarkers: null
        } as unknown as WorkflowInvocationFrame),
      'assertInvocationControlMarkers(controlMarkers: null)'
    );
  });

  it('defends against prototype pollution in deepCopy and rejects dangerous keys, malformed graph/handoff/frame shapes, cycles, and excessive sizes', () => {
    const base = started();
    const validFrame = createInvocationFrame({
      invocationId: 'inv-root',
      rootRunId: base.connectedRunId,
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: base.workflowId,
      depth: 0,
      nodePath: '/n-triage',
      entryNodeId: 'n-triage',
      boundInputs: {},
      startedAt: 1_000
    });

    // deepCopy must use setOwnProp and never mutate Object.prototype even when fed a JSON-parsed __proto__ key.
    const pollutedBoundInputs = JSON.parse('{"__proto__":{"pollutedFromDeepCopy":true}}') as Record<
      string,
      { readonly portId: string; readonly type: 'text'; readonly value: string }
    >;
    const frameWithProtoInput = createInvocationFrame({
      invocationId: 'inv-proto',
      rootRunId: 'cr-1',
      parentInvocationId: null,
      parentCallNodeId: null,
      parentAttemptId: null,
      workflowId: 'wf-triage',
      depth: 0,
      nodePath: '/n-triage',
      entryNodeId: 'n-triage',
      boundInputs: pollutedBoundInputs,
      startedAt: 1_000
    });
    expect(({} as { pollutedFromDeepCopy?: boolean }).pollutedFromDeepCopy).toBeUndefined();
    expect(Object.getPrototypeOf(frameWithProtoInput.boundInputs)).toBe(Object.prototype);
    expect(Object.hasOwn(frameWithProtoInput.boundInputs, '__proto__')).toBe(true);
    // And invariants reject the dangerous key on the aggregate.
    expectInvariantError(
      () =>
        assertConnectedRunInvariants({
          ...base,
          invocations: Object.freeze({ 'inv-proto': frameWithProtoInput })
        }),
      'frame boundInputs __proto__'
    );

    // Valid return connection with empty to.nodeId is accepted.
    const withReturnGraph = createConnectedRun({
      connectedRunId: 'cr-return-ok',
      workflowId: 'wf-triage',
      graph: {
        ...graph(),
        connections: [{ from: { nodeId: 'n-triage' }, to: { nodeId: '', kind: 'return' } }]
      },
      pipelines: pipelines(),
      startedAt: 1_000
    });
    expect(withReturnGraph.graph.connections).toHaveLength(1);

    const malformedCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['connectedRunId constructor', { ...base, connectedRunId: 'constructor' }],
      ['workflowId prototype', { ...base, workflowId: 'prototype' }],
      ['queueId __proto__', { ...base, queueId: '__proto__' }],
      [
        'missing graph.startNodeIds',
        {
          ...base,
          graph: Object.freeze({
            workflowId: 'wf-triage',
            name: 'Triage',
            version: 1,
            nodes: Object.freeze([{ nodeId: 'n-triage', pipelineId: 'p-triage' }]),
            connections: Object.freeze([])
          })
        }
      ],
      [
        'graph.startNodeIds contains empty string',
        {
          ...base,
          graph: Object.freeze({
            ...graph(),
            startNodeIds: Object.freeze([''])
          })
        }
      ],
      [
        'graph.connections[0] missing to',
        {
          ...base,
          graph: Object.freeze({
            ...graph(),
            connections: Object.freeze([Object.freeze({})])
          })
        }
      ],
      [
        'graph.connections[0] empty to.nodeId on node endpoint',
        {
          ...base,
          graph: Object.freeze({
            ...graph(),
            connections: Object.freeze([Object.freeze({ from: { nodeId: 'n-triage' }, to: { nodeId: '' } })])
          })
        }
      ],
      ['pendingHandoff empty object', { ...base, pendingHandoff: Object.freeze({}) }],
      [
        'pendingHandoff missing target',
        {
          ...base,
          pendingHandoff: Object.freeze({
            invocationId: 'inv-root',
            fromNodeId: 'n-triage',
            fromAttemptId: 'att-1',
            connectionIndex: 0,
            prefilledInputsByPort: Object.freeze({}),
            pausedAt: 10
          })
        }
      ],
      [
        'frame pendingHandoff empty object',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': Object.freeze({ ...validFrame, pendingHandoff: Object.freeze({}) })
          })
        }
      ],
      [
        'frame missing resolvedOutputs',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': Object.freeze({
              invocationId: 'inv-root',
              rootRunId: base.connectedRunId,
              parentInvocationId: null,
              workflowId: base.workflowId,
              depth: 0,
              nodePath: '/n-triage',
              entryNodeId: 'n-triage',
              status: 'in-flight',
              attemptsByNodeId: Object.freeze({}),
              startedAt: 1_000
            })
          })
        }
      ],
      [
        'frame negative depth',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': Object.freeze({ ...validFrame, depth: -1 })
          })
        }
      ],
      [
        'invocations duplicate root frames',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root-1': Object.freeze({ ...validFrame, invocationId: 'inv-root-1' }),
            'inv-root-2': Object.freeze({ ...validFrame, invocationId: 'inv-root-2' })
          })
        }
      ],
      [
        'invocations missing parentInvocationId target',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': validFrame,
            'inv-child': Object.freeze({
              ...validFrame,
              invocationId: 'inv-child',
              parentInvocationId: 'inv-missing',
              depth: 1
            })
          })
        }
      ],
      [
        'invocations cyclic parentInvocationId',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': validFrame,
            'inv-a': Object.freeze({ ...validFrame, invocationId: 'inv-a', parentInvocationId: 'inv-b', depth: 1 }),
            'inv-b': Object.freeze({ ...validFrame, invocationId: 'inv-b', parentInvocationId: 'inv-a', depth: 2 })
          })
        }
      ],
      [
        'graph.nodes exceeds upper bound',
        {
          ...base,
          graph: Object.freeze({
            ...graph(),
            nodes: Object.freeze(
              Array.from({ length: 513 }, (_, idx) => Object.freeze({ nodeId: `n-${idx}`, pipelineId: 'p-triage' }))
            )
          })
        }
      ],
      [
        'frozenClosure workflow nodes contains null element',
        {
          ...base,
          frozenClosure: Object.freeze({
            workflowsById: Object.freeze({
              'wf-triage': Object.freeze({
                workflowId: 'wf-triage',
                nodes: Object.freeze([null]),
                connections: Object.freeze([])
              })
            }),
            phasesById: Object.freeze({})
          })
        }
      ],
      [
        'frozenClosure catalogVersionsById entry is null',
        {
          ...base,
          frozenClosure: Object.freeze({
            workflowsById: Object.freeze({}),
            phasesById: Object.freeze({}),
            catalogVersionsById: Object.freeze({ 'wf-triage': null })
          })
        }
      ],
      [
        'invocation attempt declaredOutputs is null',
        {
          ...base,
          invocations: Object.freeze({
            'inv-root': Object.freeze({
              ...validFrame,
              attemptsByNodeId: Object.freeze({
                'n-triage': Object.freeze([
                  Object.freeze({
                    attemptId: 'att-1',
                    nodeId: 'n-triage',
                    nodeKind: 'phase',
                    attemptIndex: 1,
                    status: 'completed',
                    startedAt: 1_000,
                    declaredOutputs: null
                  })
                ])
              })
            })
          })
        }
      ],
      [
        'inputEnvelopes inputsByPort is null',
        {
          ...base,
          inputEnvelopes: Object.freeze([
            Object.freeze({
              envelopeId: 'env-1',
              invocationId: 'inv-root',
              targetNodeId: 'n-triage',
              acceptedAt: 1_000,
              inputsByPort: null
            })
          ])
        }
      ],
      [
        'empty laneId string',
        {
          ...base,
          laneId: ''
        }
      ]
    ];

    for (const [label, candidate] of malformedCases) {
      expectInvariantError(
        () => assertConnectedRunInvariants(candidate as unknown as ConnectedWorkflowRun),
        label
      );
    }
  });
});
