// Feature 059 — Capability trust resolver.
//
// Source of truth for per-capability trust decisions (`schegent.trust.*`)
// layered on top of the VS Code workspace-trust ceiling. Implements the
// four-step resolution ladder:
//
//   1. `workspace.isTrusted === false`            → deny.
//   2. workspace-scope override (`true` / `false`) → that value.
//   3. user-scope override     (`true` / `false`) → that value.
//   4. otherwise                                   → allow (trusted by default).
//
// Contract: specs/059-fine-grained-trust-scopes/contracts/capability-trust-resolver-contract.md
//
// Invariants enforced here:
//   - I-1: no caching. Every public call re-reads `isTrusted` and `inspect()`.
//   - I-2: untrusted workspace acts as a ceiling — `isCapabilityAllowed`
//          returns `false` for every capability, regardless of overrides.
//   - I-3: only the literal booleans `true`/`false` short-circuit a layer.
//          `null` / `undefined` mean "no override; fall through".
//   - I-4: disposables are pushed into `context.subscriptions`; the module
//          retains no Disposable references of its own.
//   - I-7: the config listener fires `onInvalidate` only for the three
//          trust keys; other configuration churn is ignored.
//
// Hard rule (CLAUDE.md): never cache settings on long-lived objects. The
// resolver re-reads on every call so the listener wiring is purely an
// optimization signal for the webview projector, not a freshness gate.

import * as vscode from 'vscode';

export type TrustCapability =
  | 'phases'
  | 'retryConditions'
  | 'pipelineOverrides';

export type ResolvedScope =
  | 'user'
  | 'workspace'
  | 'workspace-trust';

export interface ResolvedCapabilities {
  readonly workspaceTrust: boolean;
  readonly phases: boolean;
  readonly retryConditions: boolean;
  readonly pipelineOverrides: boolean;
}

const SETTING_KEYS: Record<TrustCapability, string> = {
  phases: 'schegent.trust.allowCustomPhases',
  retryConditions: 'schegent.trust.allowCustomRetryConditions',
  pipelineOverrides: 'schegent.trust.allowPipelineOverrides'
};

function isExplicitBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function readInspect(
  capability: TrustCapability
): { workspaceValue: unknown; globalValue: unknown } {
  const inspected = vscode.workspace
    .getConfiguration()
    .inspect(SETTING_KEYS[capability]);
  return {
    workspaceValue: inspected?.workspaceValue,
    globalValue: inspected?.globalValue
  };
}

export function isCapabilityAllowed(capability: TrustCapability): boolean {
  if (vscode.workspace.isTrusted !== true) return false;
  const { workspaceValue, globalValue } = readInspect(capability);
  if (isExplicitBoolean(workspaceValue)) return workspaceValue;
  if (isExplicitBoolean(globalValue)) return globalValue;
  return true;
}

export function getResolvedScope(capability: TrustCapability): ResolvedScope {
  if (vscode.workspace.isTrusted !== true) return 'workspace-trust';
  const { workspaceValue, globalValue } = readInspect(capability);
  if (isExplicitBoolean(workspaceValue)) return 'workspace';
  if (isExplicitBoolean(globalValue)) return 'user';
  return 'workspace-trust';
}

export function getResolvedCapabilities(): ResolvedCapabilities {
  return {
    workspaceTrust: vscode.workspace.isTrusted === true,
    phases: isCapabilityAllowed('phases'),
    retryConditions: isCapabilityAllowed('retryConditions'),
    pipelineOverrides: isCapabilityAllowed('pipelineOverrides')
  };
}

export function initCapabilityTrustResolver(
  context: { subscriptions: { dispose: () => void }[] },
  onProjectionInvalidated: () => void
): void {
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => onProjectionInvalidated()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(SETTING_KEYS.phases) ||
        event.affectsConfiguration(SETTING_KEYS.retryConditions) ||
        event.affectsConfiguration(SETTING_KEYS.pipelineOverrides)
      ) {
        onProjectionInvalidated();
      }
    })
  );
}
