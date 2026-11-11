/**
 * FR-R6-F13 (FR-004, FR-005, FR-007, FR-019, research R1) — the `initialize` exchange and the
 * capability decisions made from it.
 *
 * - The host advertises no file system and no terminal: agent requests for either are refused.
 * - The agent's answer must name protocol version 1. Another integer is
 *   `protocol-version-unsupported`; anything that is not the documented shape is
 *   `protocol-violation`. Absent capability fields are false.
 * - A profile requirement the agent did not grant is named, so the open refuses before any
 *   session exists; a gated operation is allowed only with its negotiated capability.
 *
 * Zero `vscode` imports.
 */
import {
  ACP_CAPABILITY_MATRIX,
  ACP_PROTOCOL_VERSION,
  ACP_REQUIREMENT_FLAGS,
  type AcpOperation,
  type AcpRequiredCapability,
  type AgentProfile,
  type NegotiatedCapabilities
} from '../../contracts/acp-runtime';

export type NegotiationResult =
  | { readonly ok: true; readonly capabilities: NegotiatedCapabilities }
  | { readonly ok: false; readonly reason: 'protocol-version-unsupported' | 'protocol-violation' };

const VIOLATION: NegotiationResult = Object.freeze({ ok: false, reason: 'protocol-violation' });

/** The `initialize` params the host writes. */
export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An optional object field: absent is an empty record, anything else but an object is null. */
function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  return isRecord(value) ? value : null;
}

/** An optional boolean field: absent is false, anything else but a boolean is null. */
function optionalFlag(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : null;
}

/** Validates the agent's `initialize` result. */
export function negotiate(result: unknown): NegotiationResult {
  if (!isRecord(result)) return VIOLATION;
  const version = result['protocolVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return VIOLATION;
  if (version !== ACP_PROTOCOL_VERSION) return { ok: false, reason: 'protocol-version-unsupported' };
  const agent = optionalRecord(result['agentCapabilities']);
  if (agent === null) return VIOLATION;
  const prompt = optionalRecord(agent['promptCapabilities']);
  if (prompt === null) return VIOLATION;
  const loadSession = optionalFlag(agent['loadSession']);
  const image = optionalFlag(prompt['image']);
  const audio = optionalFlag(prompt['audio']);
  const embeddedContext = optionalFlag(prompt['embeddedContext']);
  if (loadSession === null || image === null || audio === null || embeddedContext === null) return VIOLATION;
  const authMethods = result['authMethods'];
  if (authMethods !== undefined && !Array.isArray(authMethods)) return VIOLATION;
  const authMethodCount = Array.isArray(authMethods) ? authMethods.length : 0;
  return {
    ok: true,
    capabilities: { protocolVersion: ACP_PROTOCOL_VERSION, loadSession, image, audio, embeddedContext, authMethodCount }
  };
}

/** The first profile requirement the agent did not grant, or null when all are granted. */
export function missingRequirement(profile: AgentProfile, capabilities: NegotiatedCapabilities): AcpRequiredCapability | null {
  for (const requirement of profile.requiredCapabilities) {
    if (!capabilities[ACP_REQUIREMENT_FLAGS[requirement]]) return requirement;
  }
  return null;
}

/** FR-019: whether the negotiated capabilities allow one operation. */
export function operationAllowed(operation: AcpOperation, capabilities: NegotiatedCapabilities): boolean {
  const flag = ACP_CAPABILITY_MATRIX[operation];
  return flag === null || capabilities[flag];
}
