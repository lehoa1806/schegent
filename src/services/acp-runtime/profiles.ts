/**
 * FR-R6-F13 (F13-B, F13-C; FR-001, FR-002, FR-003, FR-004, FR-015, FR-016, FR-021) & FR-R7-06 —
 * built-in ACP agent profiles and host launch resolution derived from `BACKEND_DESCRIPTORS`.
 *
 * - Profiles are host-owned constants, never loaded from repository files or workspace text.
 * - Platform qualification is scoped to observed tuples (`darwin/arm64`); unverified platforms
 *   receive `qualification: 'unqualified'` so `openAcpConnection` refuses before spawn (FR-015).
 * - Secrets travel only through the caller-supplied `env` built by `buildSpawnEnv`, never argv.
 *
 * Zero `vscode` imports.
 */
import * as path from 'node:path';

import type { AgentProfile, AcpQualification } from '../../contracts/acp-runtime';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  getBackendDescriptor,
  mapBackends,
  type BackendMap
} from '../../contracts/backend-descriptors';
import type { DeclaredCapabilitySet } from '../../contracts/phase-capabilities';
import { planCapabilityEnforcement, unboundedArgs } from '../capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../capability-refusal';
import type { StdioLaunch } from './stdio-transport';

export const ACP_PROFILE_IDS: BackendMap<string> = mapBackends(
  (descriptor) => descriptor.acpProfile.profileId
);

export type BuiltinAcpProfileId = 'agy-acp-native' | 'claude-acp-bridge' | 'codex-acp-bridge';

export interface AcpProfilePlatform {
  readonly os: string;
  readonly arch: string;
}

/** Observed ACP release qualification matrix (`darwin/arm64` per single-platform host evidence). */
export function acpQualificationForPlatform(platform: AcpProfilePlatform): AcpQualification {
  return platform.os === 'darwin' && platform.arch === 'arm64' ? 'qualified' : 'unqualified';
}

export function getBuiltinAcpProfile(
  kind: BackendRunnerKind,
  options: {
    readonly platform?: AcpProfilePlatform;
    readonly model?: string;
  } = {}
): AgentProfile {
  const platform = options.platform ?? { os: process.platform, arch: process.arch };
  const qualification = acpQualificationForPlatform(platform);
  const model = options.model && options.model.trim().length > 0 ? options.model.trim() : 'default';
  const descriptor = getBackendDescriptor(kind);
  const profile = descriptor.acpProfile;

  return Object.freeze({
    profileId: profile.profileId,
    revision: profile.revision,
    kind: profile.kind,
    executableRef: profile.executableRef,
    attribution: Object.freeze({ provider: profile.provider, backend: descriptor.kind, model }),
    requiredCapabilities: profile.requiredCapabilities,
    qualification
  });
}

export function listBuiltinAcpProfiles(
  platform: AcpProfilePlatform = { os: process.platform, arch: process.arch }
): readonly AgentProfile[] {
  return Object.freeze(SUPPORTED_BACKENDS.map((kind) => getBuiltinAcpProfile(kind, { platform })));
}

function resolvePermissionArgs(
  kind: BackendRunnerKind,
  capabilities: DeclaredCapabilitySet | undefined
): readonly string[] {
  if (capabilities === undefined || capabilities.declaredAt === 'default') {
    return unboundedArgs(kind);
  }
  const plan = planCapabilityEnforcement(kind, capabilities);
  if (plan.outcome === 'refused') {
    throw new CapabilityNotEnforceableError(plan.kind, plan.unenforceable, plan.unqualified);
  }
  return plan.args;
}

export interface ResolveAcpProfileLaunchInput {
  readonly kind: BackendRunnerKind;
  readonly resolvedCliPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capabilities?: DeclaredCapabilitySet;
  readonly model?: string;
  readonly effort?: string;
  readonly bridgeScriptPath?: string;
  readonly nodeExecPath?: string;
}

export function defaultAcpBridgeScriptPath(extensionDistDir?: string): string {
  const baseDir = extensionDistDir ?? path.resolve(__dirname, '..', '..', '..', 'dist');
  return path.join(baseDir, 'acp-stdio-bridge.js');
}

/**
 * Resolves a validated `StdioLaunch` for the backend's built-in ACP profile.
 * Secrets stay in `input.env`; argv carries only non-secret flags and paths.
 */
export function resolveAcpProfileLaunch(input: ResolveAcpProfileLaunchInput): StdioLaunch {
  const permissionArgs = resolvePermissionArgs(input.kind, input.capabilities);
  const profile = getBackendDescriptor(input.kind).acpProfile;

  if (profile.kind === 'native' && profile.nativeStdioArgs !== null) {
    return {
      command: input.resolvedCliPath,
      args: [...profile.nativeStdioArgs, ...permissionArgs],
      cwd: input.cwd,
      env: input.env
    };
  }

  const bridgeScript = input.bridgeScriptPath ?? defaultAcpBridgeScriptPath();
  const nodeExec = input.nodeExecPath ?? process.execPath;
  const args: string[] = [bridgeScript, '--backend', input.kind, '--cli', input.resolvedCliPath];
  for (const flag of permissionArgs) {
    args.push('--permission-flag', flag);
  }
  if (input.model && input.model.trim().length > 0) {
    args.push('--model', input.model.trim());
  }
  if (input.effort && input.effort.trim().length > 0) {
    args.push('--effort', input.effort.trim());
  }
  return {
    command: nodeExec,
    args,
    cwd: input.cwd,
    env: input.env
  };
}
