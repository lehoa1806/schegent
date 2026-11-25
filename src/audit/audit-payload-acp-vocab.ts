/**
 * FR-R8-02 (02-02, 02-03, 02-04) — closed audit-payload vocabularies for ACP reconciliation,
 * stream bounds, and native-review executable/posture metadata. Kept in a dedicated leaf so
 * `audit-payload.ts` stays comfortably inside its LOC budget. Zero `vscode` imports.
 */
import type {
  ContainmentPosture,
  ExecutableTargetId
} from '../contracts/containment-qualification';
import { AuditPayloadValidationError } from './audit-payload-error';

export const ACP_RECORDABLE_PHASE_END_WARNINGS: readonly string[] = Object.freeze([
  'acp-terminal-reconciliation-failed',
  'acp-missing-terminal-record',
  'acp-contradictory-exit',
  'acp-contradictory-terminal-record',
  'acp-turn-refusal',
  'acp-turn-uncertain',
  'acp-stream-overflow',
  'acp-verbose-tee-overflow'
]);

export const AUDIT_EXECUTABLE_TARGETS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'agy',
  'codex-security'
]);

export const AUDIT_CONTAINMENT_POSTURES: ReadonlySet<string> = new Set([
  'contained',
  'accepted-uncontained',
  'accepted-unqualified'
]);

export const AUDIT_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'unrestricted',
  'workspace-write',
  'read-only'
]);

export function projectExecutableTargetAndPosture(
  payload: Record<string, unknown>,
  runner: string,
  permissionMode: string
): {
  readonly executableTarget?: ExecutableTargetId;
  readonly containmentPosture?: ContainmentPosture;
} {
  let executableTarget: ExecutableTargetId | undefined;
  if (payload.executableTarget !== undefined) {
    if (
      typeof payload.executableTarget !== 'string' ||
      !AUDIT_EXECUTABLE_TARGETS.has(payload.executableTarget)
    ) {
      throw new AuditPayloadValidationError('invalid-executable-target');
    }
    executableTarget = payload.executableTarget as ExecutableTargetId;
  }
  let containmentPosture: ContainmentPosture | undefined;
  if (payload.containmentPosture !== undefined) {
    if (
      typeof payload.containmentPosture !== 'string' ||
      !AUDIT_CONTAINMENT_POSTURES.has(payload.containmentPosture)
    ) {
      throw new AuditPayloadValidationError('invalid-containment-posture');
    }
    containmentPosture = payload.containmentPosture as ContainmentPosture;
  }
  // FR-R8-02 (02-02) cross-field invariant: standalone `codex-security` has no OS containment and
  // runs unrestricted under `codex`; never record spoofed `'contained'` or restricted permissions.
  if (executableTarget === 'codex-security') {
    if (runner !== 'codex') {
      throw new AuditPayloadValidationError('invalid-executable-target');
    }
    if (containmentPosture === 'contained') {
      throw new AuditPayloadValidationError('invalid-containment-posture');
    }
    if (permissionMode !== 'unrestricted') {
      throw new AuditPayloadValidationError('invalid-permission-mode');
    }
  }
  return {
    ...(executableTarget !== undefined ? { executableTarget } : {}),
    ...(containmentPosture !== undefined ? { containmentPosture } : {})
  };
}

export interface ProjectedWarnings {
  readonly recorded: ReadonlyArray<string>;
  readonly omitted: number;
}

export function projectRecordableWarnings(
  value: unknown,
  allowlist: ReadonlySet<string>
): ProjectedWarnings {
  if (!Array.isArray(value)) return { recorded: [], omitted: 0 };
  const recorded: string[] = [];
  let omitted = 0;
  for (const entry of value) {
    if (typeof entry === 'string' && allowlist.has(entry)) {
      if (!recorded.includes(entry)) recorded.push(entry);
      continue;
    }
    omitted += 1;
  }
  return { recorded: Object.freeze(recorded), omitted };
}
