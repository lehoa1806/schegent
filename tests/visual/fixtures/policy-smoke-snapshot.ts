// The policy smoke's snapshot (FR-R4-F08, contract P5).
//
// `actual-policy.visual.spec.ts` mounts the built webview under the policy the
// extension ships, then visits every Builder route that holds an element whose
// style used to be an inline attribute. A route that renders nothing would pass
// a computed-style check by absence, so this snapshot has to make each affected
// element exist: a Phase selectable in form mode, a Pipeline, a Workflow whose
// first node forks (so `WorkflowFlowSubtree` sets `--wf-arms` to a known count),
// and a Model Catalog with at least one model per backend (so every row the
// Models editor renders exists). Since FR-R5-F08 a queue's detail tier mounts
// `QueueInputForm` only when the snapshot carries neither launch catalog, so the
// queue step publishes `policySmokeQueueFallbackSnapshot` instead.
//
// Built from the exports of `workflow-snapshot.ts` without editing that file, so
// the visual suite's screenshots are unaffected. `satisfies WorkflowSnapshot`
// checks the result against the host producer's type, the same way the base
// fixture is checked.

import type { WorkflowSnapshot } from '../../../src/ui/sidebar/snapshot';
import { workflowSnapshot } from './workflow-snapshot';

/** The Workflow the smoke selects; its first node forks into two arms. */
export const POLICY_SMOKE_WORKFLOW_ID = 'policy-smoke-fork';

/** The arms the forking node draws, which `--wf-arms` must equal. */
export const POLICY_SMOKE_BRANCH_COUNT = 2;

/** The Phase the smoke selects in form mode. */
export const POLICY_SMOKE_PHASE_ID = 'speckit-specify';

/** The Pipeline the smoke selects. */
export const POLICY_SMOKE_PIPELINE_ID = 'dev-new-feature';

/** The queue whose detail tier holds `QueueInputForm`. */
export const POLICY_SMOKE_QUEUE_ID = 'default';

/** The base fixture's pending Task, whose Run Detail tier holds the inline edit form behind Edit. */
export const POLICY_SMOKE_PENDING_TASK_ID = 'visual-task-pending';

/** The Builder routes the smoke visits, in order. */
export const POLICY_SMOKE_ROUTES = Object.freeze(['phases', 'workflows', 'models'] as const);

export type PolicySmokeRoute = (typeof POLICY_SMOKE_ROUTES)[number];

const PHASE_DEFINITION = {
  phaseId: POLICY_SMOKE_PHASE_ID,
  name: 'Specify',
  version: 1,
  instruction: 'Define scope and acceptance criteria.',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  timeoutSeconds: 1800,
  loopable: false,
  runner: 'claude'
} as const;

const WORKFLOW_DEFINITION = {
  workflowId: POLICY_SMOKE_WORKFLOW_ID,
  name: 'Policy Smoke Fork',
  description: 'A Workflow whose first node forks into two arms.',
  version: 1,
  nodes: [
    { nodeId: 'triage', kind: 'phase' as const, phaseId: POLICY_SMOKE_PHASE_ID },
    { nodeId: 'fix', kind: 'phase' as const, phaseId: POLICY_SMOKE_PHASE_ID },
    { nodeId: 'ship', kind: 'phase' as const, phaseId: POLICY_SMOKE_PHASE_ID }
  ],
  connections: [
    { from: { nodeId: 'triage' }, to: { nodeId: 'fix' } },
    { from: { nodeId: 'triage' }, to: { nodeId: 'ship' } }
  ],
  startNodeIds: ['triage']
} as const;

/** The base snapshot with a Phase catalog and a Workflow catalog added. */
export const policySmokeSnapshot = {
  ...workflowSnapshot,
  phaseCatalog: {
    state: 'ready',
    records: [
      {
        key: `${POLICY_SMOKE_PHASE_ID}::0`,
        phaseId: POLICY_SMOKE_PHASE_ID,
        status: 'effective',
        definition: PHASE_DEFINITION,
        display: {},
        errors: []
      }
    ],
    effective: [PHASE_DEFINITION],
    revision: 'policy-smoke-phase-revision',
    warnings: []
  },
  workflowCatalog: {
    state: 'ready',
    records: [
      {
        key: `${POLICY_SMOKE_WORKFLOW_ID}::0`,
        workflowId: POLICY_SMOKE_WORKFLOW_ID,
        status: 'effective',
        definition: WORKFLOW_DEFINITION,
        display: {},
        errors: [],
        derivedInputs: [],
        derivedOutputs: []
      }
    ],
    effective: [WORKFLOW_DEFINITION],
    revision: 'policy-smoke-workflow-revision',
    warnings: []
  }
} as const satisfies WorkflowSnapshot;

/**
 * The smoke snapshot without the Workflow catalog. `QueueDetailTier` renders
 * `QueueTaskComposer`, which holds no `<form>`, whenever `launchables` or
 * `workflowCatalog` is present (FR-R5-F08, `ef77d5609`), and `QueueInputForm`
 * otherwise. P-T4 publishes this for its queue step so that form still mounts.
 */
export const policySmokeQueueFallbackSnapshot = {
  ...policySmokeSnapshot,
  workflowCatalog: undefined
} as const satisfies WorkflowSnapshot;
