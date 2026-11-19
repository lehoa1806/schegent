// Feature 318 (FR-R7-04, FR-005) — closed metadata-only audit contract for
// per-workspace repository agent configuration acknowledgement decisions.
//
// WHAT THIS CARRIES, AND WHAT IT MUST NEVER CARRY. Only three fields:
// `backend`, `fileCount` and `decision`. No file paths, relative config names,
// hook event names, setting key names, digests, raw values, or file contents
// may ever appear in the serialized audit event (FR-005, SC-005).
import type { BackendRunnerKind } from './backend-kinds';

export const AGENT_CONFIG_ACK_DECISIONS = [
  'stored',
  'approved-once',
  'acknowledged',
  'denied'
] as const;

export type AgentConfigAckDecision = (typeof AGENT_CONFIG_ACK_DECISIONS)[number];

export interface AgentConfigAcknowledgedPayload {
  readonly backend: BackendRunnerKind;
  readonly fileCount: number;
  readonly decision: AgentConfigAckDecision;
}
