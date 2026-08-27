import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import { resolveProcessEnvironmentPolicy, type ProcessEnvironmentPolicy } from '../runner/spawn-env';
import { validateWorkspaceSettings } from '../config/settings-schema-validator';

/**
 * FR-R3-119 — the workspace settings `wireStage2` resolves before it builds
 * anything, gathered in one place.
 *
 * The third extraction out of `wireStage2()`, and the cleanest available: **two**
 * bindings in (`workspaceRoot`, `logger`), nine values out, no side effects, no
 * late binding, and nothing here constructs a collaborator. It is configuration
 * resolution, which is what `src/config/`-shaped code is for — it lived in the
 * composition root only because that is where it was first written.
 *
 * The two timeout keys carry their own history and it is kept verbatim below:
 * `invocation.idleTimeoutSeconds` superseded `invocation.timeoutSeconds`, and the
 * resolution order is load-bearing rather than incidental.
 */
export interface WorkspaceSettings {
  readonly config: vscode.WorkspaceConfiguration;
  readonly cliPath: string;
  readonly processEnvironmentPolicy: ProcessEnvironmentPolicy;
  readonly iterationCap: number;
  readonly pollIntervalMinutes: number;
  readonly timeoutSeconds: number;
  readonly maxDurationSeconds: number;
  readonly rotationSizeMB: number;
  readonly rotationMaxAgeDays: number;
}

export function resolveWorkspaceSettings(input: {
  readonly workspaceRoot: string;
  readonly logger: SanitizedLogger;
}): WorkspaceSettings {
  const { workspaceRoot, logger } = input;

const config = vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
// Feature 056 follow-on — one-shot drift guard. Compares every layer
// (workspace folder / workspace / global) against SETTINGS_SCHEMA and
// emits a sanitized warn per finding. Operator typos (e.g. a hand-set
// `loop.maxIterations: 0`) surface in the runtime log at activation
// instead of producing a confusing downstream reject. Sync, no I/O.
validateWorkspaceSettings(config, logger, new Set());
const cliPath = config.get<string>('cli.path', 'claude');
const processEnvironmentPolicy = resolveProcessEnvironmentPolicy({
  inheritEnvironment: config.get<boolean>('cli.inheritEnvironment', true),
  // Feature 098 (PRIV-02) — fallback mirrors the manifest default, which
  // moved `inherit` -> `allowlist`. An absent contribution must not
  // silently restore full ambient-environment forwarding.
  mode: config.get<unknown>('cli.environmentMode', 'allowlist'),
  allowlist: config.get<unknown>('cli.environmentAllowlist', [])
});
const iterationCap = config.get<number>('loop.maxIterations', 10);
const pollIntervalMinutes = config.get<number>('watchdog.pollIntervalMinutes', 30);
// FR-R3-075 — the idle window, renamed to say what it is. The old key is
// honored as a fallback when the operator set it explicitly and has not yet
// adopted the new name; `inspect` distinguishes an explicit value from the
// manifest default, which plain `get` cannot.
const idleInspect = config.inspect<number>('invocation.idleTimeoutSeconds');
const idleExplicit =
  idleInspect?.workspaceFolderValue ?? idleInspect?.workspaceValue ?? idleInspect?.globalValue;
const legacyInspect = config.inspect<number>('invocation.timeoutSeconds');
const legacyExplicit =
  legacyInspect?.workspaceFolderValue ??
  legacyInspect?.workspaceValue ??
  legacyInspect?.globalValue;
const timeoutSeconds = idleExplicit ?? legacyExplicit ?? 5400;
// FR-R3-075 — the absolute per-invocation bound; reasoning beside the
// default's declaration in general-settings.ts.
const maxDurationSeconds = config.get<number>('invocation.maxDurationSeconds', 21600);
const rotationSizeMB = config.get<number>('audit.rotation.sizeMB', 5);
const rotationMaxAgeDays = config.get<number>('audit.rotation.maxAgeDays', 30);
  return {
    config,
    cliPath,
    processEnvironmentPolicy,
    iterationCap,
    pollIntervalMinutes,
    timeoutSeconds,
    maxDurationSeconds,
    rotationSizeMB,
    rotationMaxAgeDays
  };
}
