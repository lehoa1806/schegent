/**
 * FR-R8-01 — Cohesive helper functions factored out of
 * `production-workflow-composition.ts` so the composition root remains concise
 * and under the 1,000-line size-gate entry condition. Zero `vscode` imports.
 */

import type { ControlLedgerErrorCode } from '../../contracts/control-ledger';
import type { DecisionFieldValue, ResultContract } from '../../contracts/decision-results';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';
import {
  DEFAULT_ROOT_MAX_PHASE_ATTEMPTS,
  WORKFLOW_CONTROL_SCHEMA_VERSION,
  type RootControlBudget
} from '../../contracts/workflow-controls';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';
import type { Memento } from '../../state/workspace-state';
import type {
  CanonicalBackendDiagnosticInput,
  HostControlReason,
  ResultOperator
} from '../result-operator';
import type { ControlLedgerBackingStore } from './control-ledger-store';
import {
  createWorkflowRefusalOutcome,
  type WorkflowRefusalOutcome
} from './entry-point-wiring-census';

export interface SettlementEvaluationInput {
  readonly attemptId: string;
  readonly workspaceRoot: string;
  readonly status: WorkflowNodeTerminalStatus;
  readonly phase?: PhaseDefinition | undefined;
  readonly resultContract?: ResultContract | undefined;
  readonly runOutputs?: readonly RunOutputRecord[] | undefined;
  readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>> | undefined;
  readonly backendResultText?: string | undefined;
  readonly diagnosticRecordsText?: string | undefined;
  readonly backendDiagnostic?: CanonicalBackendDiagnosticInput | undefined;
  readonly conflictingBackendDiagnostic?: CanonicalBackendDiagnosticInput | undefined;
  readonly hostControl?: HostControlReason | undefined;
  readonly evaluatedAt?: number | undefined;
  readonly failureCode?: string | undefined;
}

export interface SettlementEvaluationResult {
  readonly status: WorkflowNodeTerminalStatus;
  readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly verdict?: 'pass' | 'fail' | null | undefined;
  readonly failureCode?: string | undefined;
  readonly refusal?: WorkflowRefusalOutcome | undefined;
}

export type EnsureRootControlLinkFailure = {
  readonly ok: false;
  readonly code: ControlLedgerErrorCode;
  readonly message: string;
  readonly refusal: WorkflowRefusalOutcome;
};

export function createInMemoryMemento(): Memento {
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

export function isControlLedgerBackingStore(
  candidate: unknown
): candidate is ControlLedgerBackingStore {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const obj = candidate as Record<string, unknown>;
  return (
    (typeof obj.getRawControlLedger === 'function' &&
      typeof obj.transactControlLedger === 'function') ||
    (typeof obj.get === 'function' && typeof obj.update === 'function')
  );
}

export function buildDeclaredOutputsFromRunOutputs(
  outputs: readonly RunOutputRecord[] | undefined
): Readonly<Record<string, ResolvedPortValue>> {
  if (outputs === undefined || outputs.length === 0) return Object.freeze({});
  const byPort: Record<string, ResolvedPortValue> = {};
  for (const entry of outputs) {
    if (entry.status !== 'resolved' || entry.reference === undefined) continue;
    byPort[entry.name] = Object.freeze({
      portId: entry.name,
      type: 'local-file',
      value: entry.reference
    });
  }
  return Object.freeze(byPort);
}

export function buildRootControlBudget(run: ConnectedWorkflowRun): RootControlBudget {
  const frozenBudget = run.frozenClosure?.rootBudget;
  if (frozenBudget?.mode === 'strict-usd') {
    return Object.freeze({
      version: WORKFLOW_CONTROL_SCHEMA_VERSION,
      maxPhaseAttempts: DEFAULT_ROOT_MAX_PHASE_ATTEMPTS,
      strictUsdBudget: Object.freeze({
        mode: 'strict-usd' as const,
        limitMicrousd: frozenBudget.limitMicrousd
      }),
      budgetMode: 'strict-usd' as const,
      maxMicrousd: frozenBudget.limitMicrousd
    });
  }
  return Object.freeze({
    version: WORKFLOW_CONTROL_SCHEMA_VERSION,
    maxPhaseAttempts: DEFAULT_ROOT_MAX_PHASE_ATTEMPTS,
    budgetMode: 'count-only' as const
  });
}

export function toRootLinkFailure(
  code: ControlLedgerErrorCode,
  message: string,
  rootExecutionId: string,
  invocationId: string
): EnsureRootControlLinkFailure {
  const category =
    code === 'control-root-limit-exceeded'
      ? 'budget-exceeded'
      : code === 'stale-execution-fence'
        ? 'stale-fence'
        : 'corrupt-state';
  return {
    ok: false,
    code,
    message,
    refusal: createWorkflowRefusalOutcome({
      category,
      reasonCode: code,
      message,
      rootExecutionId,
      invocationId,
      attemptsConsumed: 0
    })
  };
}

export async function evaluateWorkflowSettlementOutcome(
  resultOperator: ResultOperator,
  isResultOperatorSupplied: boolean,
  input: SettlementEvaluationInput
): Promise<SettlementEvaluationResult> {
  const declaredOutputs =
    input.declaredOutputs ?? buildDeclaredOutputsFromRunOutputs(input.runOutputs);
  const contract = input.resultContract ?? input.phase?.resultContract;

  if (!isResultOperatorSupplied && contract !== undefined) {
    const refusal = createWorkflowRefusalOutcome({
      category: 'missing-collaborator',
      reasonCode: 'collaborator-absent:resultOperator',
      message: 'Required collaborator resultOperator is absent at settlement.',
      attemptId: input.attemptId,
      attemptsConsumed: 1
    });
    return Object.freeze({
      status: 'failed',
      declaredOutputs: Object.freeze({}),
      verdict: 'fail',
      failureCode: refusal.reasonCode,
      refusal
    });
  }

  if (contract === undefined) {
    return Object.freeze({
      status: input.status,
      declaredOutputs,
      verdict: input.status === 'completed' ? 'pass' : 'fail',
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {})
    });
  }

  if (
    input.status !== 'completed' &&
    input.backendDiagnostic === undefined &&
    input.backendResultText === undefined &&
    input.diagnosticRecordsText === undefined &&
    input.hostControl === undefined
  ) {
    return Object.freeze({
      status: input.status,
      declaredOutputs: Object.freeze({}),
      verdict: 'fail',
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {})
    });
  }

  const declaredOutputsByKey: Record<string, string> = {};
  for (const [key, portVal] of Object.entries(declaredOutputs)) {
    if (typeof portVal.value === 'string') declaredOutputsByKey[key] = portVal.value;
  }

  const evaluated = await resultOperator.evaluateWithPrecedence({
    attemptId: input.attemptId,
    workspaceRoot: input.workspaceRoot,
    resultContract: contract,
    declaredOutputsByKey,
    ...(input.backendResultText !== undefined ? { backendResultText: input.backendResultText } : {}),
    ...(input.diagnosticRecordsText !== undefined
      ? { diagnosticRecordsText: input.diagnosticRecordsText }
      : {}),
    ...(input.backendDiagnostic !== undefined ? { backendDiagnostic: input.backendDiagnostic } : {}),
    ...(input.conflictingBackendDiagnostic !== undefined
      ? { conflictingBackendDiagnostic: input.conflictingBackendDiagnostic }
      : {}),
    ...(input.hostControl !== undefined ? { hostControl: input.hostControl } : {}),
    ...(input.evaluatedAt !== undefined ? { evaluatedAt: input.evaluatedAt } : {})
  });

  if (evaluated.kind === 'host-control') {
    const isCanceled = evaluated.hostControl === 'cancelled';
    return Object.freeze({
      status: isCanceled ? 'canceled' : 'failed',
      declaredOutputs: Object.freeze({}),
      verdict: 'fail',
      failureCode: `host-control:${evaluated.hostControl}`
    });
  }

  const { outcome } = evaluated;
  if (outcome.status === 'done') {
    const rawVerdict = outcome.values.verdict;
    const verdict: 'pass' | 'fail' =
      rawVerdict === 'fail' || rawVerdict === false ? 'fail' : 'pass';
    return Object.freeze({
      status: input.status === 'completed' ? 'completed' : input.status,
      declaredOutputs,
      decisionResults: Object.freeze({ ...outcome.values }),
      verdict
    });
  }

  return Object.freeze({
    status: 'failed',
    declaredOutputs: Object.freeze({}),
    ...(Object.keys(outcome.values).length > 0
      ? { decisionResults: Object.freeze({ ...outcome.values }) }
      : {}),
    verdict: 'fail',
    failureCode: `typed-result-${outcome.status}:${outcome.reason}`
  });
}
