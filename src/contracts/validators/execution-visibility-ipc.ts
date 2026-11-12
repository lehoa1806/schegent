import {
  CMD_DECIDE_PHASE_HANDOFF,
  CMD_OPEN_CHANGE_REVIEW,
  CMD_READ_EXECUTION_VISIBILITY,
  type DecidePhaseHandoffResponse,
  type OpenChangeReviewResponse,
  type ReadExecutionVisibilityResponse,
  type SidebarCommand
} from '../sidebar-ipc';
import { REVIEW_REFUSAL_REASONS } from '../change-review';
import { IDENTIFIER_PATTERN, PHASE_CONTEXT_FAILURES } from '../phase-context/context-policy';
import {
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  isSafePathSegment,
  ok as ipcOk,
  type IpcValidationResult
} from './shared';

type Plain = Record<string, unknown>;

const CURSOR_MAX = 256;

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= QUEUE_ID_MAX &&
    (isSafePathSegment(value) || IDENTIFIER_PATTERN.test(value))
  );
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CURSOR_MAX && /^[A-Za-z0-9_-]+$/.test(value);
}

export function validateReadExecutionVisibility(
  obj: Plain,
  correlationId: string
): IpcValidationResult {
  const context = { type: CMD_READ_EXECUTION_VISIBILITY, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  const op = payload['op'];
  if (op === 'attemptDetail') {
    if (hasUnexpectedKeys(payload, ['op', 'rootExecutionId', 'invocationId', 'attemptId'])) {
      return fail('unexpected-payload-fields', context);
    }
    const rootExecutionId = payload['rootExecutionId'];
    if (!isBoundedIdentifier(rootExecutionId)) return fail('invalid-rootExecutionId', context);
    const invocationId = payload['invocationId'];
    if (invocationId !== undefined && !isBoundedIdentifier(invocationId)) {
      return fail('invalid-invocationId', context);
    }
    const attemptId = payload['attemptId'];
    if (attemptId !== undefined && !isBoundedIdentifier(attemptId)) {
      return fail('invalid-attemptId', context);
    }
    return ipcOk({
      ...context,
      payload: {
        op: 'attemptDetail',
        rootExecutionId,
        ...(invocationId === undefined ? {} : { invocationId }),
        ...(attemptId === undefined ? {} : { attemptId })
      }
    } as SidebarCommand);
  }
  if (op === 'runtimePosture') {
    if (hasUnexpectedKeys(payload, ['op'])) {
      return fail('unexpected-payload-fields', context);
    }
    return ipcOk({
      ...context,
      payload: { op: 'runtimePosture' }
    } as SidebarCommand);
  }
  return fail('invalid-op', context);
}

export function validateOpenChangeReview(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_OPEN_CHANGE_REVIEW, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  const op = payload['op'];

  switch (op) {
    case 'open': {
      if (hasUnexpectedKeys(payload, ['op', 'requestId', 'expectedRevision', 'openInEditor'])) {
        return fail('unexpected-payload-fields', context);
      }
      const requestId = payload['requestId'];
      if (!isBoundedIdentifier(requestId)) return fail('invalid-requestId', context);
      const expectedRevision = payload['expectedRevision'];
      if (expectedRevision !== undefined && !isBoundedIdentifier(expectedRevision)) {
        return fail('invalid-expectedRevision', context);
      }
      const openInEditor = payload['openInEditor'];
      if (openInEditor !== undefined && typeof openInEditor !== 'boolean') {
        return fail('invalid-openInEditor', context);
      }
      return ipcOk({
        ...context,
        payload: {
          op: 'open',
          requestId,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(openInEditor === undefined ? {} : { openInEditor })
        }
      } as SidebarCommand);
    }
    case 'refresh': {
      if (hasUnexpectedKeys(payload, ['op', 'reviewId', 'openInEditor'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reviewId = payload['reviewId'];
      if (!isBoundedIdentifier(reviewId)) return fail('invalid-reviewId', context);
      const openInEditor = payload['openInEditor'];
      if (openInEditor !== undefined && typeof openInEditor !== 'boolean') {
        return fail('invalid-openInEditor', context);
      }
      return ipcOk({
        ...context,
        payload: {
          op: 'refresh',
          reviewId,
          ...(openInEditor === undefined ? {} : { openInEditor })
        }
      } as SidebarCommand);
    }
    case 'classify':
    case 'close': {
      if (hasUnexpectedKeys(payload, ['op', 'reviewId'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reviewId = payload['reviewId'];
      if (!isBoundedIdentifier(reviewId)) return fail('invalid-reviewId', context);
      return ipcOk({
        ...context,
        payload: { op, reviewId }
      } as SidebarCommand);
    }
    case 'page': {
      if (hasUnexpectedKeys(payload, ['op', 'cursor'])) {
        return fail('unexpected-payload-fields', context);
      }
      const cursor = payload['cursor'];
      if (!isCursor(cursor)) return fail('invalid-cursor', context);
      return ipcOk({
        ...context,
        payload: { op: 'page', cursor }
      } as SidebarCommand);
    }
    case 'cancelOpen': {
      if (hasUnexpectedKeys(payload, ['op'])) {
        return fail('unexpected-payload-fields', context);
      }
      return ipcOk({
        ...context,
        payload: { op: 'cancelOpen' }
      } as SidebarCommand);
    }
    default:
      return fail('invalid-op', context);
  }
}

export function validateDecidePhaseHandoff(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_DECIDE_PHASE_HANDOFF, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  const op = payload['op'];

  if (op === 'approve') {
    if (hasUnexpectedKeys(payload, ['op', 'handoffId', 'expectedRevision', 'decisionId'])) {
      return fail('unexpected-payload-fields', context);
    }
    const handoffId = payload['handoffId'];
    const expectedRevision = payload['expectedRevision'];
    const decisionId = payload['decisionId'];
    if (!isBoundedIdentifier(handoffId)) return fail('invalid-handoffId', context);
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      return fail('invalid-expectedRevision', context);
    }
    if (!isBoundedIdentifier(decisionId)) return fail('invalid-decisionId', context);
    return ipcOk({
      ...context,
      payload: { op: 'approve', handoffId, expectedRevision, decisionId }
    } as SidebarCommand);
  }

  if (op === 'edit') {
    if (hasUnexpectedKeys(payload, ['op', 'handoffId', 'baseRevision', 'replacementSources'])) {
      return fail('unexpected-payload-fields', context);
    }
    const handoffId = payload['handoffId'];
    const baseRevision = payload['baseRevision'];
    if (!isBoundedIdentifier(handoffId)) return fail('invalid-handoffId', context);
    if (
      typeof baseRevision !== 'number' ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 1
    ) {
      return fail('invalid-baseRevision', context);
    }
    const replacementSources = payload['replacementSources'];
    if (!Array.isArray(replacementSources)) {
      return fail('invalid-replacementSources', context);
    }
    return ipcOk({
      ...context,
      payload: { op: 'edit', handoffId, baseRevision, replacementSources }
    } as SidebarCommand);
  }

  return fail('invalid-op', context);
}

function isReviewResultShape(value: unknown, checkValue: (v: unknown) => boolean): boolean {
  if (!isPlain(value)) return false;
  if (value['ok'] === true) return checkValue(value['value']);
  if (value['ok'] !== false) return false;
  return (
    typeof value['reason'] === 'string' &&
    (REVIEW_REFUSAL_REASONS as readonly string[]).includes(value['reason'])
  );
}

function isEditorOpenOutcomeShape(value: unknown): boolean {
  return (
    isPlain(value) &&
    (value['mode'] === 'native' || value['mode'] === 'fallback' || value['mode'] === 'none') &&
    typeof value['opened'] === 'number'
  );
}

export function isValidReadExecutionVisibilityResponse(
  value: unknown
): value is ReadExecutionVisibilityResponse {
  if (!isPlain(value)) return false;
  if (value['op'] === 'attemptDetail') {
    const detail = value['detail'];
    return (
      isPlain(detail) &&
      typeof detail['available'] === 'boolean' &&
      typeof detail['rootExecutionId'] === 'string' &&
      isPlain(detail['hierarchy']) &&
      Array.isArray(detail['evidence']) &&
      isPlain(detail['liveLog']) &&
      isPlain(detail['recovery']) &&
      isPlain(detail['acp']) &&
      isPlain(detail['lane']) &&
      Array.isArray(detail['handoffs']) &&
      Array.isArray(detail['reviewLoops'])
    );
  }
  if (value['op'] === 'runtimePosture') {
    const posture = value['posture'];
    return (
      isPlain(posture) &&
      typeof posture['available'] === 'boolean' &&
      isPlain(posture['lanes']) &&
      isPlain(posture['telemetry'])
    );
  }
  return false;
}

export function isValidOpenChangeReviewResponse(
  value: unknown
): value is OpenChangeReviewResponse {
  if (!isPlain(value) || typeof value['op'] !== 'string') return false;
  switch (value['op']) {
    case 'open':
    case 'refresh':
      return (
        isReviewResultShape(
          value['result'],
          (v) => isPlain(v) && typeof v['state'] === 'string'
        ) && isEditorOpenOutcomeShape(value['editor'])
      );
    case 'classify':
      return isReviewResultShape(
        value['result'],
        (v) => isPlain(v) && typeof v['reviewId'] === 'string' && typeof v['state'] === 'string'
      );
    case 'page':
      return isReviewResultShape(
        value['result'],
        (v) => isPlain(v) && typeof v['reviewId'] === 'string' && Array.isArray(v['entries'])
      );
    case 'close':
      return typeof value['closed'] === 'boolean';
    case 'cancelOpen':
      return typeof value['canceled'] === 'boolean';
    default:
      return false;
  }
}

export function isValidDecidePhaseHandoffResponse(
  value: unknown
): value is DecidePhaseHandoffResponse {
  if (!isPlain(value)) return false;
  const op = value['op'];
  if (op !== 'approve' && op !== 'edit') return false;
  const result = value['result'];
  if (!isPlain(result)) return false;
  if (result['ok'] === true) {
    return op === 'approve'
      ? typeof result['revision'] === 'number'
      : isPlain(result['revision']);
  }
  if (result['ok'] !== false) return false;
  return (
    typeof result['failure'] === 'string' &&
    (PHASE_CONTEXT_FAILURES as readonly string[]).includes(result['failure']) &&
    typeof result['detail'] === 'string'
  );
}
