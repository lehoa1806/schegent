// The authored text a connected run projection carries, sanitized once before it
// crosses to the webview (hard rule 2; C5, C7 in the Workflow catalog contract).
//
// A node's `label`, a Workflow's `name`, and candidate/control projection text
// (`resultReason`, `evidenceRefs`, `durableNotices`, `activeAttemptOvershootNote`,
// and candidate `phaseName`/`instructionSummary`) carry operator-authored or
// diagnostic free text. Everything else is an id, a number or a host-chosen code,
// which crosses unchanged exactly as it does in `workflow-definition-projector.ts`.
//
// Two paths carry the projection to the webview and both run it through here: the
// snapshot composer (`connectedRuns`) and the `CMD_CONTINUE_WORKFLOW` handler,
// whose `rejected-stale` and `rejected-state` refusals carry the authoritative
// projection (FR-045). The pass sits at those two seams rather than inside
// `projectConnectedRun` because that function is also the continuation service's
// `projectRun` and the gate's `isNodeStartable`; the service is shared with the
// headless entrypoint, and none of those signatures carries a sanitizer.

import type {
  ConnectedInvocationProjection,
  ConnectedNodeProjection,
  ConnectedRunProjection,
  ControlCandidateProjection,
  ControlProjection
} from '../../contracts/sidebar-ipc/workflow-run';
import {
  LABEL_MAX,
  MESSAGE_MAX,
  NAME_MAX,
  text,
  type Sanitize
} from './workflow-definition-projector';

const CONTROL_TEXT_MAX = 256;

function sanitizeNode(node: ConnectedNodeProjection, sanitize: Sanitize): ConnectedNodeProjection {
  if (node.label === undefined) return node;
  return Object.freeze({ ...node, label: text(node.label, sanitize, LABEL_MAX) });
}

function sanitizeControlCandidate(
  candidate: ControlCandidateProjection,
  sanitize: Sanitize
): ControlCandidateProjection {
  if (candidate.phaseName === undefined && candidate.instructionSummary === undefined) {
    return candidate;
  }
  return Object.freeze({
    ...candidate,
    ...(candidate.phaseName !== undefined
      ? { phaseName: text(candidate.phaseName, sanitize, NAME_MAX) }
      : {}),
    ...(candidate.instructionSummary !== undefined
      ? { instructionSummary: text(candidate.instructionSummary, sanitize, MESSAGE_MAX) }
      : {})
  });
}

function sanitizeControlProjection(
  projection: ControlProjection,
  sanitize: Sanitize
): ControlProjection {
  return Object.freeze({
    ...projection,
    ...(projection.resultReason !== undefined
      ? { resultReason: text(projection.resultReason, sanitize, CONTROL_TEXT_MAX) }
      : {}),
    ...(projection.activeAttemptOvershootNote !== undefined
      ? {
          activeAttemptOvershootNote: text(
            projection.activeAttemptOvershootNote,
            sanitize,
            CONTROL_TEXT_MAX
          )
        }
      : {}),
    ...(projection.durableNotices !== undefined
      ? {
          durableNotices: Object.freeze(
            projection.durableNotices.map((notice) => text(notice, sanitize, CONTROL_TEXT_MAX))
          )
        }
      : {}),
    ...(projection.candidates !== undefined
      ? {
          candidates: Object.freeze(
            projection.candidates.map((candidate) => sanitizeControlCandidate(candidate, sanitize))
          )
        }
      : {}),
    evidenceRefs: Object.freeze(
      projection.evidenceRefs.map((ref) => text(ref, sanitize, CONTROL_TEXT_MAX))
    )
  });
}

function sanitizeInvocation(
  invocation: ConnectedInvocationProjection,
  sanitize: Sanitize
): ConnectedInvocationProjection {
  if (invocation.workflowName === undefined && invocation.controlProjection === undefined) {
    return invocation;
  }
  return Object.freeze({
    ...invocation,
    ...(invocation.workflowName !== undefined
      ? { workflowName: text(invocation.workflowName, sanitize, NAME_MAX) }
      : {}),
    ...(invocation.controlProjection !== undefined
      ? { controlProjection: sanitizeControlProjection(invocation.controlProjection, sanitize) }
      : {})
  });
}

/** One connected run, with its authored text sanitized and bounded. */
export function sanitizeConnectedRun(
  run: ConnectedRunProjection,
  sanitize: Sanitize
): ConnectedRunProjection {
  return Object.freeze({
    ...run,
    nodes: Object.freeze(run.nodes.map((node) => sanitizeNode(node, sanitize))),
    ...(run.invocations !== undefined
      ? {
          invocations: Object.freeze(
            run.invocations.map((invocation) => sanitizeInvocation(invocation, sanitize))
          )
        }
      : {}),
    ...(run.controlProjection !== undefined
      ? { controlProjection: sanitizeControlProjection(run.controlProjection, sanitize) }
      : {})
  });
}
