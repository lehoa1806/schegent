// Feature 100 (FR-R3-016) T509a — the webview's single dispatch surface for the
// six lifecycle commands.
//
// It replaces three modules, not one. `save-phases.ts`, `save-pipelines.ts`, and
// `save-workflows.ts` each owned one whole-array command and each re-implemented
// the same correlate/pend/await/timeout dance, because `save-catalog-command.ts`
// discards `ack.result` and every catalog rejection carries a structured recovery
// payload. That duplication existed to serve three commands with three payload
// shapes; the six lifecycle commands share one shape — a target — so one sender
// serves them all.
//
// Two of the six are destructive, and both are confirm-gated **here**, inside the
// helper, rather than at each call site (FR-049). A gate at the call site is a gate
// the next call site can forget; a gate inside the only function that can post the
// command cannot be forgotten, only deleted — and `tests/lint/destructive-actions.lint.test.ts`
// fails on that. Publish and restore are deliberately ungated: publishing is
// additive, and restore only writes a draft, whose destruction is itself gated.
//
// What is *not* here: any notion of a layer. A lifecycle operation names one
// definition. The one command that carries many — `CMD_PUBLISH_PACKAGE` — is a
// single imported document confirmed once, not a catalog snapshot (FR-035).

import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  type SidebarCommand
} from './messages';
import {
  NO_DRAFT,
  type DeactivateRequest,
  type DiscardDraftRequest,
  type ExpectedDraftVersion,
  type PackagePublishRequest,
  type PublishRequest,
  type RestoreRequest,
  type SaveDraftRequest
} from '../../../src/contracts/catalog-lifecycle';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import type { BuilderLifecycle } from './snapshot-types';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';
import { useConfirm } from './use-confirm';

const ACK_TIMEOUT_MS = 5000;

/**
 * Every lifecycle helper resolves to this. `result` is the ack's structured
 * payload, kept rather than discarded: a refusal carries the current draft token
 * on `stale-catalog`, the defect list on `validation-failed`, and the blocking
 * references on `referenced` — each the thing the surface needs to recover.
 */
export type LifecycleResult =
  | { readonly status: 'accepted'; readonly result?: unknown }
  | { readonly status: 'rejected'; readonly reason: string; readonly result?: unknown };

/** FR-R4-F05 (I6, I8) — what a catalog editor passes so a late answer reaches it once. */
export type CatalogWriteWait = IntentWaitOptions<LifecycleResult>;

/** The operator closed the confirmation. Nothing was sent. */
export const DECLINED: LifecycleResult = Object.freeze({
  status: 'rejected',
  reason: 'declined'
});

/**
 * A whole-layer write with no rows in it. Nothing was sent.
 *
 * A package addresses definitions by id, so an empty layer says nothing at all —
 * it does not say "remove the rest". Emptying a catalog is now N deactivations,
 * each its own decision (FR-051). Named here rather than left to the host's
 * `invalid-payload`, which would be a true refusal for the wrong reason.
 */
export const EMPTY_LAYER: LifecycleResult = Object.freeze({
  status: 'rejected',
  reason: 'empty-layer'
});

/** Optional test seam, matching the retired save helpers' contract. */
export type PostMessage = (msg: unknown) => void;

const KIND_LABEL: Readonly<Record<CatalogKind, string>> = Object.freeze({
  phase: 'Phase',
  pipeline: 'Pipeline',
  workflow: 'Workflow'
});

/**
 * The write token to quote back for the definition a projection record describes
 * (FR-012).
 *
 * Feature 101 — the three retired save shims each hardcoded `NO_DRAFT` here,
 * which is correct for the first write to a definition and refused as stale for
 * every one after it. The projection now carries the token
 * (`contracts/builder-projection.md` §A.2), already folded by `currentDraftToken`,
 * so this reads it rather than deriving it a second time.
 *
 * `NO_DRAFT` survives as the answer to two honest absences and no others: a row
 * the store has never seen (a draft the operator just created), and a host that
 * resolved a catalog with no store behind it, which projects no `lifecycle` at
 * all (invariant 0). Both mean "there is no draft to be stale against".
 */
export function draftTokenOfRecord(
  record: { readonly lifecycle?: BuilderLifecycle } | undefined
): ExpectedDraftVersion {
  return record?.lifecycle?.expectedDraftVersion ?? NO_DRAFT;
}

/**
 * Post one lifecycle command and resolve with its ack.
 *
 * Carried over from `save-phases.ts`: a five-second timeout that resolves `{ status: 'rejected',
 * reason: 'timeout' }` so a silent host surfaces a recovery affordance instead of a spinner.
 * FR-R4-F05 (I4) — it sends through the intent ledger, so an identical retry of an unresolved
 * operation reuses its identity and payload and the host applies it once. Concurrent different
 * operations never cross-resolve: they are different intents.
 */
function dispatch<C extends SidebarCommand>(
  type: C['type'],
  payload: C extends { payload: infer P } ? P : undefined,
  postMessage?: PostMessage,
  wait: IntentWaitOptions<LifecycleResult> = {}
): Promise<LifecycleResult> {
  const toResult = (ack: AckResult): LifecycleResult => {
    const carried = ack.result !== undefined ? { result: ack.result } : {};
    return ack.status === 'accepted'
      ? { status: 'accepted', ...carried }
      : { status: 'rejected', reason: ack.reason ?? 'rejected', ...carried };
  };
  const { onLateOutcome } = wait;
  return sendIntent({
    type,
    payload,
    post: (correlationId, stored) => {
      if (postMessage) postMessage({ type, correlationId, payload: stored });
      else postCommand(type, stored, { correlationId });
    },
    timeoutMs: ACK_TIMEOUT_MS,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
    ...(onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack: AckResult) => onLateOutcome(toResult(ack)) })
  }).then((result): LifecycleResult =>
    result.kind === 'ack' ? toResult(result.ack) : { status: 'rejected', reason: 'timeout' }
  );
}

// ---------------------------------------------------------------------------
// The four ungated operations
// ---------------------------------------------------------------------------

/** US1 — write a draft. Moves no active pointer, so nothing becomes triggerable. */
export function saveDefinitionDraft(
  request: SaveDraftRequest,
  postMessage?: PostMessage,
  wait?: IntentWaitOptions<LifecycleResult>
): Promise<LifecycleResult> {
  return dispatch(CMD_SAVE_DEFINITION_DRAFT, request, postMessage, wait);
}

/**
 * US2 — the one operation that makes a definition triggerable (FR-013).
 *
 * Ungated on purpose: publishing adds an Active version and removes nothing the
 * operator holds. What it replaces stays readable and restorable.
 */
export function publishDefinition(
  request: PublishRequest,
  postMessage?: PostMessage,
  wait?: IntentWaitOptions<LifecycleResult>
): Promise<LifecycleResult> {
  return dispatch(CMD_PUBLISH_DEFINITION, request, postMessage, wait);
}

/**
 * US3 — copy a past version's body into the draft.
 *
 * Ungated for the same reason as publish, with one addition: restore overwrites
 * the current draft, and *that* loss is gated — by the confirmation on discard,
 * which is the only other way a draft disappears. Asking here as well would ask
 * twice for one decision.
 */
export function restoreDefinitionVersion(
  request: RestoreRequest,
  postMessage?: PostMessage,
  wait?: IntentWaitOptions<LifecycleResult>
): Promise<LifecycleResult> {
  return dispatch(CMD_RESTORE_DEFINITION_VERSION, request, postMessage, wait);
}

/**
 * US5 — one imported document, one confirmation, one ordered publication (FR-035).
 *
 * The confirmation is the import plan the operator already approved, so this
 * helper does not ask again (FR-018 carried forward from feature 084: confirming
 * the plan *is* the consent).
 */
export function publishDefinitionPackage(
  request: PackagePublishRequest,
  postMessage?: PostMessage,
  wait?: IntentWaitOptions<LifecycleResult>
): Promise<LifecycleResult> {
  return dispatch(CMD_PUBLISH_PACKAGE, request, postMessage, wait);
}

// ---------------------------------------------------------------------------
// The two gated operations (FR-049, FR-050)
// ---------------------------------------------------------------------------

/** What the two prompts need beyond the target itself. */
export interface LifecycleConfirmOptions {
  /** Shown in the prompt. The id alone is not what the operator recognises. */
  readonly definitionName: string;
  /** Focus returns here when the dialog closes. */
  readonly originatingElement?: HTMLElement | null;
  /**
   * FR-R4-F05 (I6, I8) — an abort signal and a late-outcome callback for the wait that follows
   * the confirmation.
   */
  readonly wait?: IntentWaitOptions<LifecycleResult>;
}

/**
 * US4 — stop a definition being triggerable.
 *
 * Destructive in the sense the confirmation gate exists for: the operator loses
 * something they hold *inside* the product. Not destructive in the sense of the
 * store — every version survives, and publishing again brings it back — and the
 * prompt says so, because an operator who believes this deletes their history
 * will not use it.
 */
export async function deactivateDefinition(
  request: DeactivateRequest,
  options: LifecycleConfirmOptions,
  postMessage?: PostMessage
): Promise<LifecycleResult> {
  const confirmed = await useConfirm('catalog.deactivate-definition', {
    originatingElement: options.originatingElement ?? null,
    context: {
      kindLabel: KIND_LABEL[request.kind],
      definitionName: options.definitionName,
      definitionId: request.id
    }
  });
  if (!confirmed) return DECLINED;
  return dispatch(CMD_DEACTIVATE_DEFINITION, request, postMessage, options.wait);
}

export interface DiscardDraftConfirmOptions extends LifecycleConfirmOptions {
  /**
   * True when the definition has never been published, so discarding its draft
   * removes the entry outright (FR-030). The operator has to be told which of the
   * two this is: one loses an edit, the other loses the definition.
   */
  readonly removesEntry: boolean;
}

/**
 * US1 — throw away unpublished work.
 *
 * The one lifecycle operation that can destroy content with no version record
 * behind it, which is why it is gated even though it never touches what is live.
 */
export async function discardDefinitionDraft(
  request: DiscardDraftRequest,
  options: DiscardDraftConfirmOptions,
  postMessage?: PostMessage
): Promise<LifecycleResult> {
  const confirmed = await useConfirm('catalog.discard-draft', {
    originatingElement: options.originatingElement ?? null,
    context: {
      kindLabel: KIND_LABEL[request.kind],
      definitionName: options.definitionName,
      definitionId: request.id,
      removesEntry: options.removesEntry
    }
  });
  if (!confirmed) return DECLINED;
  return dispatch(CMD_DISCARD_DEFINITION_DRAFT, request, postMessage, options.wait);
}
