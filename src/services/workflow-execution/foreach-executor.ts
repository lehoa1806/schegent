// FR-R5-F34 (D1, D2, D4, D8, D9, SPEC-12) — Sequential child-Workflow ForEach
// execution engine, slot state machine, and coordinator/recovery helpers.

import { utf8ByteLength } from '../../contracts/decision-results';
import {
  DEFAULT_FOR_EACH_MAX_ITEMS,
  DEFAULT_FOR_EACH_ON_ITEM_ERROR,
  MAX_FOR_EACH_COLLECTION_BYTES,
  MAX_ROOT_CONTROL_DISPATCHES,
  type ForEachControl
} from '../../contracts/workflow-controls';
import type {
  ControlFrame,
  ForEachItemRuntimeSlot,
  ForEachRuntimeState,
  ForEachSlotError,
  ForEachSlotErrorCode,
  RootControlState
} from '../../contracts/control-ledger';
import type { ResolvedPortValue } from '../../contracts/run-request';
import type { WorkflowDefinition, WorkflowNode } from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import {
  attemptsForNode,
  recordNodeAttempt,
  upsertInvocationFrame
} from '../../state/connected-workflow-run';
import { SanitizedLogger } from '../../lib/logger';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';

export interface ControlClock {
  readonly nowWallMs: () => number;
  readonly nowMonotonicMs: () => number;
}
import { createChildWorkflowInvocationFrame } from './connected-run-factory';
import {
  buildForEachDeclaredOutputs,
  buildForEachItemInputEnvelope,
  buildOrderedResultIndex,
  extractCollectionPayloadFromParentFrame,
  pauseParentFrameOnForEach,
  prepareForEachItemFrames,
  readAndValidateForEachCollection,
  resolveFrozenForEachControl,
  type BuildOrderedResultIndexResult,
  type FrozenForEachCollection,
  type OrderedForEachResultIndex,
  type OrderedForEachResultSlot,
  type ReadForEachCollectionInput,
  type ResolvedFrozenForEachControl
} from './foreach-collection-reader';
import { resolveChildPassDecisionResults } from './repeat-executor';

export {
  buildForEachDeclaredOutputs,
  buildForEachItemInputEnvelope,
  buildOrderedResultIndex,
  extractCollectionPayloadFromParentFrame,
  pauseParentFrameOnForEach,
  prepareForEachItemFrames,
  readAndValidateForEachCollection,
  resolveFrozenForEachControl,
  type BuildOrderedResultIndexResult,
  type FrozenForEachCollection,
  type OrderedForEachResultIndex,
  type OrderedForEachResultSlot,
  type ReadForEachCollectionInput,
  type ResolvedFrozenForEachControl
};

const DEFAULT_SANITIZER = new SanitizedLogger();
const MAX_SLOT_ERROR_MESSAGE_BYTES = 512;

export type ForEachCrashPoint =
  | 'after-collection-freeze'
  | 'after-child-admission'
  | 'after-child-settlement'
  | 'after-slot-commit'
  | 'after-item-advance'
  | 'before-final-export';

export function buildForEachFrameKey(parentInvocationId: string, nodeId: string): string {
  return `${parentInvocationId}:for-each:${nodeId}`;
}

function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (utf8ByteLength(input) <= maxBytes) return input;
  let end = Math.min(input.length, maxBytes);
  while (end > 0 && utf8ByteLength(input.slice(0, end)) > maxBytes) end -= 1;
  return input.slice(0, end);
}

export function sanitizeAndBoundSlotErrorMessage(rawMessage: string): string {
  const sanitized = DEFAULT_SANITIZER.sanitize(rawMessage).trim();
  const nonEmpty = sanitized.length > 0 ? sanitized : 'Child workflow item failed.';
  return truncateUtf8Bytes(nonEmpty, MAX_SLOT_ERROR_MESSAGE_BYTES);
}

const AUTHORITATIVE_HOST_OR_UNCERTAINTY_CODES: ReadonlySet<string> = new Set([
  'cancelled',
  'canceled',
  'manual-pause',
  'trust-denied',
  'uncertain-effect',
  'uncertain-effects',
  'invalid-evidence',
  'spend-limit',
  'spend-limit-reached',
  'spend-unverifiable',
  'wall-clock-timeout'
]);

export function isAuthoritativeHostOrUncertaintyCode(code: string | undefined): boolean {
  return code !== undefined && AUTHORITATIVE_HOST_OR_UNCERTAINTY_CODES.has(code);
}

export interface InitializeForEachFrameInput {
  readonly rootRunId: string;
  readonly parentInvocationId: string;
  readonly parentWorkflowId: string;
  readonly nodeId: string;
  readonly frameKey?: string | undefined;
  readonly parentFrameKey?: string | null | undefined;
  readonly control: ForEachControl;
  readonly collection?: FrozenForEachCollection | undefined;
  readonly collectionReaderInput?: Omit<ReadForEachCollectionInput, 'control'> | undefined;
  readonly firstChildInvocationId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onCrashPoint?: ((point: ForEachCrashPoint) => Promise<void> | void) | undefined;
}

export type InitializeForEachFrameOutcome =
  | {
      readonly ok: true;
      readonly action: 'completed-empty';
      readonly frame: ControlFrame;
      readonly collection: FrozenForEachCollection;
      readonly resultIndex: OrderedForEachResultIndex;
      readonly resultIndexJson: string;
      readonly resultIndexRef: string;
    }
  | {
      readonly ok: true;
      readonly action: 'executing-item';
      readonly itemIndex: number;
      readonly itemKey: string;
      readonly itemCanonicalJson: string;
      readonly childInvocationId?: string;
      readonly frame: ControlFrame;
      readonly collection: FrozenForEachCollection;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly frame?: ControlFrame;
    };

export interface SettleForEachItemInput {
  readonly rootRunId: string;
  readonly parentInvocationId: string;
  readonly nodeId: string;
  readonly frameKey?: string | undefined;
  readonly itemIndex: number;
  readonly childInvocationId: string;
  readonly childStatus: 'completed' | 'failed' | 'canceled' | 'paused';
  readonly childFailureCode?: string | undefined;
  readonly childFailureMessage?: string | undefined;
  readonly childResultValid?: boolean | undefined;
  readonly childResultRef?: string | undefined;
  readonly nextChildInvocationId?: string | undefined;
  readonly outputsByItemIndex?: Readonly<Record<number, Readonly<Record<string, string>>>> | undefined;
  readonly forcedAggregateOverflowBytes?: number | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onCrashPoint?: ((point: ForEachCrashPoint) => Promise<void> | void) | undefined;
}

export type SettleForEachItemOutcome =
  | {
      readonly ok: true;
      readonly action: 'advance-item';
      readonly nextItemIndex: number;
      readonly nextItemKey: string;
      readonly nextItemCanonicalJson: string;
      readonly nextChildInvocationId?: string;
      readonly frame: ControlFrame;
    }
  | {
      readonly ok: true;
      readonly action: 'completed';
      readonly hasErrors: boolean;
      readonly errorCount: number;
      readonly resultIndex: OrderedForEachResultIndex;
      readonly resultIndexJson: string;
      readonly resultIndexRef: string;
      readonly frame: ControlFrame;
    }
  | { readonly ok: true; readonly action: 'paused'; readonly pauseCause: string; readonly frame: ControlFrame }
  | { readonly ok: true; readonly action: 'failed'; readonly failureCode: string; readonly frame: ControlFrame }
  | { readonly ok: true; readonly action: 'canceled'; readonly frame: ControlFrame }
  | { readonly ok: false; readonly code: string; readonly message: string };

export class ForEachExecutor {
  private readonly ledgerStore: ControlLedgerStore;
  private readonly clock: ControlClock;

  public constructor(deps: {
    readonly ledgerStore: ControlLedgerStore;
    readonly clock?: ControlClock | undefined;
  }) {
    this.ledgerStore = deps.ledgerStore;
    this.clock = deps.clock ?? {
      nowWallMs: () => Date.now(),
      nowMonotonicMs: () => performance.now()
    };
  }

  public getLedgerStore(): ControlLedgerStore {
    return this.ledgerStore;
  }

  private async upsertFrame(
    ledgerRunId: string,
    frameKey: string,
    buildFrame: (existing: ControlFrame | undefined, nowWallMs: number) => ControlFrame
  ): Promise<{ readonly ok: boolean; readonly frame?: ControlFrame; readonly message?: string }> {
    const nowWallMs = this.clock.nowWallMs();
    let committedFrame: ControlFrame | undefined;
    const res = await this.ledgerStore.mutate<RootControlState>(
      { targetRootId: ledgerRunId },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, ledgerRunId);
        if (root === undefined) {
          return { commit: false, code: 'control-root-not-found', message: `Root '${ledgerRunId}' not found.` };
        }
        committedFrame = buildFrame(lookupRecord(root.framesByKey, frameKey), nowWallMs);
        const nextRoot: RootControlState = {
          ...root,
          updatedAt: nowWallMs,
          framesByKey: { ...root.framesByKey, [frameKey]: committedFrame }
        };
        return {
          commit: true,
          plan: {
            targetRootId: ledgerRunId,
            nextLedger: { ...ledger, roots: { ...ledger.roots, [ledgerRunId]: nextRoot } },
            result: nextRoot
          }
        };
      }
    );
    if (!res.ok) return { ok: false, message: res.message };
    if (committedFrame === undefined) return { ok: false };
    return { ok: true, frame: committedFrame };
  }

  private async patchFrame(
    rootRunId: string,
    frameKey: string,
    fallback: ControlFrame,
    framePatch: Partial<ControlFrame>,
    fePatch?: Partial<ForEachRuntimeState>,
    bumpGeneration = true
  ): Promise<ControlFrame> {
    const res = await this.upsertFrame(rootRunId, frameKey, (curr, nowWallMs) => {
      const base = curr ?? fallback;
      const baseFe = base.forEachState ?? fallback.forEachState;
      return {
        ...base,
        ...framePatch,
        updatedAt: nowWallMs,
        ...(framePatch.status === 'completed' || framePatch.status === 'failed' || framePatch.status === 'canceled'
          ? { completedAt: nowWallMs }
          : {}),
        frameGeneration: bumpGeneration ? (base.frameGeneration ?? 1) + 1 : (base.frameGeneration ?? 1),
        ...(baseFe !== undefined
          ? { forEachState: { ...baseFe, ...(fePatch ?? {}) } }
          : {})
      };
    });
    return res.frame ?? fallback;
  }

  private async readRecoveredOutcome(
    existingFrame: ControlFrame,
    workspaceRoot?: string
  ): Promise<InitializeForEachFrameOutcome | null> {
    const feState = existingFrame.forEachState;
    if (feState === undefined) return null;
    const itemCount = feState.itemCount ?? feState.totalItems;
    if (itemCount === 0 && existingFrame.status === 'completed') {
      const emptyIdx = await buildOrderedResultIndex({
        collectionRef: feState.collectionRef ?? 'fe-col-empty',
        collectionSha256: feState.collectionSha256 ?? '',
        slots: [],
        workspaceRoot,
        persistArtifact: false
      });
      if (!emptyIdx.ok) return null;
      return {
        ok: true,
        action: 'completed-empty',
        frame: existingFrame,
        collection: Object.freeze({
          version: 1,
          collectionRef: feState.collectionRef ?? 'fe-col-empty',
          collectionSha256: feState.collectionSha256 ?? '',
          sourceBytes: 0,
          itemCount: 0,
          items: Object.freeze([])
        }),
        resultIndex: emptyIdx.resultIndex,
        resultIndexJson: emptyIdx.resultIndexJson,
        resultIndexRef: feState.resultIndexRef ?? emptyIdx.resultIndexRef
      };
    }
    const curIdx = feState.currentIndex;
    const curSlot = feState.slots.at(curIdx);
    const curJson = feState.frozenItemsJson?.at(curIdx) ?? '{}';
    if (curSlot === undefined) return null;
    const childInvocationId = curSlot.invocationId ?? curSlot.childInvocationId;
    return {
      ok: true,
      action: 'executing-item',
      itemIndex: curIdx,
      itemKey: curSlot.itemKey,
      itemCanonicalJson: curJson,
      ...(childInvocationId !== undefined ? { childInvocationId } : {}),
      frame: existingFrame,
      collection: Object.freeze({
        version: 1,
        collectionRef: feState.collectionRef ?? 'fe-col-recovered',
        collectionSha256: feState.collectionSha256 ?? '',
        sourceBytes: 0,
        itemCount,
        items: Object.freeze(
          feState.slots.map((s, idx) =>
            Object.freeze({
              index: idx,
              itemKey: s.itemKey,
              itemObject: Object.freeze({}),
              canonicalJson: feState.frozenItemsJson?.at(idx) ?? '{}',
              byteLength: utf8ByteLength(feState.frozenItemsJson?.at(idx) ?? '{}')
            })
          )
        )
      })
    };
  }

  public async initializeForEachFrame(
    input: InitializeForEachFrameInput
  ): Promise<InitializeForEachFrameOutcome> {
    const frameKey = input.frameKey ?? buildForEachFrameKey(input.parentInvocationId, input.nodeId);
    const onItemError = input.control.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR;

    const loadedExisting = this.ledgerStore.read();
    if (loadedExisting.ok) {
      const existingRoot = lookupRecord(loadedExisting.ledger.roots, input.rootRunId);
      const existingFrame = existingRoot !== undefined ? lookupRecord(existingRoot.framesByKey, frameKey) : undefined;
      if (existingFrame !== undefined) {
        const recovered = await this.readRecoveredOutcome(existingFrame, input.workspaceRoot);
        if (recovered !== null) return recovered;
      }
    }

    let collection: FrozenForEachCollection;
    if (input.collection !== undefined) {
      collection = input.collection;
    } else {
      const readRes = await readAndValidateForEachCollection({
        control: input.control,
        ...(input.collectionReaderInput ?? {}),
        ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
        nodeId: input.nodeId,
        invocationId: input.parentInvocationId
      });
      if (!readRes.ok) return { ok: false, code: readRes.code, message: readRes.message };
      collection = readRes.collection;
    }

    if (collection.itemCount === 0) {
      const emptyIdx = await buildOrderedResultIndex({
        collectionRef: collection.collectionRef,
        collectionSha256: collection.collectionSha256,
        slots: [],
        workspaceRoot: input.workspaceRoot
      });
      if (!emptyIdx.ok) return { ok: false, code: emptyIdx.code, message: emptyIdx.message };
      const mutatedEmpty = await this.upsertFrame(input.rootRunId, frameKey, (_existing, nowWallMs) => ({
        frameKey,
        parentFrameKey: input.parentFrameKey ?? input.parentInvocationId,
        invocationId: input.parentInvocationId,
        workflowId: input.parentWorkflowId,
        nodeId: input.nodeId,
        kind: 'for-each',
        status: 'completed',
        createdAt: nowWallMs,
        updatedAt: nowWallMs,
        completedAt: nowWallMs,
        dispatchedCount: 0,
        maxDispatches: input.control.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS,
        frameGeneration: 1,
        forEachState: {
          collectionRef: collection.collectionRef,
          collectionSha256: collection.collectionSha256,
          itemCount: 0,
          totalItems: 0,
          currentIndex: 0,
          hasErrors: false,
          errorCount: 0,
          onItemError,
          resultIndexRef: emptyIdx.resultIndexRef,
          resultIndexJson: emptyIdx.resultIndexJson,
          ...(emptyIdx.artifactRelativePath !== undefined ? { resultIndexArtifactPath: emptyIdx.artifactRelativePath } : {}),
          frozenItemsJson: Object.freeze([]),
          slots: Object.freeze([])
        }
      }));
      if (!mutatedEmpty.ok || mutatedEmpty.frame === undefined) {
        return { ok: false, code: 'ledger-mutation-failed', message: mutatedEmpty.message ?? 'Failed to initialize empty ForEach frame.' };
      }
      if (input.onCrashPoint !== undefined) await input.onCrashPoint('after-collection-freeze');
      return {
        ok: true,
        action: 'completed-empty',
        frame: mutatedEmpty.frame,
        collection,
        resultIndex: emptyIdx.resultIndex,
        resultIndexJson: emptyIdx.resultIndexJson,
        resultIndexRef: emptyIdx.resultIndexRef
      };
    }

    const loadedBeforeFirst = this.ledgerStore.read();
    if (loadedBeforeFirst.ok) {
      const rootBeforeFirst = lookupRecord(loadedBeforeFirst.ledger.roots, input.rootRunId);
      if (rootBeforeFirst !== undefined) {
        const maxRootAttempts = rootBeforeFirst.rootBudget.maxPhaseAttempts || MAX_ROOT_CONTROL_DISPATCHES;
        if (rootBeforeFirst.dispatchedAttempts >= maxRootAttempts) {
          return {
            ok: false,
            code: 'dispatch-budget-exhausted',
            message: `Root dispatch budget (${maxRootAttempts}) exhausted before ForEach item 0.`
          };
        }
      }
    }

    const initialSlots: ForEachItemRuntimeSlot[] = collection.items.map((item, idx) => {
      const isFirst = idx === 0;
      return Object.freeze({
        index: idx,
        itemIndex: idx,
        itemKey: item.itemKey,
        state: isFirst ? ('executing' as const) : ('pending' as const),
        status: isFirst ? ('in-flight' as const) : ('pending' as const),
        ...(isFirst && input.firstChildInvocationId !== undefined
          ? { invocationId: input.firstChildInvocationId, childInvocationId: input.firstChildInvocationId }
          : {})
      });
    });

    const frozenItemsJson = Object.freeze(collection.items.map((item) => item.canonicalJson));
    const mutated = await this.upsertFrame(input.rootRunId, frameKey, (_existing, nowWallMs) => ({
      frameKey,
      parentFrameKey: input.parentFrameKey ?? input.parentInvocationId,
      invocationId: input.parentInvocationId,
      workflowId: input.parentWorkflowId,
      nodeId: input.nodeId,
      kind: 'for-each',
      status: 'in-flight',
      createdAt: nowWallMs,
      updatedAt: nowWallMs,
      dispatchedCount: 1,
      maxDispatches: input.control.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS,
      frameGeneration: 1,
      forEachState: {
        collectionRef: collection.collectionRef,
        collectionSha256: collection.collectionSha256,
        itemCount: collection.itemCount,
        totalItems: collection.itemCount,
        currentIndex: 0,
        hasErrors: false,
        errorCount: 0,
        onItemError,
        frozenItemsJson,
        slots: Object.freeze(initialSlots)
      }
    }));
    if (!mutated.ok || mutated.frame === undefined) {
      return { ok: false, code: 'ledger-mutation-failed', message: mutated.message ?? 'Failed to initialize ForEach frame.' };
    }
    if (input.onCrashPoint !== undefined) {
      await input.onCrashPoint('after-collection-freeze');
      await input.onCrashPoint('after-child-admission');
    }
    const firstItem = collection.items.at(0);
    return {
      ok: true,
      action: 'executing-item',
      itemIndex: 0,
      itemKey: firstItem?.itemKey ?? '0',
      itemCanonicalJson: firstItem?.canonicalJson ?? '{}',
      ...(input.firstChildInvocationId !== undefined ? { childInvocationId: input.firstChildInvocationId } : {}),
      frame: mutated.frame,
      collection
    };
  }

  public async settleForEachItem(
    input: SettleForEachItemInput
  ): Promise<SettleForEachItemOutcome> {
    const frameKey = input.frameKey ?? buildForEachFrameKey(input.parentInvocationId, input.nodeId);
    const loaded = this.ledgerStore.read();
    if (!loaded.ok) return { ok: false, code: 'ledger-read-failed', message: 'Failed to read control ledger.' };
    const root = lookupRecord(loaded.ledger.roots, input.rootRunId);
    if (root === undefined) return { ok: false, code: 'control-root-not-found', message: `Root '${input.rootRunId}' not found.` };
    const existingFrame = lookupRecord(root.framesByKey, frameKey);
    if (existingFrame?.forEachState === undefined) {
      return { ok: false, code: 'for-each-frame-not-found', message: `ForEach frame '${frameKey}' not found.` };
    }
    const feState = existingFrame.forEachState;
    const itemCount = feState.itemCount ?? feState.totalItems;
    const onItemError = feState.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR;

    if (input.onCrashPoint !== undefined) await input.onCrashPoint('after-child-settlement');
    const currentSlot = feState.slots.at(input.itemIndex);
    if (currentSlot === undefined) {
      return { ok: false, code: 'invalid-item-index', message: `ForEach slot ${input.itemIndex} does not exist.` };
    }

    if (
      input.childStatus === 'canceled' ||
      input.childFailureCode === 'cancelled' ||
      input.childFailureCode === 'canceled'
    ) {
      const frame = await this.patchFrame(input.rootRunId, frameKey, existingFrame, { status: 'canceled' });
      return { ok: true, action: 'canceled', frame };
    }

    if (
      input.childStatus === 'paused' ||
      isAuthoritativeHostOrUncertaintyCode(input.childFailureCode)
    ) {
      const pauseCause = input.childFailureCode ?? 'manual-pause';
      const frame = await this.patchFrame(input.rootRunId, frameKey, existingFrame, {
        status: 'paused',
        pauseCause,
        failureCode: pauseCause
      });
      return { ok: true, action: 'paused', pauseCause, frame };
    }

    const isSlotSuccess = input.childStatus === 'completed' && input.childResultValid !== false;
    let slotError: ForEachSlotError | undefined;
    if (!isSlotSuccess) {
      const errCode: ForEachSlotErrorCode =
        input.childResultValid === false ||
        input.childFailureCode === 'invalid-child-result' ||
        input.childFailureCode === 'invalid-child-decision-results'
          ? 'invalid-child-result'
          : input.childFailureCode === 'dispatch-budget-exhausted' ||
              input.childFailureCode === 'root-attempt-cap-reached'
            ? 'dispatch-budget-exhausted'
            : 'child-failed';
      slotError = Object.freeze({
        code: errCode,
        message: sanitizeAndBoundSlotErrorMessage(
          input.childFailureMessage ?? `Child workflow '${input.childInvocationId}' failed with '${errCode}'.`
        )
      });
    }

    const resultRef = input.childResultRef ?? (isSlotSuccess ? `fe-res-${input.childInvocationId}` : undefined);
    const updatedCurrentSlot: ForEachItemRuntimeSlot = Object.freeze({
      ...currentSlot,
      index: input.itemIndex,
      itemIndex: input.itemIndex,
      invocationId: input.childInvocationId,
      childInvocationId: input.childInvocationId,
      state: isSlotSuccess ? ('completed' as const) : ('failed' as const),
      status: isSlotSuccess ? ('completed' as const) : ('failed' as const),
      ...(resultRef !== undefined ? { resultRef } : {}),
      ...(slotError !== undefined ? { error: slotError, failureCode: slotError.code } : {})
    });

    const slotsAfterCommit = feState.slots.map((s, idx) => (idx === input.itemIndex ? updatedCurrentSlot : s));
    const errorCountAfterCommit = slotsAfterCommit.filter(
      (s) => s.state === 'failed' || s.status === 'failed'
    ).length;
    const hasErrorsAfterCommit = errorCountAfterCommit > 0;

    if (!isSlotSuccess && onItemError === 'stop') {
      const failCode = slotError?.code ?? 'child-failed';
      const frame = await this.patchFrame(
        input.rootRunId,
        frameKey,
        existingFrame,
        { status: 'failed', failureCode: failCode },
        {
          hasErrors: true,
          errorCount: errorCountAfterCommit,
          refusalCode: failCode,
          slots: Object.freeze(slotsAfterCommit)
        }
      );
      if (input.onCrashPoint !== undefined) await input.onCrashPoint('after-slot-commit');
      return { ok: true, action: 'failed', failureCode: failCode, frame };
    }

    const frameAfterSlotCommit = await this.patchFrame(
      input.rootRunId,
      frameKey,
      existingFrame,
      {},
      {
        hasErrors: hasErrorsAfterCommit,
        errorCount: errorCountAfterCommit,
        slots: Object.freeze(slotsAfterCommit)
      },
      false
    );
    if (input.onCrashPoint !== undefined) await input.onCrashPoint('after-slot-commit');

    const nextItemIndex = input.itemIndex + 1;
    if (nextItemIndex < itemCount) {
      const strictMaxMicrousd = root.rootBudget.strictUsdBudget?.limitMicrousd ?? root.rootBudget.maxMicrousd;
      const isStrictUsd =
        root.rootBudget.strictUsdBudget?.mode === 'strict-usd' ||
        root.rootBudget.budgetMode === 'strict-usd';
      if (
        isStrictUsd &&
        strictMaxMicrousd !== undefined &&
        root.settledMicrousd + root.reservedMicrousd >= strictMaxMicrousd
      ) {
        const frame = await this.patchFrame(
          input.rootRunId,
          frameKey,
          frameAfterSlotCommit,
          { status: 'paused', pauseCause: 'spend-limit-reached', failureCode: 'spend-limit-reached' },
          { refusalCode: 'spend-limit-reached', slots: Object.freeze(slotsAfterCommit) }
        );
        return { ok: true, action: 'paused', pauseCause: 'spend-limit-reached', frame };
      }

      const maxRootAttempts = root.rootBudget.maxPhaseAttempts || MAX_ROOT_CONTROL_DISPATCHES;
      if (root.dispatchedAttempts >= maxRootAttempts) {
        const budgetErr: ForEachSlotError = Object.freeze({
          code: 'dispatch-budget-exhausted',
          message: `Root dispatch cap (${maxRootAttempts}) exhausted before item ${nextItemIndex}.`
        });
        const slotsWithExhausted = slotsAfterCommit.map((s, idx) =>
          idx === nextItemIndex
            ? Object.freeze({
                ...s,
                state: 'failed' as const,
                status: 'failed' as const,
                error: budgetErr,
                failureCode: 'dispatch-budget-exhausted'
              })
            : s
        );
        const frame = await this.patchFrame(
          input.rootRunId,
          frameKey,
          frameAfterSlotCommit,
          { status: 'failed', failureCode: 'dispatch-budget-exhausted' },
          {
            currentIndex: nextItemIndex,
            hasErrors: true,
            errorCount: errorCountAfterCommit + 1,
            refusalCode: 'dispatch-budget-exhausted',
            slots: Object.freeze(slotsWithExhausted)
          }
        );
        return { ok: true, action: 'failed', failureCode: 'dispatch-budget-exhausted', frame };
      }

      const slotsAdvanced = slotsAfterCommit.map((s, idx) =>
        idx === nextItemIndex
          ? Object.freeze({
              ...s,
              state: 'executing' as const,
              status: 'in-flight' as const,
              ...(input.nextChildInvocationId !== undefined
                ? { invocationId: input.nextChildInvocationId, childInvocationId: input.nextChildInvocationId }
                : {})
            })
          : s
      );
      const frame = await this.patchFrame(
        input.rootRunId,
        frameKey,
        frameAfterSlotCommit,
        { status: 'in-flight', dispatchedCount: frameAfterSlotCommit.dispatchedCount + 1 },
        {
          currentIndex: nextItemIndex,
          hasErrors: hasErrorsAfterCommit,
          errorCount: errorCountAfterCommit,
          slots: Object.freeze(slotsAdvanced)
        }
      );
      if (input.onCrashPoint !== undefined) await input.onCrashPoint('after-item-advance');
      const nextSlot = slotsAdvanced.at(nextItemIndex);
      const nextCanonicalJson = feState.frozenItemsJson?.at(nextItemIndex) ?? '{}';
      return {
        ok: true,
        action: 'advance-item',
        nextItemIndex,
        nextItemKey: nextSlot?.itemKey ?? String(nextItemIndex),
        nextItemCanonicalJson: nextCanonicalJson,
        ...(input.nextChildInvocationId !== undefined ? { nextChildInvocationId: input.nextChildInvocationId } : {}),
        frame
      };
    }

    if (input.onCrashPoint !== undefined) await input.onCrashPoint('before-final-export');
    const builtIndex =
      input.forcedAggregateOverflowBytes !== undefined &&
      input.forcedAggregateOverflowBytes > MAX_FOR_EACH_COLLECTION_BYTES
        ? ({
            ok: false as const,
            code: 'aggregate-result-too-large' as const,
            byteLength: input.forcedAggregateOverflowBytes,
            message: `Ordered ForEach result index (${input.forcedAggregateOverflowBytes} bytes) exceeds ${MAX_FOR_EACH_COLLECTION_BYTES}-byte limit.`
          })
        : await buildOrderedResultIndex({
            collectionRef: feState.collectionRef ?? 'fe-col',
            collectionSha256: feState.collectionSha256 ?? '',
            slots: slotsAfterCommit,
            outputsByItemIndex: input.outputsByItemIndex,
            workspaceRoot: input.workspaceRoot
          });

    if (!builtIndex.ok) {
      const frame = await this.patchFrame(
        input.rootRunId,
        frameKey,
        frameAfterSlotCommit,
        { status: 'paused', pauseCause: 'aggregate-result-too-large', failureCode: 'aggregate-result-too-large' },
        {
          hasErrors: hasErrorsAfterCommit,
          errorCount: errorCountAfterCommit,
          refusalCode: 'aggregate-result-too-large',
          slots: Object.freeze(slotsAfterCommit)
        }
      );
      return { ok: true, action: 'paused', pauseCause: 'aggregate-result-too-large', frame };
    }

    const frame = await this.patchFrame(
      input.rootRunId,
      frameKey,
      frameAfterSlotCommit,
      { status: 'completed' },
      {
        hasErrors: builtIndex.resultIndex.hasErrors,
        errorCount: builtIndex.resultIndex.errorCount,
        resultIndexRef: builtIndex.resultIndexRef,
        resultIndexJson: builtIndex.resultIndexJson,
        ...(builtIndex.artifactRelativePath !== undefined ? { resultIndexArtifactPath: builtIndex.artifactRelativePath } : {}),
        slots: Object.freeze(slotsAfterCommit)
      }
    );

    return {
      ok: true,
      action: 'completed',
      hasErrors: builtIndex.resultIndex.hasErrors,
      errorCount: builtIndex.resultIndex.errorCount,
      resultIndex: builtIndex.resultIndex,
      resultIndexJson: builtIndex.resultIndexJson,
      resultIndexRef: builtIndex.resultIndexRef,
      frame
    };
  }
}

export async function handleForEachChildSettlement(input: {
  readonly run: ConnectedWorkflowRun;
  readonly parentFrame: WorkflowInvocationFrame;
  readonly parentWorkflow: WorkflowDefinition;
  readonly parentNode: WorkflowNode;
  readonly childFrame: WorkflowInvocationFrame;
  readonly childStatus: 'completed' | 'failed' | 'canceled' | 'paused';
  readonly childFailureCode?: string | undefined;
  readonly childFailureMessage?: string | undefined;
  readonly completedAt: number;
  readonly forEachExecutor?: ForEachExecutor | undefined;
  readonly ledgerStore?: ControlLedgerStore | undefined;
  readonly clock?: ControlClock | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onCrashPoint?: ((point: ForEachCrashPoint) => Promise<void> | void) | undefined;
}): Promise<
  | { readonly action: 'not-for-each' }
  | {
      readonly action: 'completed';
      readonly nextRun: ConnectedWorkflowRun;
      readonly nextParentFrame: WorkflowInvocationFrame;
      readonly parentAttempt: NodeAttemptRecord;
      readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
    }
  | {
      readonly action: 'advance-item';
      readonly nextRun: ConnectedWorkflowRun;
      readonly childInvocationId: string;
      readonly childEntryNodeId: string;
    }
  | {
      readonly action: 'paused';
      readonly nextRun: ConnectedWorkflowRun;
      readonly pauseCause: string;
    }
  | {
      readonly action: 'failed';
      readonly nextRun: ConnectedWorkflowRun;
      readonly settledParentFrame: WorkflowInvocationFrame;
      readonly failureCode: string;
    }
  | { readonly action: 'canceled' }
> {
  const resolved = resolveFrozenForEachControl(
    input.run,
    input.parentWorkflow,
    input.parentNode,
    input.parentFrame
  );
  if (!resolved.ok) return { action: 'not-for-each' };

  const parentAttempts = attemptsForNode(input.parentFrame, input.parentNode.nodeId);
  const latestParentAttempt = parentAttempts.at(-1);
  if (latestParentAttempt === undefined) return { action: 'not-for-each' };

  const executor =
    input.forEachExecutor ??
    (input.ledgerStore !== undefined
      ? new ForEachExecutor({ ledgerStore: input.ledgerStore, clock: input.clock })
      : undefined);
  if (executor === undefined) return { action: 'not-for-each' };

  const ledgerRunId = input.run.controlState?.ledgerRunId ?? input.run.connectedRunId;
  const loaded = executor.getLedgerStore().read();
  const ledgerRoot = loaded.ok ? lookupRecord(loaded.ledger.roots, ledgerRunId) : undefined;

  const itemIndex = Math.max(0, latestParentAttempt.attemptIndex - 1);
  let childResultValid = true;
  if (input.childStatus === 'completed' && resolved.childWorkflow.decisionResults !== undefined) {
    const decisionRes = resolveChildPassDecisionResults({
      childWorkflow: resolved.childWorkflow,
      childFrame: input.childFrame,
      ledgerRoot
    });
    if (!decisionRes.ok) childResultValid = false;
  }

  const nextAttemptNumber = itemIndex + 2;
  const nextParentAttemptId = `${input.parentFrame.invocationId}:${input.parentNode.nodeId}:attempt-${nextAttemptNumber}`;
  const previewNextChild = createChildWorkflowInvocationFrame({
    parentFrame: input.parentFrame,
    callNodeId: input.parentNode.nodeId,
    parentAttemptId: nextParentAttemptId,
    childWorkflow: resolved.childWorkflow,
    boundInputs: input.childFrame.boundInputs,
    startedAt: input.completedAt
  });

  const settled = await executor.settleForEachItem({
    rootRunId: ledgerRunId,
    parentInvocationId: input.parentFrame.invocationId,
    nodeId: input.parentNode.nodeId,
    itemIndex,
    childInvocationId: input.childFrame.invocationId,
    childStatus: input.childStatus,
    childFailureCode: input.childFailureCode,
    childFailureMessage: input.childFailureMessage,
    childResultValid,
    nextChildInvocationId: previewNextChild.invocationId,
    workspaceRoot: input.workspaceRoot,
    onCrashPoint: input.onCrashPoint
  });

  if (!settled.ok) {
    return { action: 'failed', nextRun: input.run, settledParentFrame: input.parentFrame, failureCode: settled.code };
  }
  if (settled.action === 'canceled') return { action: 'canceled' };
  if (settled.action === 'paused') {
    const parentWithPaused = recordNodeAttempt(
      input.parentFrame,
      Object.freeze({
        ...latestParentAttempt,
        status: 'paused',
        completedAt: input.completedAt,
        failureCode: settled.pauseCause,
        declaredOutputs: Object.freeze({})
      })
    );
    const pausedRun = pauseParentFrameOnForEach(
      input.run,
      parentWithPaused,
      input.parentNode.nodeId,
      input.completedAt,
      settled.pauseCause
    );
    return { action: 'paused', nextRun: pausedRun, pauseCause: settled.pauseCause };
  }
  if (settled.action === 'failed') {
    const settledParentFrame = recordNodeAttempt(
      input.parentFrame,
      Object.freeze({
        ...latestParentAttempt,
        status: 'failed',
        completedAt: input.completedAt,
        failureCode: settled.failureCode,
        declaredOutputs: Object.freeze({})
      })
    );
    return {
      action: 'failed',
      nextRun: upsertInvocationFrame(input.run, settledParentFrame),
      settledParentFrame,
      failureCode: settled.failureCode
    };
  }
  if (settled.action === 'completed') {
    const declaredOutputs = buildForEachDeclaredOutputs({
      parentWorkflow: input.parentWorkflow,
      nodeId: input.parentNode.nodeId,
      resultIndexJson: settled.resultIndexJson
    });
    const completedParentAttempt: NodeAttemptRecord = Object.freeze({
      ...latestParentAttempt,
      status: 'completed',
      completedAt: input.completedAt,
      declaredOutputs
    });
    const nextParentFrame = recordNodeAttempt(input.parentFrame, completedParentAttempt);
    return {
      action: 'completed',
      nextRun: upsertInvocationFrame(input.run, nextParentFrame),
      nextParentFrame,
      parentAttempt: completedParentAttempt,
      declaredOutputs
    };
  }

  const parentWithSettledItem = recordNodeAttempt(
    input.parentFrame,
    Object.freeze({
      ...latestParentAttempt,
      status: input.childStatus === 'completed' && childResultValid ? 'completed' : 'failed',
      completedAt: input.completedAt,
      declaredOutputs: Object.freeze({})
    })
  );
  const runWithSettled = upsertInvocationFrame(input.run, parentWithSettledItem);
  const firstAttemptInputs =
    parentAttempts.at(0)?.inputEnvelope.inputsByPort ?? input.childFrame.boundInputs;
  const prepared = prepareForEachItemFrames({
    run: runWithSettled,
    parentFrame: parentWithSettledItem,
    node: input.parentNode,
    childWorkflow: resolved.childWorkflow,
    itemIndex: settled.nextItemIndex,
    itemInputPortId: resolved.control.itemInputPortId,
    itemCanonicalJson: settled.nextItemCanonicalJson,
    baseInputsByPort: firstAttemptInputs,
    startedAt: input.completedAt
  });
  if (prepared === null) {
    return {
      action: 'failed',
      nextRun: runWithSettled,
      settledParentFrame: parentWithSettledItem,
      failureCode: 'invalid-entry-node'
    };
  }
  return {
    action: 'advance-item',
    nextRun: prepared.nextRun,
    childInvocationId: prepared.childFrame.invocationId,
    childEntryNodeId: prepared.childEntryNodeId
  };
}
