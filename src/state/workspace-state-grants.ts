/**
 * FR-R7-07 — Grants and Confirmation Suppression key-family module
 * (`KEYS.confirmSuppression`, `KEYS.gitPlanGrants`, `KEYS.agentConfigGrants`),
 * delegated from `WorkspaceStateStore`.
 */

import type { BackendRunnerKind } from '../contracts/backend-kinds';
import {
  forgetAgentConfigGrant as forgetAgentConfigGrantInMap,
  latestGrantForBackend,
  readAgentConfigGrants,
  writeAgentConfigGrant,
  type AgentConfigGrant,
  type AgentConfigGrantMap
} from './agent-config-grants';
import {
  readConfirmSuppression,
  writeConfirmSuppression,
  type ConfirmSuppressionState
} from './confirm-suppression';
import {
  forgetGitPlanGrant as forgetGitPlanGrantInMap,
  readGitPlanGrants,
  writeGitPlanGrant,
  type GitPlanGrant,
  type GitPlanGrantMap
} from './git-plan-grants';
import { KEYS, type WorkspaceStateFamilyContext } from './workspace-state-types';

export interface GrantsWarningState {
  readonly gitPlanGrantProblemsWarned: Set<string>;
  readonly agentConfigGrantProblemsWarned: Set<string>;
}

export function createGrantsWarningState(): GrantsWarningState {
  return {
    gitPlanGrantProblemsWarned: new Set<string>(),
    agentConfigGrantProblemsWarned: new Set<string>()
  };
}

export function getConfirmSuppression(
  ctx: WorkspaceStateFamilyContext
): ConfirmSuppressionState {
  return readConfirmSuppression(ctx.memento.get<unknown>(KEYS.confirmSuppression));
}

export async function setConfirmSuppression(
  ctx: WorkspaceStateFamilyContext,
  actionKey: string,
  suppressed: boolean
): Promise<void> {
  const next = writeConfirmSuppression(getConfirmSuppression(ctx), actionKey, suppressed);
  await ctx.memento.update(KEYS.confirmSuppression, next);
}

export function getGitPlanGrants(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState
): GitPlanGrantMap {
  const result = readGitPlanGrants(ctx.memento.get<unknown>(KEYS.gitPlanGrants));
  for (const problem of result.problems) {
    if (warned.gitPlanGrantProblemsWarned.has(problem)) continue;
    warned.gitPlanGrantProblemsWarned.add(problem);
    ctx.logger?.warn(`workspace-state: ${KEYS.gitPlanGrants}: ${problem}`);
  }
  return result.grants;
}

export function hasGitPlanGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  fingerprint: string
): boolean {
  return Object.prototype.hasOwnProperty.call(getGitPlanGrants(ctx, warned), fingerprint);
}

export async function recordGitPlanGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  grant: GitPlanGrant
): Promise<void> {
  const next = writeGitPlanGrant(getGitPlanGrants(ctx, warned), grant);
  await ctx.memento.update(KEYS.gitPlanGrants, next);
}

export async function forgetGitPlanGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  fingerprint: string
): Promise<boolean> {
  const next = forgetGitPlanGrantInMap(getGitPlanGrants(ctx, warned), fingerprint);
  if (next === null) return false;
  await ctx.memento.update(KEYS.gitPlanGrants, next);
  return true;
}

export async function forgetAllGitPlanGrants(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState
): Promise<number> {
  const count = Object.keys(getGitPlanGrants(ctx, warned)).length;
  await ctx.memento.update(KEYS.gitPlanGrants, {});
  return count;
}

export function getAgentConfigGrants(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState
): AgentConfigGrantMap {
  const result = readAgentConfigGrants(ctx.memento.get<unknown>(KEYS.agentConfigGrants));
  for (const problem of result.problems) {
    if (warned.agentConfigGrantProblemsWarned.has(problem)) continue;
    warned.agentConfigGrantProblemsWarned.add(problem);
    ctx.logger?.warn(`workspace-state: ${KEYS.agentConfigGrants}: ${problem}`);
  }
  return result.grants;
}

export function hasAgentConfigGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  fingerprint: string,
  backend?: BackendRunnerKind
): boolean {
  const grants = getAgentConfigGrants(ctx, warned);
  if (!Object.prototype.hasOwnProperty.call(grants, fingerprint)) return false;
  return backend === undefined || grants[fingerprint].backend === backend;
}

export function latestAgentConfigGrantForBackend(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  backend: BackendRunnerKind
): AgentConfigGrant | null {
  return latestGrantForBackend(getAgentConfigGrants(ctx, warned), backend);
}

export async function recordAgentConfigGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  grant: AgentConfigGrant
): Promise<void> {
  await ctx.serialize(KEYS.agentConfigGrants, async () => {
    const next = writeAgentConfigGrant(getAgentConfigGrants(ctx, warned), grant);
    await ctx.memento.update(KEYS.agentConfigGrants, next);
  });
}

export async function forgetAgentConfigGrant(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState,
  fingerprint: string
): Promise<boolean> {
  let removed = false;
  await ctx.serialize(KEYS.agentConfigGrants, async () => {
    const next = forgetAgentConfigGrantInMap(getAgentConfigGrants(ctx, warned), fingerprint);
    if (next === null) return;
    await ctx.memento.update(KEYS.agentConfigGrants, next);
    removed = true;
  });
  return removed;
}

export async function forgetAllAgentConfigGrants(
  ctx: WorkspaceStateFamilyContext,
  warned: GrantsWarningState
): Promise<number> {
  let count = 0;
  await ctx.serialize(KEYS.agentConfigGrants, async () => {
    count = Object.keys(getAgentConfigGrants(ctx, warned)).length;
    await ctx.memento.update(KEYS.agentConfigGrants, {});
  });
  return count;
}
