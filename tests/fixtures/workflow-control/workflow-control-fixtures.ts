// FR-R5-F35 (F35-T02) — Reusable local end-to-end fixtures for workflow control acceptance.
// Provides controlled CLI process execution, multi-mechanism Workflow closures
// (standalone Phase repetition + CandidateBlock + Repeat + ForEach), injectable virtual
// clocks, and remote network isolation guards.

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Memento } from '../../../src/state/workspace-state';
import type { ExecutionFence } from '../../../src/contracts/control-ledger';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';

export type ControlledCliMode =
  | 'success'
  | 'incomplete'
  | 'credit-limited'
  | 'malformed'
  | 'failed-start'
  | 'uncertain-spawn';

export interface ControlledCliRunInput {
  readonly mode: ControlledCliMode;
  readonly cwd: string;
  readonly outputRelativePath?: string | undefined;
  readonly sideEffectRelativePath?: string | undefined;
  readonly resultJson?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly remoteUrlAttempt?: string | undefined;
}

export interface ControlledCliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputFilePath?: string | undefined;
}

const CLI_SCRIPT_PATH = path.resolve(__dirname, 'controlled-cli-runner.cjs');

export async function runControlledCliFixture(
  input: ControlledCliRunInput
): Promise<ControlledCliRunResult> {
  const outputFilePath =
    input.outputRelativePath !== undefined
      ? path.join(input.cwd, input.outputRelativePath)
      : undefined;
  const sideEffectPath =
    input.sideEffectRelativePath !== undefined
      ? path.join(input.cwd, input.sideEffectRelativePath)
      : undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_SCRIPT_PATH], {
      cwd: input.cwd,
      env: {
        ...process.env,
        SCHEGENT_FIXTURE_MODE: input.mode,
        ...(outputFilePath !== undefined ? { SCHEGENT_FIXTURE_OUTPUT_PATH: outputFilePath } : {}),
        ...(sideEffectPath !== undefined
          ? { SCHEGENT_FIXTURE_SIDE_EFFECT_PATH: sideEffectPath }
          : {}),
        ...(input.resultJson !== undefined
          ? { SCHEGENT_FIXTURE_RESULT_JSON: JSON.stringify(input.resultJson) }
          : {}),
        ...(input.remoteUrlAttempt !== undefined
          ? { SCHEGENT_FIXTURE_REMOTE_URL: input.remoteUrlAttempt }
          : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(outputFilePath !== undefined ? { outputFilePath } : {})
      });
    });
  });
}

export function createFixtureMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

export interface InjectableControlClock {
  readonly nowWallMs: () => number;
  readonly nowMonotonicMs: () => number;
  readonly hostEpoch: string;
  readonly advance: (deltaMs: number) => void;
  readonly shiftWallOnly: (deltaMs: number) => void;
  readonly restartHost: (newEpoch: string, sleepMs?: number) => void;
}

export function createInjectableControlClock(initialWallMs = 1_700_000_000_000): InjectableControlClock {
  let wallMs = initialWallMs;
  let monoMs = 10_000;
  let epoch = 'epoch-fixture-1';
  return {
    nowWallMs: () => wallMs,
    nowMonotonicMs: () => monoMs,
    get hostEpoch() {
      return epoch;
    },
    advance(deltaMs: number) {
      wallMs += deltaMs;
      monoMs += deltaMs;
    },
    shiftWallOnly(deltaMs: number) {
      wallMs += deltaMs;
    },
    restartHost(newEpoch: string, sleepMs = 0) {
      epoch = newEpoch;
      wallMs += sleepMs;
      monoMs = 1_000;
    }
  };
}

export function makeFixtureFence(rootGeneration = 1, suffix = '1'): ExecutionFence {
  return Object.freeze({
    primacyClaim: `primacy-accept-${suffix}`,
    queueClaim: `queue-accept-${suffix}`,
    rootGeneration
  });
}

export async function readSampleItemsFixtureText(): Promise<string> {
  return fsp.readFile(path.resolve(__dirname, 'sample-items.json'), 'utf8');
}

export interface IntegratedControlFlowDefinitions {
  readonly phases: readonly PhaseDefinition[];
  readonly childCandidateWorkflow: WorkflowDefinition;
  readonly childRepeatWorkflow: WorkflowDefinition;
  readonly childForEachItemWorkflow: WorkflowDefinition;
  readonly rootWorkflow: WorkflowDefinition;
}

export function buildIntegratedControlFlowDefinitions(): IntegratedControlFlowDefinitions {
  const phaseStandaloneLoop: PhaseDefinition = {
    phaseId: 'phase-standalone-prep',
    name: 'Standalone Prep Loop Phase',
    version: 1,
    runner: 'claude',
    instruction: 'Run preparation pass until pending_tasks equals 0',
    loopable: true,
    onRetryCap: 'fail',
    resultContract: {
      version: 1,
      operator: 'structured-result',
      operatorVersion: 1,
      source: { kind: 'declared-output', outputKey: 'prepReport' },
      fields: [
        { fieldId: 'pending_tasks', type: 'number', required: true, selector: ['pending_tasks'] },
        { fieldId: 'prep_ready', type: 'boolean', required: true, selector: ['prep_ready'] }
      ],
      completion: {
        version: 1,
        kind: 'typed',
        test: {
          left: { source: 'result-field', fieldId: 'pending_tasks' },
          operator: 'equals',
          right: 0
        }
      }
    }
  };

  const phaseCandClaude: PhaseDefinition = {
    phaseId: 'phase-cand-claude',
    name: 'Claude Candidate Review',
    version: 1,
    runner: 'claude',
    instruction: '/review --strict --output-json'
  };

  const phaseCandCodex: PhaseDefinition = {
    phaseId: 'phase-cand-codex',
    name: 'Codex Candidate Review',
    version: 1,
    runner: 'codex',
    instruction: 'codex-review --structured-findings'
  };

  const phaseCandAgy: PhaseDefinition = {
    phaseId: 'phase-cand-agy',
    name: 'Agy Candidate Review',
    version: 1,
    runner: 'agy',
    instruction: 'agy-audit --emit-verdict'
  };

  const phaseRepeatStep: PhaseDefinition = {
    phaseId: 'phase-repeat-refine',
    name: 'Repeat Refinement Step',
    version: 1,
    runner: 'claude',
    instruction: 'Refine architecture draft and emit approval score'
  };

  const phaseForEachStep: PhaseDefinition = {
    phaseId: 'phase-foreach-module',
    name: 'ForEach Module Processor',
    version: 1,
    runner: 'codex',
    instruction: 'Validate single module item JSON payload'
  };

  const childCandidateWorkflow: WorkflowDefinition = {
    workflowId: 'wf-child-candidate-review',
    name: 'Candidate Review Block Workflow',
    version: 1,
    inputs: [{ portId: 'prepContext', label: 'Prep Context', type: 'text', required: false }],
    outputs: [{ portId: 'candidateVerdict', label: 'Candidate Verdict', type: 'markdown', required: true }],
    bindings: [
      {
        kind: 'output',
        portId: 'candidateVerdict',
        nodeId: 'node-cand-codex',
        outputKey: 'verdictDoc',
        type: 'markdown'
      }
    ],
    nodes: [
      { nodeId: 'node-cand-claude', kind: 'phase', phaseId: phaseCandClaude.phaseId },
      { nodeId: 'node-cand-codex', kind: 'phase', phaseId: phaseCandCodex.phaseId },
      { nodeId: 'node-cand-agy', kind: 'phase', phaseId: phaseCandAgy.phaseId }
    ],
    connections: [
      {
        from: { nodeId: 'node-cand-claude' },
        to: { kind: 'node', nodeId: 'node-cand-codex' },
        priority: 1,
        handoff: 'auto',
        condition: {
          left: { source: 'node-status', nodeId: 'node-cand-claude' },
          operator: 'equals',
          right: 'failed'
        }
      },
      {
        from: { nodeId: 'node-cand-codex' },
        to: { kind: 'return', nodeId: 'node-cand-codex' },
        priority: 1,
        handoff: 'auto'
      }
    ],
    startNodeIds: ['node-cand-claude'],
    control: {
      version: 1,
      kind: 'candidate-block',
      availabilityPolicy: 'first-ready',
      candidates: [
        { candidateId: 'cand-claude', nodeId: 'node-cand-claude', priority: 1, maxAttempts: 2 },
        { candidateId: 'cand-codex', nodeId: 'node-cand-codex', priority: 2, maxAttempts: 2 },
        { candidateId: 'cand-agy', nodeId: 'node-cand-agy', priority: 3, maxAttempts: 1 }
      ]
    }
  };

  const childRepeatWorkflow: WorkflowDefinition = {
    workflowId: 'wf-child-repeat-refine',
    name: 'Scoped Repeat Refinement Workflow',
    version: 1,
    inputs: [
      { portId: 'feedback', label: 'Feedback', type: 'text', required: true },
      { portId: 'priorScore', label: 'Prior Score', type: 'text', required: false }
    ],
    outputs: [
      { portId: 'refinedSpec', label: 'Refined Spec', type: 'markdown', required: true }
    ],
    bindings: [
      {
        kind: 'input',
        nodeId: 'node-repeat-leaf',
        inputKey: 'feedback',
        type: 'text',
        required: true,
        source: { from: 'workflow-input', portId: 'feedback' }
      },
      {
        kind: 'output',
        nodeId: 'node-repeat-leaf',
        portId: 'refinedSpec',
        outputKey: 'specDoc',
        type: 'markdown'
      }
    ],
    nodes: [{ nodeId: 'node-repeat-leaf', kind: 'phase', phaseId: phaseRepeatStep.phaseId }],
    connections: [],
    startNodeIds: ['node-repeat-leaf'],
    decisionResults: {
      version: 1,
      fields: [
        { fieldId: 'approved', type: 'boolean', required: true },
        { fieldId: 'score', type: 'number', required: true },
        { fieldId: 'nextFeedback', type: 'string', required: false }
      ],
      bindings: [
        {
          fieldId: 'approved',
          source: { kind: 'node-result', nodeId: 'node-repeat-leaf', fieldId: 'approved' }
        },
        {
          fieldId: 'score',
          source: { kind: 'node-result', nodeId: 'node-repeat-leaf', fieldId: 'score' }
        },
        {
          fieldId: 'nextFeedback',
          source: { kind: 'node-result', nodeId: 'node-repeat-leaf', fieldId: 'nextFeedback' }
        }
      ]
    }
  };

  const childForEachItemWorkflow: WorkflowDefinition = {
    workflowId: 'wf-child-foreach-item',
    name: 'Sequential ForEach Item Workflow',
    version: 1,
    inputs: [{ portId: 'itemPayload', label: 'Item Payload', type: 'text', required: true }],
    outputs: [{ portId: 'moduleReport', label: 'Module Report', type: 'markdown', required: false }],
    nodes: [{ nodeId: 'node-foreach-leaf', kind: 'phase', phaseId: phaseForEachStep.phaseId }],
    connections: [],
    startNodeIds: ['node-foreach-leaf']
  };

  const rootWorkflow: WorkflowDefinition = {
    workflowId: 'wf-root-integrated-control',
    name: 'Integrated Control Flow Root Workflow',
    version: 1,
    inputs: [
      { portId: 'initialFeedback', label: 'Initial Feedback', type: 'text', required: true },
      { portId: 'itemsCollection', label: 'Items Collection', type: 'local-file', required: true }
    ],
    outputs: [
      { portId: 'finalRefinedSpec', label: 'Final Refined Spec', type: 'markdown', required: true },
      { portId: 'batchResultIndex', label: 'Batch Result Index', type: 'structured-data', required: true }
    ],
    bindings: [
      {
        kind: 'input',
        nodeId: 'node-stage3-repeat',
        inputKey: 'feedback',
        type: 'text',
        required: true,
        source: { from: 'workflow-input', portId: 'initialFeedback' }
      },
      {
        kind: 'output',
        nodeId: 'node-stage3-repeat',
        portId: 'finalRefinedSpec',
        outputKey: 'refinedSpec',
        type: 'markdown'
      },
      {
        kind: 'output',
        nodeId: 'node-stage4-foreach',
        portId: 'batchResultIndex',
        outputKey: 'resultIndex',
        type: 'structured-data'
      }
    ],
    nodes: [
      {
        nodeId: 'node-stage1-prep',
        kind: 'phase',
        phaseId: phaseStandaloneLoop.phaseId
      },
      {
        nodeId: 'node-stage2-candidates',
        kind: 'workflow',
        workflowId: childCandidateWorkflow.workflowId
      },
      {
        nodeId: 'node-stage3-repeat',
        kind: 'workflow',
        workflowId: childRepeatWorkflow.workflowId,
        control: {
          version: 1,
          kind: 'repeat',
          maxIterations: 3,
          until: {
            version: 1,
            kind: 'typed',
            test: {
              left: { source: 'result-field', fieldId: 'approved' },
              operator: 'equals',
              right: true
            }
          },
          carry: [
            { fieldId: 'nextFeedback', inputPortId: 'feedback' },
            { fieldId: 'score', inputPortId: 'priorScore' }
          ],
          onExhausted: 'pause'
        }
      },
      {
        nodeId: 'node-stage4-foreach',
        kind: 'workflow',
        workflowId: childForEachItemWorkflow.workflowId,
        control: {
          version: 1,
          kind: 'for-each',
          collection: {
            source: 'workflow-input',
            portId: 'itemsCollection'
          },
          itemKeyField: 'id',
          itemInputPortId: 'itemPayload',
          maxItems: 50,
          onItemError: 'continue'
        }
      }
    ],
    connections: [
      {
        from: { nodeId: 'node-stage1-prep' },
        to: { kind: 'node', nodeId: 'node-stage2-candidates' },
        priority: 1,
        handoff: 'auto'
      },
      {
        from: { nodeId: 'node-stage2-candidates' },
        to: { kind: 'node', nodeId: 'node-stage3-repeat' },
        priority: 1,
        handoff: 'auto'
      },
      {
        from: { nodeId: 'node-stage3-repeat' },
        to: { kind: 'node', nodeId: 'node-stage4-foreach' },
        priority: 1,
        handoff: 'auto'
      },
      {
        from: { nodeId: 'node-stage4-foreach' },
        to: { kind: 'return', nodeId: 'node-stage4-foreach' },
        priority: 1,
        handoff: 'auto'
      }
    ],
    startNodeIds: ['node-stage1-prep']
  };

  return {
    phases: [
      phaseStandaloneLoop,
      phaseCandClaude,
      phaseCandCodex,
      phaseCandAgy,
      phaseRepeatStep,
      phaseForEachStep
    ],
    childCandidateWorkflow,
    childRepeatWorkflow,
    childForEachItemWorkflow,
    rootWorkflow
  };
}
