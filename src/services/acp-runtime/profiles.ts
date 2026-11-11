/**
 * FR-R6-F13 (F13-B, F13-C; FR-001, FR-002, FR-003, FR-004, FR-015, FR-016, FR-021) — built-in
 * ACP agent profiles and host launch resolution for `agy` (native ACP stdio) and `claude` /
 * `codex` (maintained ACP stdio bridges).
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
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type { DeclaredCapabilitySet } from '../../contracts/phase-capabilities';
import { planCapabilityEnforcement, unboundedArgs } from '../capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../capability-refusal';
import type { StdioLaunch } from './stdio-transport';

export const ACP_PROFILE_IDS = Object.freeze({
  agy: 'agy-acp-native',
  claude: 'claude-acp-bridge',
  codex: 'codex-acp-bridge'
} as const satisfies Readonly<Record<BackendRunnerKind, string>>);

export type BuiltinAcpProfileId = (typeof ACP_PROFILE_IDS)[BackendRunnerKind];

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

  switch (kind) {
    case 'agy':
      return Object.freeze({
        profileId: ACP_PROFILE_IDS.agy,
        revision: 1,
        kind: 'native',
        executableRef: 'agy',
        attribution: Object.freeze({ provider: 'google', backend: 'agy', model }),
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        qualification
      });
    case 'claude':
      return Object.freeze({
        profileId: ACP_PROFILE_IDS.claude,
        revision: 1,
        kind: 'bridge',
        executableRef: 'claude',
        attribution: Object.freeze({ provider: 'anthropic', backend: 'claude', model }),
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        qualification
      });
    case 'codex':
      return Object.freeze({
        profileId: ACP_PROFILE_IDS.codex,
        revision: 1,
        kind: 'bridge',
        executableRef: 'codex',
        attribution: Object.freeze({ provider: 'openai', backend: 'codex', model }),
        requiredCapabilities: Object.freeze(['load-session', 'embedded-context'] as const),
        qualification
      });
  }
}

export function listBuiltinAcpProfiles(
  platform: AcpProfilePlatform = { os: process.platform, arch: process.arch }
): readonly AgentProfile[] {
  return Object.freeze([
    getBuiltinAcpProfile('claude', { platform }),
    getBuiltinAcpProfile('codex', { platform }),
    getBuiltinAcpProfile('agy', { platform })
  ]);
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

  if (input.kind === 'agy') {
    return {
      command: input.resolvedCliPath,
      args: ['acp', '--stdio', '--disable-telemetry', ...permissionArgs],
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
