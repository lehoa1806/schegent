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
  type BackendMap,
  type BuiltinAcpProfileId
} from '../../contracts/backend-descriptors';
import type { DeclaredCapabilitySet } from '../../contracts/phase-capabilities';
import { planCapabilityEnforcement, unboundedArgs } from '../capability-enforcement-plan';
import { CapabilityNotEnforceableError } from '../capability-refusal';
import type { StdioLaunch } from './stdio-transport';
import { assertCodexSecurityCapabilities, type NativeReviewInvocation } from '../../runner/native-review-launch';

export type { BuiltinAcpProfileId };

export const ACP_PROFILE_IDS: BackendMap<BuiltinAcpProfileId> = mapBackends(
  (descriptor) => descriptor.acpProfile.profileId
);

export type AcpHostLocality = 'local' | 'remote';

export interface AcpProfilePlatform {
  readonly os: string;
  readonly arch: string;
  readonly locality?: AcpHostLocality;
}

/**
 * Classifies whether the extension host is executing locally or attached to a remote VS Code
 * authority (`vscode.env.remoteName`). Any non-empty remote authority name classifies as `'remote'`.
 */
export function classifyHostLocality(remoteName: string | undefined): AcpHostLocality {
  return typeof remoteName === 'string' && remoteName.trim().length > 0 ? 'remote' : 'local';
}

/** Observed ACP release qualification matrix (local `darwin/arm64` per single-platform host evidence). */
export function acpQualificationForPlatform(platform: AcpProfilePlatform): AcpQualification {
  return platform.os === 'darwin' && platform.arch === 'arm64' && (platform.locality ?? 'local') === 'local'
    ? 'qualified'
    : 'unqualified';
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
  readonly executableFileStamp?: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capabilities?: DeclaredCapabilitySet;
  readonly model?: string;
  readonly effort?: string;
  readonly nativeReview?: NativeReviewInvocation;
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
  if (input.kind === 'codex' && input.nativeReview?.kind === 'security') {
    assertCodexSecurityCapabilities(input.capabilities);
  }
  const permissionArgs = resolvePermissionArgs(input.kind, input.capabilities);
  const profile = getBackendDescriptor(input.kind).acpProfile;

  if (profile.kind === 'native') {
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
  if (input.executableFileStamp) args.push('--cli-stamp', input.executableFileStamp);
  for (const flag of permissionArgs) {
    args.push('--permission-flag', flag);
  }
  if (input.model && input.model.trim().length > 0) {
    args.push('--model', input.model.trim());
  }
  if (input.effort && input.effort.trim().length > 0) {
    args.push('--effort', input.effort.trim());
  }
  if (input.nativeReview !== undefined) {
    args.push('--native-review', input.nativeReview.kind, '--review-base', input.nativeReview.mergeBase);
    if (input.kind === 'codex' && input.nativeReview.kind === 'security') {
      const scannerPath = input.nativeReview.resolvedScannerPath;
      const scannerSha256 = input.nativeReview.resolvedScannerSha256;
      if (typeof scannerPath !== 'string' || !path.isAbsolute(scannerPath)) {
        throw new Error('Codex Security launch requires a host-resolved absolute scanner executable path.');
      }
      if (typeof scannerSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(scannerSha256)) {
        throw new Error('Codex Security launch requires a host-admitted SHA-256 scanner executable digest.');
      }
      args.push('--scanner-cli', scannerPath, '--scanner-sha256', scannerSha256);
    }
    for (const excludedPath of input.nativeReview.excludedPaths ?? []) args.push('--review-exclude', excludedPath);
  }
  // Strip ambient loader-injection variables from the host-owned bridge Node process launch so
  // dynamic linkers and Node preload hooks cannot hijack the bridge before child admission/hashing.
  const bridgeEnv: NodeJS.ProcessEnv = { ...input.env };
  const isSecurityScanner = input.kind === 'codex' && input.nativeReview?.kind === 'security';
  for (const key of Object.keys(bridgeEnv)) {
    const upper = key.toUpperCase();
    if (
      upper === 'NODE_OPTIONS' ||
      upper === 'NODE_COMPILE_CACHE' ||
      upper === 'LD_PRELOAD' ||
      upper === 'LD_LIBRARY_PATH' ||
      upper === 'LD_AUDIT' ||
      upper === 'OPENSSL_CONF' ||
      upper === 'OPENSSL_MODULES' ||
      upper === 'OPENSSL_ENGINES' ||
      upper.startsWith('DYLD_') ||
      (isSecurityScanner && upper === 'CODEX_SECURITY_PROJECT_CONFIG')
    ) {
      delete bridgeEnv[key];
    }
  }
  return {
    command: nodeExec,
    args,
    cwd: input.cwd,
    env: bridgeEnv
  };
}
