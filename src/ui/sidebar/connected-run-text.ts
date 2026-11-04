// The authored text a connected run projection carries, sanitized once before it
// crosses to the webview (hard rule 2; C5, C7 in the Workflow catalog contract).
//
// A node's `label` and a Workflow's `name` are typed by the operator, frozen into
// the run at launch, and read back out by `projectConnectedRun` and
// `projectConnectedInvocations`. They are the only free text on a
// `ConnectedRunProjection`. Everything else is an id, a number or a host-chosen
// code, which crosses unchanged exactly as it does in
// `workflow-definition-projector.ts`, so this pass touches those two fields and
// nothing else.
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
  ConnectedRunProjection
} from '../../contracts/sidebar-ipc/workflow-run';
import { LABEL_MAX, NAME_MAX, text, type Sanitize } from './workflow-definition-projector';

function sanitizeNode(node: ConnectedNodeProjection, sanitize: Sanitize): ConnectedNodeProjection {
  if (node.label === undefined) return node;
  return Object.freeze({ ...node, label: text(node.label, sanitize, LABEL_MAX) });
}

function sanitizeInvocation(
  invocation: ConnectedInvocationProjection,
  sanitize: Sanitize
): ConnectedInvocationProjection {
  if (invocation.workflowName === undefined) return invocation;
  return Object.freeze({
    ...invocation,
    workflowName: text(invocation.workflowName, sanitize, NAME_MAX)
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
      : {})
  });
}
