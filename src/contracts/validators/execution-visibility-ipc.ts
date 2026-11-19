// Egress response validators for execution visibility, change review, and phase handoff IPC.
// Inbound request validators are generated in `src/contracts/generated/validators/execution-workflow.ts`.

import type {
  DecidePhaseHandoffResponse,
  OpenChangeReviewResponse,
  ReadExecutionVisibilityResponse
} from '../sidebar-ipc';
import { REVIEW_REFUSAL_REASONS } from '../change-review';
import { PHASE_CONTEXT_FAILURES } from '../phase-context/context-policy';

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
