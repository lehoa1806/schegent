// FR-R8-01 (01-08) — Structural and immutability invariant checks for ConnectedWorkflowRun.
//
// Validates plain-object, array, and primitive shapes before any property dereference or
// `Object.isFrozen` check (avoiding ES2015 `Object.isFrozen(null|undefined|primitive) === true`)
// so malformed persisted records always throw `ConnectedRunInvariantError`, never raw `TypeError`.
//
// Zero `vscode` imports and zero value imports from upper layers (Hard Rule 13 / FR-R7-07).

import { isValidConnectedRunControlLink } from '../contracts/control-ledger';
import { validateExecutionDecisionObservation } from '../contracts/execution-decision-observation';
import { isPlainRecord, isSafeEntityKey } from '../lib/operational-value-helpers';
import type {
  ConnectedNodeRecord,
  ConnectedWorkflowRun,
  WorkflowInvocationFrame
} from './connected-workflow-run';

/**
 * How much of a compared value is recorded (FR-066). Long enough to identify
 * what the comparison saw, short enough that the record cannot become a copy of
 * the document behind an output reference. A longer value is recorded as
 * resolved with `compared` omitted rather than truncated, because a truncated
 * path or sentence still carries content.
 */
export const COMPARED_MAX_LENGTH = 64;

export class ConnectedRunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectedRunInvariantError';
  }
}

/**
 * What a caller can tell the invariants that the record cannot tell them.
 *
 * The queue registry is the one such thing, and it is optional on purpose. The
 * aggregate module holds no registry and must not import one — it is loaded by
 * the migrator, which reads a memento and has no registry to hand. So a caller
 * that HAS the registry gets the containment check, and one that does not gets
 * the shape checks and nothing weaker for either.
 */
export interface ConnectedRunInvariantOptions {
  readonly knownQueueIds?: ReadonlySet<string>;
}

export interface ConnectedRunStructureOptions extends ConnectedRunInvariantOptions {
  /** When true (default), snapshot fields must also be `Object.isFrozen`. */
  readonly requireFrozen?: boolean;
  /** Authoritative command-receipts cap passed from `connected-workflow-run.ts`. */
  readonly maxCommandReceipts: number;
}

const AGGREGATE_KEYS: ReadonlySet<string> = new Set([
  'commandReceipts',
  'connectedRunId',
  'controlState',
  'decisionObservations',
  'decisions',
  'frozenClosure',
  'graph',
  'inputEnvelopes',
  'invocations',
  'laneId',
  'laneRootRef',
  'launchContext',
  'nodes',
  'pendingHandoff',
  'pipelines',
  'queueId',
  'recoveryDisposition',
  'revision',
  'startedAt',
  'workflowId'
]);
const NODE_KEYS: ReadonlySet<string> = new Set(['attempts', 'nodeId']);
const ATTEMPT_KEYS: ReadonlySet<string> = new Set(['queueItemId', 'startedAt']);
const DECISION_KEYS: ReadonlySet<string> = new Set([
  'attemptIndex',
  'connections',
  'decidedAt',
  'defaultApplied',
  'eligible',
  'nodeId',
  'operands'
]);
const OPERAND_KEYS: ReadonlySet<string> = new Set([
  'compared',
  'field',
  'nodeId',
  'resolved',
  'source'
]);
const OUTCOME_KEYS: ReadonlySet<string> = new Set(['index', 'isDefault', 'matched']);
const CONTROL_STATE_KEYS: ReadonlySet<string> = new Set(['version', 'ledgerRunId']);

const VALID_OPERAND_SOURCES: ReadonlySet<string> = new Set([
  'node-output',
  'node-status',
  'node-result',
  'result-field'
]);
const VALID_INVOCATION_STATUSES: ReadonlySet<string> = new Set([
  'in-flight',
  'waiting-for-handoff',
  'paused',
  'completed',
  'failed',
  'canceled'
]);
const VALID_NODE_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  'pending-dispatch',
  'in-flight',
  'paused',
  'completed',
  'failed',
  'canceled'
]);

/** POSIX and Windows absolute forms. Workspace-relative references are the only legal shape. */
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

const MAX_GRAPH_NODES = 512;
const MAX_GRAPH_CONNECTIONS = 2048;
const MAX_NODES = 512;
const MAX_DECISIONS = 512;
const MAX_INVOCATIONS = 512;
const MAX_ATTEMPT_NODES = 512;
const MAX_ATTEMPTS_PER_NODE = 256;
const MAX_INPUT_ENVELOPES = 512;
const MAX_MAP_ENTRIES = 512;

function fail(message: string): never {
  throw new ConnectedRunInvariantError(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Authored workflow nodeIds satisfy `^[a-z][a-z0-9-]{0,63}$`, which legitimately admits
 * `'constructor'` (guarded with `Object.hasOwn` in `attemptsForNode`) but never `'__proto__'`
 * or `'prototype'`.
 */
function isSafeNodeKey(key: string): boolean {
  return key.length > 0 && key !== '__proto__' && key !== 'prototype';
}

function assertSafeKey(value: unknown, what: string): asserts value is string {
  if (!isNonEmptyString(value) || !isSafeEntityKey(value)) {
    fail(`${what} must be a safe non-empty string`);
  }
}

function assertSafeRecordKeys(
  record: Record<string, unknown>,
  what: string,
  maxEntries = MAX_MAP_ENTRIES
): void {
  const keys = Object.keys(record);
  if (keys.length > maxEntries) fail(`${what} exceeds ${maxEntries} entries`);
  for (const key of keys) {
    if (!isSafeEntityKey(key)) fail(`${what} contains unsafe key: ${key}`);
  }
}

function assertPendingHandoff(handoff: unknown, what: string): void {
  if (!isPlainRecord(handoff)) fail(`${what} must be null or a valid handoff object`);
  assertSafeKey(handoff.invocationId, `${what}.invocationId`);
  if (!isNonEmptyString(handoff.fromNodeId)) fail(`${what}.fromNodeId must be a non-empty string`);
  if (!isNonEmptyString(handoff.fromAttemptId)) {
    fail(`${what}.fromAttemptId must be a non-empty string`);
  }
  if (
    typeof handoff.connectionIndex !== 'number' ||
    !Number.isInteger(handoff.connectionIndex) ||
    handoff.connectionIndex < 0
  ) {
    fail(`${what}.connectionIndex must be a non-negative integer`);
  }
  if (!isFiniteNumber(handoff.pausedAt)) fail(`${what}.pausedAt must be a finite number`);
  if (!isPlainRecord(handoff.target)) fail(`${what}.target must be a plain object`);
  if (handoff.target.kind === 'node') {
    if (!isNonEmptyString(handoff.target.nodeId)) {
      fail(`${what}.target.nodeId must be a non-empty string`);
    }
  } else if (handoff.target.kind !== 'return') {
    fail(`${what}.target.kind must be node or return`);
  }
  if (!isPlainRecord(handoff.prefilledInputsByPort)) {
    fail(`${what}.prefilledInputsByPort must be a plain object`);
  }
  assertSafeRecordKeys(handoff.prefilledInputsByPort, `${what}.prefilledInputsByPort`);
}

function isObjectWithFreeze(
  value: unknown,
  requireFrozen: boolean
): value is Record<string, unknown> {
  return isPlainRecord(value) && (!requireFrozen || Object.isFrozen(value));
}

function isArrayWithFreeze(value: unknown, requireFrozen: boolean): value is readonly unknown[] {
  return Array.isArray(value) && (!requireFrozen || Object.isFrozen(value));
}

function assertKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${what} carries an undeclared field: ${key}`);
  }
}

function assertOperand(operand: unknown): void {
  if (!isPlainRecord(operand)) fail('operand resolution must be a plain object');
  assertKeys(operand, OPERAND_KEYS, 'operand resolution');
  if (typeof operand.source !== 'string' || !VALID_OPERAND_SOURCES.has(operand.source)) {
    fail('operand resolution has an invalid source');
  }
  if (!isNonEmptyString(operand.nodeId)) fail('operand resolution nodeId must be a non-empty string');
  if (typeof operand.resolved !== 'boolean') fail('operand resolution resolved must be a boolean');
  if (operand.field !== undefined && typeof operand.field !== 'string') {
    fail('operand resolution field must be a string');
  }
  if (operand.source === 'node-status' && operand.field !== undefined) {
    fail('a node-status operand has no field');
  }
  if (operand.compared === undefined) return;
  if (typeof operand.compared !== 'string') fail('compared value must be a string');
  if (operand.compared.length > COMPARED_MAX_LENGTH) {
    fail(`compared value exceeds ${COMPARED_MAX_LENGTH} characters`);
  }
  if (ABSOLUTE_PATH.test(operand.compared)) fail('compared value looks like an absolute path');
}

function assertDecision(
  decision: unknown,
  nodes: Readonly<Record<string, ConnectedNodeRecord>>,
  connectionCount: number
): void {
  if (!isPlainRecord(decision)) fail('routing decision must be a plain object');
  assertKeys(decision, DECISION_KEYS, 'routing decision');
  if (!isNonEmptyString(decision.nodeId)) fail('routing decision nodeId must be a non-empty string');
  if (!isFiniteNumber(decision.decidedAt)) fail('routing decision decidedAt must be a finite number');
  if (typeof decision.defaultApplied !== 'boolean') {
    fail('routing decision defaultApplied must be a boolean');
  }
  const nodeRecord = Object.hasOwn(nodes, decision.nodeId) ? nodes[decision.nodeId] : undefined;
  const attempts = nodeRecord?.attempts;
  if (attempts === undefined) fail(`decision references an unstarted node: ${decision.nodeId}`);
  if (
    typeof decision.attemptIndex !== 'number' ||
    !Number.isInteger(decision.attemptIndex) ||
    decision.attemptIndex < 0 ||
    decision.attemptIndex >= attempts.length
  ) {
    fail(`decision references attempt ${String(decision.attemptIndex)}, which does not exist`);
  }
  if (!Array.isArray(decision.connections)) fail('routing decision connections must be an array');
  const named = new Set<number>();
  let explicitMatched = false;
  for (const outcome of decision.connections) {
    if (!isPlainRecord(outcome)) fail('connection outcome must be a plain object');
    assertKeys(outcome, OUTCOME_KEYS, 'connection outcome');
    if (
      typeof outcome.index !== 'number' ||
      !Number.isInteger(outcome.index) ||
      outcome.index < 0 ||
      outcome.index >= connectionCount
    ) {
      fail(`decision names connection ${String(outcome.index)}, which the frozen graph does not have`);
    }
    if (typeof outcome.matched !== 'boolean' || typeof outcome.isDefault !== 'boolean') {
      fail('connection outcome matched and isDefault must be booleans');
    }
    named.add(outcome.index);
    if (outcome.matched && !outcome.isDefault) explicitMatched = true;
  }
  if (!Array.isArray(decision.eligible)) fail('routing decision eligible must be an array');
  for (const index of decision.eligible) {
    if (typeof index !== 'number' || !Number.isInteger(index) || !named.has(index)) {
      fail(`eligible connection ${String(index)} has no recorded outcome`);
    }
  }
  // FR-027 reads "only when no explicit condition matched". A decision that
  // records both is not a preference conflict to resolve later — it is two
  // incompatible claims about the same evaluation.
  if (decision.defaultApplied && explicitMatched) {
    fail('defaultApplied is set while an explicit condition matched');
  }
  if (!Array.isArray(decision.operands)) fail('routing decision operands must be an array');
  for (const operand of decision.operands) assertOperand(operand);
}

export function assertInvocationControlMarkers(frame: WorkflowInvocationFrame): void {
  if (!isPlainRecord(frame)) fail('invocation frame must be a plain object');
  const invLabel = typeof frame.invocationId === 'string' ? frame.invocationId : '<unknown>';
  const markers: unknown = frame.controlMarkers;
  if (markers === undefined) return;
  if (!isPlainRecord(markers)) fail(`invocation ${invLabel} controlMarkers must be a plain object`);
  if (markers.manualPauseAt !== null && !isFiniteNumber(markers.manualPauseAt)) {
    fail(`invocation ${invLabel} manualPauseAt must be a finite number or null`);
  }
  if (markers.manualPauseCause !== null && !isNonEmptyString(markers.manualPauseCause)) {
    fail(`invocation ${invLabel} manualPauseCause must be a non-empty string or null`);
  }
  if (markers.pendingRetryAt !== null && !isFiniteNumber(markers.pendingRetryAt)) {
    fail(`invocation ${invLabel} pendingRetryAt must be a finite number or null`);
  }
  if (markers.pendingRetryCause !== null && !isNonEmptyString(markers.pendingRetryCause)) {
    fail(`invocation ${invLabel} pendingRetryCause must be a non-empty string or null`);
  }
  if (
    typeof markers.delayedRetryCount !== 'number' ||
    !Number.isInteger(markers.delayedRetryCount) ||
    markers.delayedRetryCount < 0
  ) {
    fail(`invocation ${invLabel} delayedRetryCount must be a non-negative integer`);
  }
  if (!isFiniteNumber(markers.spendUsd) || markers.spendUsd < 0) {
    fail(`invocation ${invLabel} spendUsd must be a non-negative finite number`);
  }
  if (
    markers.spendBoundUsd !== undefined &&
    (!isFiniteNumber(markers.spendBoundUsd) || markers.spendBoundUsd < 0)
  ) {
    fail(`invocation ${invLabel} spendBoundUsd must be a non-negative finite number`);
  }
  if (
    markers.maxPhaseAttempts !== undefined &&
    (typeof markers.maxPhaseAttempts !== 'number' ||
      !Number.isInteger(markers.maxPhaseAttempts) ||
      markers.maxPhaseAttempts < 1)
  ) {
    fail(`invocation ${invLabel} maxPhaseAttempts must be a positive integer`);
  }
  const pauseTimeNull = markers.manualPauseAt === null;
  const pauseCauseNull = markers.manualPauseCause === null;
  if (pauseTimeNull !== pauseCauseNull) {
    fail(`invocation ${invLabel} violates paired manualPauseAt/manualPauseCause invariant`);
  }
  const retryTimeNull = markers.pendingRetryAt === null;
  const retryCauseNull = markers.pendingRetryCause === null;
  if (retryTimeNull !== retryCauseNull) {
    fail(`invocation ${invLabel} violates paired pendingRetryAt/pendingRetryCause invariant`);
  }
  if (frame.status === 'paused') {
    if (markers.manualPauseAt === null || markers.manualPauseCause === null) {
      fail(`paused invocation ${invLabel} is missing manualPauseAt/manualPauseCause`);
    }
    if (markers.pendingRetryAt !== null || markers.pendingRetryCause !== null) {
      fail(`paused invocation ${invLabel} must clear pendingRetryAt/pendingRetryCause`);
    }
  }
  if (frame.status === 'canceled' || frame.status === 'completed') {
    if (markers.pendingRetryAt !== null || markers.pendingRetryCause !== null) {
      fail(`terminal invocation ${invLabel} must clear pendingRetryAt/pendingRetryCause`);
    }
  }
}

function assertInvocationFrame(invId: string, frame: unknown): void {
  assertSafeKey(invId, 'invocation key');
  if (!isPlainRecord(frame)) fail(`invocation frame ${invId} must be a plain object`);
  if (!isNonEmptyString(frame.invocationId) || frame.invocationId !== invId) {
    fail(`invocation frame ${invId} disagrees with its key`);
  }
  assertSafeKey(frame.rootRunId, `invocation frame ${invId} rootRunId`);
  if (
    frame.parentInvocationId !== null &&
    (!isNonEmptyString(frame.parentInvocationId) || !isSafeEntityKey(frame.parentInvocationId))
  ) {
    fail(`invocation frame ${invId} parentInvocationId must be a safe string or null`);
  }
  assertSafeKey(frame.workflowId, `invocation frame ${invId} workflowId`);
  if (typeof frame.depth !== 'number' || !Number.isInteger(frame.depth) || frame.depth < 0) {
    fail(`invocation frame ${invId} depth must be a non-negative integer`);
  }
  if (!isNonEmptyString(frame.nodePath)) {
    fail(`invocation frame ${invId} nodePath must be a non-empty string`);
  }
  if (!isNonEmptyString(frame.entryNodeId) || !isSafeNodeKey(frame.entryNodeId)) {
    fail(`invocation frame ${invId} entryNodeId must be a safe non-empty string`);
  }
  if (
    frame.activeNodeId !== undefined &&
    frame.activeNodeId !== null &&
    !isNonEmptyString(frame.activeNodeId)
  ) {
    fail(`invocation frame ${invId} activeNodeId must be a non-empty string or null`);
  }
  if (typeof frame.status !== 'string' || !VALID_INVOCATION_STATUSES.has(frame.status)) {
    fail(`invocation frame ${invId} has invalid status`);
  }
  if (!isFiniteNumber(frame.startedAt)) {
    fail(`invocation frame ${invId} startedAt must be a finite number`);
  }
  if (frame.completedAt !== undefined && !isFiniteNumber(frame.completedAt)) {
    fail(`invocation frame ${invId} completedAt must be a finite number`);
  }
  if (frame.decisions !== undefined) {
    if (!Array.isArray(frame.decisions)) {
      fail(`invocation frame ${invId} decisions must be an array`);
    }
    if (frame.decisions.length > MAX_DECISIONS) {
      fail(`invocation frame ${invId} decisions exceeds ${MAX_DECISIONS} entries`);
    }
  }
  if (frame.boundInputs !== undefined) {
    if (!isPlainRecord(frame.boundInputs)) {
      fail(`invocation frame ${invId} boundInputs must be a plain object`);
    }
    assertSafeRecordKeys(frame.boundInputs, `invocation frame ${invId} boundInputs`);
  }
  if (!isPlainRecord(frame.resolvedOutputs)) {
    fail(`invocation frame ${invId} resolvedOutputs must be a plain object`);
  }
  assertSafeRecordKeys(frame.resolvedOutputs, `invocation frame ${invId} resolvedOutputs`);
  if (frame.pendingHandoff !== undefined && frame.pendingHandoff !== null) {
    assertPendingHandoff(frame.pendingHandoff, `invocation frame ${invId} pendingHandoff`);
  }
  if (frame.controlMarkers !== undefined) {
    assertInvocationControlMarkers(frame as unknown as WorkflowInvocationFrame);
  }
  if (!isPlainRecord(frame.attemptsByNodeId)) {
    fail(`invocation frame ${invId} attemptsByNodeId must be a plain object`);
  }
  const attemptNodeEntries = Object.entries(frame.attemptsByNodeId);
  if (attemptNodeEntries.length > MAX_ATTEMPT_NODES) {
    fail(`invocation frame ${invId} attemptsByNodeId exceeds ${MAX_ATTEMPT_NODES} entries`);
  }
  for (const [nodeKey, attempts] of attemptNodeEntries) {
    if (!isSafeNodeKey(nodeKey)) {
      fail(`invocation frame ${invId} attemptsByNodeId contains unsafe key: ${nodeKey}`);
    }
    if (!Array.isArray(attempts)) {
      fail(`invocation frame ${invId} attemptsByNodeId.${nodeKey} must be an array`);
    }
    if (attempts.length > MAX_ATTEMPTS_PER_NODE) {
      fail(`invocation frame ${invId} attemptsByNodeId.${nodeKey} exceeds ${MAX_ATTEMPTS_PER_NODE} entries`);
    }
    for (const attempt of attempts) {
      if (!isPlainRecord(attempt)) {
        fail(`invocation frame ${invId} attempt entry for ${nodeKey} must be a plain object`);
      }
      if (!isNonEmptyString(attempt.attemptId)) {
        fail(`invocation frame ${invId} attempt in ${nodeKey} must have a non-empty string attemptId`);
      }
      if (attempt.nodeId !== undefined && (!isNonEmptyString(attempt.nodeId) || !isSafeNodeKey(attempt.nodeId))) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} has invalid nodeId`);
      }
      if (attempt.nodeKind !== undefined && attempt.nodeKind !== 'phase' && attempt.nodeKind !== 'workflow') {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} has invalid nodeKind`);
      }
      if (
        attempt.attemptIndex !== undefined &&
        (typeof attempt.attemptIndex !== 'number' || !Number.isInteger(attempt.attemptIndex) || attempt.attemptIndex < 1)
      ) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} attemptIndex must be a positive integer`);
      }
      if (attempt.startedAt !== undefined && !isFiniteNumber(attempt.startedAt)) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} startedAt must be a finite number`);
      }
      if (attempt.declaredOutputs !== undefined && !isPlainRecord(attempt.declaredOutputs)) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} declaredOutputs must be a plain object`);
      }
      if (attempt.inputEnvelope !== undefined && !isPlainRecord(attempt.inputEnvelope)) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} inputEnvelope must be a plain object`);
      }
      if (typeof attempt.status !== 'string' || !VALID_NODE_ATTEMPT_STATUSES.has(attempt.status)) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} has invalid status`);
      }
      if (attempt.completedAt !== undefined && !isFiniteNumber(attempt.completedAt)) {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} completedAt must be a finite number`);
      }
      if (attempt.queueItemId !== undefined && typeof attempt.queueItemId !== 'string') {
        fail(`invocation frame ${invId} attempt ${attempt.attemptId} queueItemId must be a string`);
      }
      if (attempt.status === 'pending-dispatch') {
        if (attempt.completedAt !== undefined) {
          fail(
            `pending-dispatch attempt ${attempt.attemptId} in invocation ${invId} must not set completedAt`
          );
        }
        if (attempt.queueItemId !== undefined) {
          fail(
            `pending-dispatch attempt ${attempt.attemptId} in invocation ${invId} must not bind queueItemId`
          );
        }
      }
    }
  }
}

function assertInvocationTree(invocations: Record<string, unknown>): void {
  const entries = Object.entries(invocations);
  if (entries.length > MAX_INVOCATIONS) {
    fail(`invocations exceeds ${MAX_INVOCATIONS} entries`);
  }
  let rootCount = 0;
  for (const [invId, frame] of entries) {
    assertInvocationFrame(invId, frame);
    if ((frame as Record<string, unknown>).parentInvocationId === null) {
      rootCount += 1;
    }
  }
  if (entries.length === 0) return;
  if (rootCount !== 1) {
    fail(`invocations must have exactly one root frame, found ${rootCount}`);
  }
  for (const [invId] of entries) {
    const visited = new Set<string>();
    let cursor: string | null = invId;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        fail(`invocations parentInvocationId chain contains a cycle at ${cursor}`);
      }
      visited.add(cursor);
      if (!Object.hasOwn(invocations, cursor)) {
        fail(`invocations references missing parentInvocationId: ${cursor}`);
      }
      const currentFrame = invocations[cursor] as Record<string, unknown>;
      const parentId: unknown = currentFrame.parentInvocationId;
      cursor = typeof parentId === 'string' ? parentId : null;
    }
  }
}

function assertOptionalFields(
  run: Record<string, unknown>,
  requireFrozen: boolean,
  maxCommandReceipts: number
): void {
  if (run.frozenClosure !== undefined) {
    if (
      !isObjectWithFreeze(run.frozenClosure, requireFrozen) ||
      !isObjectWithFreeze(run.frozenClosure.workflowsById, requireFrozen) ||
      !isObjectWithFreeze(run.frozenClosure.phasesById, requireFrozen)
    ) {
      fail('the frozenWorkflowClosure must be frozen');
    }
    assertSafeRecordKeys(run.frozenClosure.workflowsById, 'frozenClosure.workflowsById');
    assertSafeRecordKeys(run.frozenClosure.phasesById, 'frozenClosure.phasesById');
    for (const [wfKey, wf] of Object.entries(run.frozenClosure.workflowsById)) {
      if (
        !isPlainRecord(wf) ||
        !Array.isArray(wf.nodes) ||
        !Array.isArray(wf.connections) ||
        wf.nodes.length > MAX_GRAPH_NODES ||
        wf.connections.length > MAX_GRAPH_CONNECTIONS
      ) {
        fail(`frozenClosure.workflowsById.${wfKey} must be a valid workflow definition object`);
      }
      for (const wfNode of wf.nodes) {
        if (!isPlainRecord(wfNode) || !isNonEmptyString(wfNode.nodeId) || !isSafeNodeKey(wfNode.nodeId)) {
          fail(`frozenClosure.workflowsById.${wfKey}.nodes entries must be plain objects with a safe non-empty string nodeId`);
        }
      }
      for (const wfConn of wf.connections) {
        if (!isPlainRecord(wfConn)) {
          fail(`frozenClosure.workflowsById.${wfKey}.connections entries must be plain objects`);
        }
      }
    }
    if (run.frozenClosure.catalogVersionsById !== undefined) {
      if (!isPlainRecord(run.frozenClosure.catalogVersionsById)) {
        fail('frozenClosure.catalogVersionsById must be a plain object');
      }
      assertSafeRecordKeys(run.frozenClosure.catalogVersionsById, 'frozenClosure.catalogVersionsById');
      for (const [verKey, verRef] of Object.entries(run.frozenClosure.catalogVersionsById)) {
        if (!isPlainRecord(verRef) || !isNonEmptyString(verRef.versionId)) {
          fail(`frozenClosure.catalogVersionsById.${verKey} must be a plain object with a non-empty string versionId`);
        }
      }
    }
    for (const [phaseKey, phase] of Object.entries(run.frozenClosure.phasesById)) {
      if (!isPlainRecord(phase)) fail(`frozenClosure.phasesById.${phaseKey} must be a plain object`);
    }
  }
  if (run.laneId !== undefined && !isNonEmptyString(run.laneId)) {
    fail('laneId must be a non-empty string when present');
  }
  if (run.laneRootRef !== undefined && !isNonEmptyString(run.laneRootRef)) {
    fail('laneRootRef must be a non-empty string when present');
  }
  if (run.invocations !== undefined) {
    if (!isObjectWithFreeze(run.invocations, requireFrozen)) {
      fail('the invocations map must be frozen');
    }
    assertInvocationTree(run.invocations);
  }
  if (run.inputEnvelopes !== undefined) {
    if (!isArrayWithFreeze(run.inputEnvelopes, requireFrozen)) {
      fail('the inputEnvelopes list must be frozen');
    }
    if (run.inputEnvelopes.length > MAX_INPUT_ENVELOPES) {
      fail(`inputEnvelopes exceeds ${MAX_INPUT_ENVELOPES} entries`);
    }
    for (const env of run.inputEnvelopes) {
      if (
        !isPlainRecord(env) ||
        !isNonEmptyString(env.envelopeId) ||
        !isNonEmptyString(env.invocationId) ||
        !isNonEmptyString(env.targetNodeId) ||
        !isFiniteNumber(env.acceptedAt) ||
        (env.inputsByPort !== undefined && !isPlainRecord(env.inputsByPort))
      ) {
        fail('inputEnvelopes entries must be valid envelope objects');
      }
    }
  }
  if (run.launchContext !== undefined) {
    if (!isObjectWithFreeze(run.launchContext, requireFrozen)) {
      fail('the launchContext must be frozen');
    }
    if (!Array.isArray(run.launchContext.supplemental) || !Array.isArray(run.launchContext.outputs)) {
      fail('launchContext must declare supplemental and outputs arrays');
    }
    if (run.launchContext.instructions !== undefined && typeof run.launchContext.instructions !== 'string') {
      fail('launchContext.instructions must be a string');
    }
  }
  if (run.pendingHandoff !== undefined && run.pendingHandoff !== null) {
    assertPendingHandoff(run.pendingHandoff, 'pendingHandoff');
  }
  if (run.recoveryDisposition !== undefined && run.recoveryDisposition !== null) {
    if (
      !isPlainRecord(run.recoveryDisposition) ||
      !isNonEmptyString(run.recoveryDisposition.status) ||
      !isNonEmptyString(run.recoveryDisposition.invocationId) ||
      !isFiniteNumber(run.recoveryDisposition.reconciledAt)
    ) {
      fail('recoveryDisposition must be null or a valid disposition object');
    }
  }
  if (run.commandReceipts !== undefined) {
    if (!isArrayWithFreeze(run.commandReceipts, requireFrozen)) {
      fail('the commandReceipts list must be frozen');
    }
    if (run.commandReceipts.length > maxCommandReceipts) {
      fail(`commandReceipts exceeds ${maxCommandReceipts} entries`);
    }
    for (const receipt of run.commandReceipts) {
      if (
        !isPlainRecord(receipt) ||
        !isNonEmptyString(receipt.commandId) ||
        !isNonEmptyString(receipt.operation) ||
        !isFiniteNumber(receipt.committedAt)
      ) {
        fail('commandReceipts entries must be valid receipt objects');
      }
    }
  }
  if (run.decisionObservations !== undefined) {
    if (!isArrayWithFreeze(run.decisionObservations, requireFrozen)) {
      fail('the decisionObservations list must be frozen');
    }
    if (run.decisionObservations.length > 256) {
      fail('decisionObservations exceeds 256 entries');
    }
    for (const obs of run.decisionObservations) {
      const checked = validateExecutionDecisionObservation(obs);
      if (!checked.valid) {
        fail(`invalid decisionObservation: ${checked.errors[0]?.message ?? 'invalid shape'}`);
      }
    }
  }
  if (run.controlState !== undefined) {
    if (!isObjectWithFreeze(run.controlState, requireFrozen)) {
      fail('the controlState link must be frozen');
    }
    assertKeys(run.controlState, CONTROL_STATE_KEYS, 'controlState link');
    if (!isValidConnectedRunControlLink(run.controlState)) {
      fail('controlState must have version 1 and a non-empty string ledgerRunId');
    }
  }
}

/**
 * Validates all structural (and optionally freeze) invariants of a `ConnectedWorkflowRun`.
 * Throws `ConnectedRunInvariantError` on any malformed shape; never throws a raw `TypeError`.
 */
export function assertConnectedRunStructure(
  run: unknown,
  options: ConnectedRunStructureOptions
): asserts run is ConnectedWorkflowRun {
  const requireFrozen = options.requireFrozen ?? true;
  if (!isPlainRecord(run)) fail('connected run must be a plain object');
  assertKeys(run, AGGREGATE_KEYS, 'connected run');
  assertSafeKey(run.connectedRunId, 'connectedRunId');
  assertSafeKey(run.workflowId, 'workflowId');
  if (typeof run.revision !== 'number' || !Number.isInteger(run.revision) || run.revision < 1) {
    fail(`revision must be a positive integer, not ${String(run.revision)}`);
  }
  if (!isFiniteNumber(run.startedAt)) fail('startedAt must be a finite number');
  if (run.queueId !== undefined) {
    if (!isNonEmptyString(run.queueId) || !isSafeEntityKey(run.queueId)) {
      fail(`queueId must be a safe non-empty string, not ${String(run.queueId)}`);
    }
    // FR-045. Present means bound, and a binding that names nothing is not a
    // weaker binding — it is a run whose children have nowhere to go.
    if (options.knownQueueIds !== undefined && !options.knownQueueIds.has(run.queueId)) {
      fail(`queueId names no queue in the registry: ${run.queueId}`);
    }
  }
  if (!isObjectWithFreeze(run.graph, requireFrozen) || !isObjectWithFreeze(run.pipelines, requireFrozen)) {
    fail('the graph and Pipeline snapshots must be frozen');
  }
  if (!Array.isArray(run.graph.nodes)) fail('graph.nodes must be an array');
  if (run.graph.nodes.length > MAX_GRAPH_NODES) {
    fail(`graph.nodes exceeds ${MAX_GRAPH_NODES} entries`);
  }
  const nodeIds = new Set<string>();
  for (const node of run.graph.nodes) {
    if (!isPlainRecord(node) || !isNonEmptyString(node.nodeId) || !isSafeNodeKey(node.nodeId)) {
      fail('graph.nodes entries must be objects with a safe non-empty string nodeId');
    }
    nodeIds.add(node.nodeId);
  }
  if (!Array.isArray(run.graph.startNodeIds)) fail('graph.startNodeIds must be an array');
  if (run.graph.startNodeIds.length > MAX_GRAPH_NODES) {
    fail(`graph.startNodeIds exceeds ${MAX_GRAPH_NODES} entries`);
  }
  for (const startId of run.graph.startNodeIds) {
    if (!isNonEmptyString(startId) || !isSafeNodeKey(startId)) {
      fail('graph.startNodeIds entries must be safe non-empty strings');
    }
  }
  if (!Array.isArray(run.graph.connections)) fail('graph.connections must be an array');
  if (run.graph.connections.length > MAX_GRAPH_CONNECTIONS) {
    fail(`graph.connections exceeds ${MAX_GRAPH_CONNECTIONS} entries`);
  }
  for (const conn of run.graph.connections) {
    if (!isPlainRecord(conn) || !isPlainRecord(conn.to)) {
      fail('graph.connections entries must be plain objects with a plain object to endpoint');
    }
    if (conn.to.kind === 'return') {
      if (conn.to.nodeId !== undefined && typeof conn.to.nodeId !== 'string') {
        fail('graph.connections return endpoint nodeId must be a string when present');
      }
    } else if (conn.to.kind === undefined || conn.to.kind === 'node') {
      if (!isNonEmptyString(conn.to.nodeId)) {
        fail('graph.connections entries must declare a non-empty string to.nodeId');
      }
    } else {
      fail('graph.connections to.kind must be node or return');
    }
  }
  assertSafeRecordKeys(run.pipelines, 'pipelines');
  for (const [pipelineKey, pipeline] of Object.entries(run.pipelines)) {
    if (!isPlainRecord(pipeline) || typeof pipeline.id !== 'string' || !Array.isArray(pipeline.phases)) {
      fail(`pipeline snapshot ${pipelineKey} must declare string id and phases array`);
    }
  }

  assertOptionalFields(run, requireFrozen, options.maxCommandReceipts);

  if (!isPlainRecord(run.nodes)) fail('nodes must be a plain object');
  assertSafeRecordKeys(run.nodes, 'nodes', MAX_NODES);
  for (const [key, record] of Object.entries(run.nodes)) {
    if (!isPlainRecord(record)) fail(`node record ${key} must be a plain object`);
    assertKeys(record, NODE_KEYS, 'node record');
    if (record.nodeId !== key) fail(`node record ${key} disagrees with its key`);
    if (!nodeIds.has(key)) fail(`node record ${key} is not in the frozen graph`);
    if (!Array.isArray(record.attempts)) fail(`node record ${key} attempts must be an array`);
    if (record.attempts.length === 0) fail(`node record ${key} has no attempts`);
    if (record.attempts.length > MAX_ATTEMPTS_PER_NODE) {
      fail(`node record ${key} attempts exceeds ${MAX_ATTEMPTS_PER_NODE} entries`);
    }
    for (const attempt of record.attempts) {
      if (!isPlainRecord(attempt)) fail(`attempt in node record ${key} must be a plain object`);
      assertKeys(attempt, ATTEMPT_KEYS, 'attempt');
      if (!isNonEmptyString(attempt.queueItemId)) {
        fail(`attempt in node record ${key} must have a non-empty string queueItemId`);
      }
      if (!isFiniteNumber(attempt.startedAt)) {
        fail(`attempt in node record ${key} must have a finite number startedAt`);
      }
    }
  }

  if (!Array.isArray(run.decisions)) fail('decisions must be an array');
  if (run.decisions.length > MAX_DECISIONS) {
    fail(`decisions exceeds ${MAX_DECISIONS} entries`);
  }
  const validatedNodes = run.nodes as Readonly<Record<string, ConnectedNodeRecord>>;
  const connectionCount = run.graph.connections.length;
  for (const decision of run.decisions) {
    assertDecision(decision, validatedNodes, connectionCount);
  }
}
