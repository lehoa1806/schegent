// Feature 059 — Capability trust resolver.
//
// Source of truth for per-capability trust decisions (`schegent.trust.*`)
// layered on top of the VS Code workspace-trust ceiling. Implements the
// four-step resolution ladder:
//
//   1. `workspace.isTrusted === false`            → deny.
//   2. an explicit `false` at EITHER scope         → deny.
//   3. an explicit `true` at either scope          → allow.
//   4. otherwise (silent at both)                  → allow, following Workspace Trust.
//
// FR-R3-108 — step 2 is new, and it replaces a ladder that consulted workspace scope
// first and user scope only if the workspace was silent. That was inverted for exactly
// the scenario a trust control exists for: a user who set `false` at USER scope opened a
// repository whose `.vscode/settings.json` — content that arrived WITH the workspace —
// set `true`, and the workspace won. Every sibling hardening went the other way;
// application-scoped settings exist precisely so a repository cannot redirect `cliPath`
// or flip containment (FR-R3-051). This one handed the workspace the override.
//
// DENY-PRECEDENCE, not user-precedence. A workspace `true` still takes effect where the
// user is silent or allowing — a repository may narrow or agree, never widen past a
// user's deny. So the resolution is no longer "first scope with an opinion wins" but
// "any deny wins, otherwise any allow".
//
// THE SILENT DEFAULT IS UNCHANGED, and named rather than implicit. See
// `SILENT_DEFAULT` below.
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
//   - I-7: the config listener fires `onInvalidate` only for the trust keys
//          in `SETTING_KEYS`; other configuration churn is ignored.
//
// Hard rule (CLAUDE.md): never cache settings on long-lived objects. The
// resolver re-reads on every call so the listener wiring is purely an
// optimization signal for the webview projector, not a freshness gate.

import * as vscode from 'vscode';

import {
  isExplicitBoolean,
  resolveCapabilityDecision
} from './capability-trust-decision';

// Feature 099 (T492, FR-046) — `pipelineOverrides` and `workflowOverrides` are
// gone with the layer tier. Both asked which layer was permitted to redefine
// another's row; one layer has no such question. The two survivors gate document
// CONTENT, not layering, so the collapse leaves them exactly as they were.
export type TrustCapability = 'phases' | 'retryConditions';

export type ResolvedScope =
  | 'user'
  | 'workspace'
  | 'workspace-trust';

export interface ResolvedCapabilities {
  readonly workspaceTrust: boolean;
  readonly phases: boolean;
  readonly retryConditions: boolean;
}

const SETTING_KEYS: Record<TrustCapability, string> = {
  phases: 'schegent.trust.allowCustomPhases',
  retryConditions: 'schegent.trust.allowCustomRetryConditions'
};



/**
 * FR-R3-126 — the ladder and its silent default moved to
 * `capability-trust-decision.ts`, a pure module, so the decision is reachable
 * without `vscode`. Nothing about it changed; read that file for the reasoning
 * behind `SILENT_DEFAULT`, which is where it now lives.
 */

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

/**
 * FR-R3-126 — this is now the vscode-READING half. The decision is
 * `resolveCapabilityDecision`; this function's whole job is invariant I-1, which
 * is that every public call re-reads `isTrusted` and `inspect()` rather than
 * caching either.
 */
export function isCapabilityAllowed(capability: TrustCapability): boolean {
  const { workspaceValue, globalValue } = readInspect(capability);
  return resolveCapabilityDecision({
    isTrusted: vscode.workspace.isTrusted === true,
    workspaceValue,
    globalValue
  });
}

export function getResolvedScope(capability: TrustCapability): ResolvedScope {
  if (vscode.workspace.isTrusted !== true) return 'workspace-trust';
  const { workspaceValue, globalValue } = readInspect(capability);
  // Mirrors the ladder above deny-first, so the reporter names the scope that ACTUALLY
  // decided. Before FR-R3-108 it reported `workspace` in the inversion case while the
  // answer came from the user's deny — telling an operator the wrong thing about their
  // own setting, which is worse than telling them nothing.
  if (globalValue === false) return 'user';
  if (workspaceValue === false) return 'workspace';
  if (isExplicitBoolean(workspaceValue)) return 'workspace';
  if (isExplicitBoolean(globalValue)) return 'user';
  return 'workspace-trust';
}

export function getResolvedCapabilities(): ResolvedCapabilities {
  return {
    workspaceTrust: vscode.workspace.isTrusted === true,
    phases: isCapabilityAllowed('phases'),
    retryConditions: isCapabilityAllowed('retryConditions')
  };
}

export function initCapabilityTrustResolver(
  context: { subscriptions: { dispose: () => void }[] },
  onProjectionInvalidated: () => void
): void {
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => onProjectionInvalidated()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Derived from SETTING_KEYS rather than enumerated, so a capability
      // added to the ladder cannot silently lose its invalidation signal.
      const affectsTrust = Object.values(SETTING_KEYS).some((key) =>
        event.affectsConfiguration(key)
      );
      if (affectsTrust) {
        onProjectionInvalidated();
      }
    })
  );
}
