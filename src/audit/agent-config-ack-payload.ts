// Feature 318 (FR-R7-04, FR-005, SC-005) — closed metadata-only projection for
// `agent-config-acknowledged`. Only `backend`, `fileCount` and `decision` may
// reach the audit log; any extra key (path, hook name, setting key, value, or
// file content) throws `AuditPayloadValidationError`.
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../contracts/backend-kinds';
import {
  AGENT_CONFIG_ACK_DECISIONS,
  type AgentConfigAckDecision,
  type AgentConfigAcknowledgedPayload
} from '../contracts/agent-config-acknowledgement';
import { AuditPayloadValidationError } from './audit-payload-error';

const REASON = 'malformed-agent-config-acknowledged';
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['backend', 'fileCount', 'decision']);

const reject = (): AuditPayloadValidationError => new AuditPayloadValidationError(REASON);

export function projectAgentConfigAckPayload(
  payload: Record<string, unknown>
): AgentConfigAcknowledgedPayload {
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) throw reject();
  const { backend, fileCount, decision } = payload;
  if (typeof backend !== 'string' || !(SUPPORTED_BACKENDS as readonly string[]).includes(backend)) {
    throw reject();
  }
  if (typeof fileCount !== 'number' || !Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw reject();
  }
  if (
    typeof decision !== 'string' ||
    !(AGENT_CONFIG_ACK_DECISIONS as readonly string[]).includes(decision)
  ) {
    throw reject();
  }
  return {
    backend: backend as BackendRunnerKind,
    fileCount,
    decision: decision as AgentConfigAckDecision
  };
}
