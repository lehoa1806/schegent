// Feature 099 (T493d, FR-042a) — the single place a store outcome becomes an ack.
//
// The three save commands run three different gate tables and then reach the same
// last line: write one complete layer of one kind under one expected revision, and
// tell the operator what happened. Before this feature that line was
// `updateConfig(key, rows, scope)` — a write that either resolved or threw, so each
// handler needed two arms. `saveLayer` returns five, and five arms written three
// times is three chances for `partial` to be reported as success.
//
// The mapping keeps the refusal vocabulary the three handlers already speak
// (T493d); no new reason literal is introduced:
//
//   saved / unchanged → accepted. An unchanged save is a successful save with no
//                       new version — FR-014's whole point is that it is not an
//                       error and manufactures no history.
//   stale             → `stale-catalog`, the same literal the pre-write revision
//                       gate uses. Reaching it here means another window wrote
//                       between that gate and this one, which is the same fact.
//   refused / partial → `persistence-failed`. Neither landed a complete layer and
//                       both are repaired the same way (refresh, then retry), so
//                       they share the literal and differ in the `result` detail.
//
// `partial` deliberately does NOT get a compensating delete or a retry here: the
// records that landed stay on disk, where the next read reports them as
// collectable (FR-026, FR-028, FR-029). Nothing on this path deletes anything.

import type { CatalogStore } from '../../../catalog';
import type {
  CatalogLayerDefinition,
  CatalogLayerSaveOutcome,
  CatalogKind
} from '../../../contracts/catalog-store';
import type { HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';
import {
  auditImportCommitted,
  auditImportRefused,
  type ImportCommitTarget
} from './process-exchange-commit-audit';

export interface CatalogLayerCommit {
  readonly kind: CatalogKind;
  readonly definitions: readonly CatalogLayerDefinition[];
  readonly expectedRevision: string;
  /** Echoed back on the accepted ack, so the surface can confirm what it asked for. */
  readonly mutationKind: string;
  /** The package-import audit target, or `null` for every other mutation. */
  readonly exchange: ImportCommitTarget | null;
}

/**
 * Re-resolve the host's catalogs when this save moved the store (T493b, FR-054).
 *
 * Called for `saved` and `partial` — both changed what is on disk — and for
 * `stale`, where another window changed it and this window's snapshot is provably
 * behind, so the refresh is the same repair the operator is about to be told to
 * perform. `unchanged` and `refused` leave the store byte-identical to the last
 * read and skip it.
 *
 * Never converts a successful save into a rejection: the write landed, and a host
 * that cannot re-read is a stale projection, not a failed save.
 */
async function refreshIfMoved(
  ctx: HandlerContext,
  outcome: CatalogLayerSaveOutcome['outcome']
): Promise<void> {
  if (outcome === 'unchanged' || outcome === 'refused') return;
  if (!ctx.deps.refreshCatalog) return;
  try {
    await ctx.deps.refreshCatalog();
  } catch (error) {
    ctx.deps.logger.warn(
      `catalog refresh after save failed: ${ctx.deps.logger.sanitize((error as Error).message)}`
    );
  }
}

/**
 * Report what retention removed (FR-035) through the runtime log sink and nothing
 * else — no audit event type and no webview message family is added for it
 * (T494b, FR-059, FR-060).
 */
function logPruned(ctx: HandlerContext, outcome: CatalogLayerSaveOutcome): void {
  if (outcome.outcome !== 'saved' || outcome.pruned.length === 0) return;
  for (const entry of outcome.pruned) {
    ctx.deps.logger.debug(
      `catalog retention pruned ${entry.versionIds.length} version(s) of ` +
        `${ctx.deps.logger.sanitize(entry.id).slice(0, 64)}: ${entry.versionIds.join(', ')}`
    );
  }
}

export async function commitCatalogLayer(
  ctx: HandlerContext,
  store: CatalogStore,
  commit: CatalogLayerCommit
): Promise<void> {
  let outcome: CatalogLayerSaveOutcome;
  try {
    outcome = await store.saveLayer({
      kind: commit.kind,
      definitions: commit.definitions,
      expectedRevision: commit.expectedRevision
    });
  } catch (error) {
    // Every store failure is a returned value (FR-029), so reaching here means a
    // defect rather than an I/O outcome. It is still an ack the operator gets.
    ctx.deps.logger.warn(
      `${commit.kind} catalog save failed: ${ctx.deps.logger.sanitize((error as Error).message)}`
    );
    await auditImportRefused(ctx, commit.exchange, 'persistence-failed');
    await ack(ctx, 'rejected', 'persistence-failed');
    return;
  }

  await refreshIfMoved(ctx, outcome.outcome);

  switch (outcome.outcome) {
    case 'saved':
    case 'unchanged': {
      logPruned(ctx, outcome);
      await auditImportCommitted(ctx, commit.exchange);
      await ack(ctx, 'accepted', undefined, {
        revision: outcome.revision,
        mutation: commit.mutationKind
      });
      return;
    }
    case 'stale': {
      await auditImportRefused(ctx, commit.exchange, 'stale-catalog');
      await ack(ctx, 'rejected', 'stale-catalog', {
        currentRevision: outcome.actualRevision
      });
      return;
    }
    case 'refused': {
      ctx.deps.logger.warn(
        `${commit.kind} catalog save refused: ${outcome.reason}`
      );
      await auditImportRefused(ctx, commit.exchange, 'persistence-failed');
      await ack(ctx, 'rejected', 'persistence-failed', {
        storeRefusal: outcome.reason,
        ...(outcome.id !== null
          ? { id: ctx.deps.logger.sanitize(outcome.id).slice(0, 64) }
          : {})
      });
      return;
    }
    case 'partial': {
      // The count, not the labels: `<id>@<versionId>` pairs are the store's own
      // words, but the operator's repair does not depend on which prefix landed.
      ctx.deps.logger.warn(
        `${commit.kind} catalog save landed a prefix and stopped (${outcome.errno}); ` +
          `${outcome.wrote.length} record(s) remain and are collectable`
      );
      await auditImportRefused(ctx, commit.exchange, 'persistence-failed');
      await ack(ctx, 'rejected', 'persistence-failed', {
        partial: true,
        wrote: outcome.wrote.length
      });
      return;
    }
  }

  // Every arm above returns, so `outcome` is `never` here and this assignment
  // compiles only while the switch covers the union. That is the point of it: a
  // sixth arm — FR-R3-016 adds lifecycle outcomes to exactly this contract —
  // would otherwise fall past the switch and return with no ack at all, and a
  // command that never acks is a Builder that waits forever rather than a Builder
  // that reports a failure. Thrown rather than acked here because the router
  // already translates a handler throw into a sanitised rejection ack; a second
  // ack path would be one more thing to keep in step.
  const unhandled: never = outcome;
  throw new Error(`unhandled ${commit.kind} catalog save outcome: ${String(unhandled)}`);
}
