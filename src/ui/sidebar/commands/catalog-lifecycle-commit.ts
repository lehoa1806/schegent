// Feature 100 (FR-R3-016) T508a — the single place a lifecycle outcome becomes an ack.
//
// This is `catalog-layer-commit.ts`'s successor. That module mapped five arms of
// one store outcome; this maps eight arms across five operations, and the reason it
// is still one module is the same: eight arms written five times is five chances
// for `partial` to be reported as success.
//
// **The refusal vocabulary carried over from the three deleted save commands**
// (T509, FR-047). Nothing is lost on the way out:
//
//   config-ops-unavailable  → kept, for a window with no store, or an untrusted
//                             workspace where no catalog is activated (099 FR-051).
//   stale-catalog           → kept. `stale-draft` maps onto it rather than
//                             introducing a second staleness literal: the layer
//                             revision gate is gone for these commands, so the
//                             draft token *is* the staleness, and the `result`
//                             carries the authoritative record the retry needs.
//   persistence-failed      → kept, for `store-refused` and for `partial`. Neither
//                             completed and both are repaired the same way.
//   trust-denied            → kept unchanged; the gate itself is `trust-gate.ts`.
//   phase|pipeline|workflow-validation
//                           → one literal, `validation-failed`, carrying every
//                             defect of every kind (FR-019). Three literals for
//                             one condition was an artefact of three commands.
//   phase-removal-blocked   → `referenced`, which names every blocking definition
//                             and the field the reference sits in (FR-025).
//   *-mutation-mismatch, phase-identity-immutable, phase-version-invalid
//                           → retired with the layer-diff intent algebra (T506,
//                             FR-051). A per-definition operation declares its
//                             intent by being the command it is, so there is no
//                             observed diff to disagree with a declared one, no
//                             identity to repair inside a whole-array write, and
//                             no positional `version` echo to check. These are
//                             conditions that no longer exist, not codes dropped.
//
// Every other refusal reason is acked under its own name: `LifecycleRefusalReason`
// is already the closed union FR-015 asks for, and renaming its members here would
// put a translation table between the service and the surface for no gain.
//
// **Nothing here deletes anything, on any path.** A `partial` leaves what landed on
// disk, where the next read reports it as collectable (099 FR-026, FR-028, FR-029).

import type {
  DeactivateOutcome,
  DiscardDraftOutcome,
  LifecycleAdvisory,
  LifecycleRefusal,
  PackagePublishOutcome,
  PublishOutcome,
  ReferenceBlocker,
  RestoreOutcome,
  SaveDraftOutcome,
  ValidationDefect
} from '../../../contracts/catalog-lifecycle';
import type {
  CatalogLifecycleEventType,
  CatalogLifecyclePayload
} from '../../../contracts/audit-events';
import type { CatalogKind, CatalogVersionId } from '../../../contracts/catalog-store';
import type { HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';
import {
  auditImportCommitted,
  auditImportRefused,
  type ImportCommitTarget
} from './process-exchange-commit-audit';

/**
 * Every per-definition outcome, as one union.
 *
 * The five operations overlap by design: `refused` and `partial` are structurally
 * identical wherever they appear, and each success arm carries a literal no other
 * operation uses. That is what lets one switch cover all five and one `never` guard
 * protect all five.
 */
export type LifecycleOutcome =
  | SaveDraftOutcome
  | PublishOutcome
  | DeactivateOutcome
  | RestoreOutcome
  | DiscardDraftOutcome;

/** Which definition an outcome is about, for the log line and the refusal detail. */
export interface LifecycleTarget {
  readonly kind: CatalogKind;
  readonly id: string;
}

const MAX_ID_LEN = 64;
const MAX_MESSAGE_LEN = 512;
/** Enough to fix a document in one pass without turning an ack into a transcript. */
const MAX_REPORTED = 20;

type Sanitize = (value: string) => string;

function boundedId(sanitize: Sanitize, id: string): string {
  return sanitize(id).slice(0, MAX_ID_LEN);
}

/**
 * Re-resolve the host's catalogs when this operation moved the store.
 *
 * Skipped for `unchanged` — byte-identical to the last read — and for every
 * refusal except a stale one, where another window provably moved the store and
 * the refresh is the same repair the operator is about to be told to perform.
 *
 * Never converts a successful write into a rejection: the write landed, and a host
 * that cannot re-read is a stale projection, not a failed write.
 */
async function refreshIfMoved(ctx: HandlerContext, outcome: LifecycleOutcome): Promise<void> {
  if (outcome.outcome === 'unchanged') return;
  if (outcome.outcome === 'refused' && outcome.refusal.reason !== 'stale-draft') return;
  await refreshCatalog(ctx);
}

async function refreshCatalog(ctx: HandlerContext): Promise<void> {
  if (!ctx.deps.refreshCatalog) return;
  try {
    await ctx.deps.refreshCatalog();
  } catch (error) {
    ctx.deps.logger.warn(
      `catalog refresh after lifecycle write failed: ` +
        `${ctx.deps.logger.sanitize((error as Error).message)}`
    );
  }
}

/**
 * Report what retention removed (099 FR-035) through the runtime log sink and
 * nothing else — no audit event type and no webview message family is added for it
 * (099 FR-059, FR-060).
 */
function logPruned(
  ctx: HandlerContext,
  target: LifecycleTarget,
  pruned: readonly CatalogVersionId[]
): void {
  if (pruned.length === 0) return;
  ctx.deps.logger.debug(
    `catalog retention pruned ${pruned.length} version(s) of ` +
      `${target.kind} ${boundedId(ctx.deps.logger.sanitize, target.id)}: ${pruned.join(', ')}`
  );
}

/**
 * Feature 100 (T513, FR-052, FR-053) — record a pointer move.
 *
 * Emitted from the three success arms below and from nowhere else, which is what
 * keeps FR-054's negative true by construction: `saved`, `unchanged`, and
 * `discarded` have no call here, so a draft's existence is never audited. It also
 * keeps the record honest in the other direction — the event is written after the
 * store returned a success arm, so an audited publication is a publication that
 * happened.
 *
 * Best-effort, on `trust-gate.ts`'s and `process-exchange-commit-audit.ts`'s terms:
 * a record that could not be written must not turn a completed write into a
 * failure. `runId` is a literal rather than a run: these events belong to no run,
 * which is also why they are system-scoped.
 */
async function auditLifecycle(
  ctx: HandlerContext,
  eventType: CatalogLifecycleEventType,
  target: LifecycleTarget,
  versionId: CatalogVersionId
): Promise<void> {
  if (!ctx.deps.audit) return;
  const payload: CatalogLifecyclePayload = {
    resourceKind: target.kind,
    // `logger.sanitize` stays the single redaction source (standing hard rule),
    // and the bound is this module's own id bound rather than a second limit
    // declared for the audit.
    resourceId: boundedId(ctx.deps.logger.sanitize, target.id),
    versionId
  };
  try {
    await ctx.deps.audit.append({
      runId: 'catalog-lifecycle',
      phase: 'catalog-lifecycle',
      iteration: 0,
      eventType,
      payload: { ...payload },
      outcome: 'info',
      correlationId: ctx.correlationId
    });
  } catch (error) {
    ctx.deps.logger.warn(
      `catalog lifecycle audit append failed for ${eventType}: ` +
        `${ctx.deps.logger.sanitize((error as Error).message ?? 'unknown error')}`
    );
  }
}

interface BoundedDefects {
  readonly defects: readonly unknown[];
  readonly total: number;
}

interface BoundedBlockers {
  readonly blockers: readonly unknown[];
  readonly total: number;
}

function boundedDefects(sanitize: Sanitize, defects: readonly ValidationDefect[]): BoundedDefects {
  return {
    defects: defects.slice(0, MAX_REPORTED).map((defect) => ({
      kind: defect.kind,
      id: boundedId(sanitize, defect.id),
      field: sanitize(defect.field).slice(0, MAX_ID_LEN),
      code: sanitize(defect.code).slice(0, MAX_ID_LEN),
      message: sanitize(defect.message).slice(0, MAX_MESSAGE_LEN)
    })),
    total: defects.length
  };
}

function boundedBlockers(
  sanitize: Sanitize,
  blockers: readonly ReferenceBlocker[]
): BoundedBlockers {
  return {
    blockers: blockers.slice(0, MAX_REPORTED).map((blocker) => ({
      kind: blocker.kind,
      id: boundedId(sanitize, blocker.id),
      field: sanitize(blocker.field).slice(0, MAX_ID_LEN)
    })),
    total: blockers.length
  };
}

function boundedAdvisories(
  sanitize: Sanitize,
  advisories: readonly LifecycleAdvisory[]
): readonly unknown[] {
  return advisories.slice(0, MAX_REPORTED).map((advisory) => ({
    advisory: advisory.advisory,
    kind: advisory.kind,
    id: boundedId(sanitize, advisory.id)
  }));
}

/**
 * The refusal, as the surface reads it.
 *
 * `current` is the whole point of a refusal being a value rather than a throw: the
 * operator's next attempt uses the token named here instead of re-reading and
 * guessing (FR-012, FR-015). It holds two version ids and no body, so nothing an
 * operator authored — and no workspace path — can reach the ack through it.
 */
function refusalResult(sanitize: Sanitize, refusal: LifecycleRefusal): unknown {
  return {
    current: {
      kind: refusal.current.kind,
      id: boundedId(sanitize, refusal.current.id),
      state: refusal.current.state,
      draftVersionId: refusal.current.draftVersionId,
      activeVersionId: refusal.current.activeVersionId,
      expectedDraftVersion: refusal.current.expectedDraftVersion
    },
    legalActions: refusal.legalActions,
    ...(refusal.defects === undefined ? {} : boundedDefects(sanitize, refusal.defects)),
    ...(refusal.blockers === undefined ? {} : boundedBlockers(sanitize, refusal.blockers)),
    ...(refusal.advisories === undefined
      ? {}
      : { advisories: boundedAdvisories(sanitize, refusal.advisories) }),
    ...(refusal.storeReason === undefined ? {} : { storeReason: refusal.storeReason })
  };
}

async function ackRefusal(ctx: HandlerContext, refusal: LifecycleRefusal): Promise<void> {
  const reason = refusal.reason === 'stale-draft' ? 'stale-catalog' : refusal.reason;
  await ack(ctx, 'rejected', reason, refusalResult(ctx.deps.logger.sanitize, refusal));
}

export async function commitLifecycleOutcome(
  ctx: HandlerContext,
  target: LifecycleTarget,
  outcome: LifecycleOutcome
): Promise<void> {
  await refreshIfMoved(ctx, outcome);
  const sanitize = ctx.deps.logger.sanitize;

  switch (outcome.outcome) {
    case 'saved':
    case 'unchanged': {
      // An unchanged save is a successful save with no new version. FR-011a's whole
      // point is that it is not an error and manufactures no history.
      await ack(ctx, 'accepted', undefined, {
        draftVersionId: outcome.draftVersionId,
        appended: outcome.outcome === 'saved'
      });
      return;
    }
    case 'published': {
      logPruned(ctx, target, outcome.pruned);
      // The version that became active. What retention removed is reported through
      // the log sink only (099 FR-059) — `pruned` gets no audit field, and the
      // payload has nowhere to put one.
      await auditLifecycle(ctx, 'definition-published', target, outcome.activeVersionId);
      await ack(ctx, 'accepted', undefined, {
        activeVersionId: outcome.activeVersionId,
        publishedAt: outcome.publishedAt,
        pruned: outcome.pruned
      });
      return;
    }
    case 'deactivated': {
      // The version that stopped being live, which deactivation retains as the
      // definition's draft rather than writing a new record (FR-024a). The
      // advisories are NOT audited: they name other definitions, and an event
      // about this one has no field for them.
      await auditLifecycle(ctx, 'definition-deactivated', target, outcome.draftVersionId);
      // The advisories ride on a *successful* outcome. Nothing on this path turns
      // one into a blocker (FR-025a, FR-061).
      await ack(ctx, 'accepted', undefined, {
        state: outcome.state,
        draftVersionId: outcome.draftVersionId,
        advisories: boundedAdvisories(sanitize, outcome.advisories)
      });
      return;
    }
    case 'restored': {
      // The version restored FROM, not the draft it produced: the source is the
      // operator's selection and the only thing that tells two restores apart.
      await auditLifecycle(ctx, 'definition-restored', target, outcome.fromVersionId);
      await ack(ctx, 'accepted', undefined, {
        draftVersionId: outcome.draftVersionId,
        fromVersionId: outcome.fromVersionId,
        replacedDraftVersionId: outcome.replacedDraftVersionId
      });
      return;
    }
    case 'discarded': {
      await ack(ctx, 'accepted', undefined, { entryRemoved: outcome.entryRemoved });
      return;
    }
    case 'refused': {
      if (outcome.refusal.reason === 'store-refused') {
        ctx.deps.logger.warn(
          `${target.kind} lifecycle write refused: ${outcome.refusal.storeReason ?? 'unknown'}`
        );
      }
      await ackRefusal(ctx, outcome.refusal);
      return;
    }
    case 'partial': {
      // The count, not the labels: `<id>@<versionId>` pairs are the store's own
      // words, and the operator's repair does not depend on which prefix landed.
      ctx.deps.logger.warn(
        `${target.kind} lifecycle write landed a prefix and stopped (${outcome.errno}); ` +
          `${outcome.wrote.length} record(s) remain and are collectable`
      );
      await ack(ctx, 'rejected', 'persistence-failed', {
        partial: true,
        wrote: outcome.wrote.length
      });
      return;
    }
  }

  // Every arm above returns, so `outcome` is `never` here and this assignment
  // compiles only while the switch covers the union. That is the point of it,
  // carried over verbatim from `catalog-layer-commit.ts`: a ninth arm would
  // otherwise fall past the switch and return with no ack at all, and a command
  // that never acks is a Builder that waits forever rather than a Builder that
  // reports a failure. Thrown rather than acked because the router already
  // translates a handler throw into a sanitised rejection ack; a second ack path
  // would be one more thing to keep in step.
  const unhandled: never = outcome;
  throw new Error(`unhandled catalog lifecycle outcome: ${String(unhandled)}`);
}

/**
 * One exchange record per layer the operator confirmed, in dependency order.
 *
 * 085's FR-061 needs six states told apart after the fact, and the state this path
 * reaches that no other does is "some kinds landed and some did not": the catalog
 * cannot describe it, because a workspace holding Phases and no Pipeline is
 * indistinguishable from one where the operator imported the Phases alone. So every
 * confirmed layer says what became of it — `imported`, or the reason it is not live
 * — while a kind the request never carried says nothing at all, which is how a
 * blocked root stays distinguishable from a failed write.
 *
 * A layer left as a draft is recorded under the same reason as the layer that
 * failed: nothing of it became triggerable, so as an *import* it did not land. The
 * ack is where the two are told apart (`draftedOnly` against `failedKind`). No
 * `drafted` outcome literal is added for it — the vocabulary is 085's, and a draft
 * is not an import.
 */
async function auditPackageLayers(
  ctx: HandlerContext,
  exchange: readonly ImportCommitTarget[],
  landed: readonly CatalogKind[],
  reason: string
): Promise<void> {
  for (const target of exchange) {
    if (landed.some((kind) => kind === target.resourceKind)) {
      await auditImportCommitted(ctx, target);
    } else {
      await auditImportRefused(ctx, target, reason);
    }
  }
}

/**
 * The package publish, which needs its own mapping and its own guard.
 *
 * Its three arms are not the per-definition ones: `published` names layers rather
 * than one version, `partial` names what landed and what did not across kinds, and
 * its refusal is a `PackageRefusal` — a shape with no `current` record and no legal
 * actions, because a nine-definition document has no single definition to report
 * and naming an arbitrary one would be worse than naming none.
 *
 * `exchange` is one target per confirmed layer, already in rank order — a list
 * rather than 085's single target, because one publication now covers every kind
 * the document carried.
 */
export async function commitPackagePublish(
  ctx: HandlerContext,
  exchange: readonly ImportCommitTarget[],
  outcome: PackagePublishOutcome
): Promise<void> {
  const sanitize = ctx.deps.logger.sanitize;

  switch (outcome.outcome) {
    case 'published': {
      await refreshCatalog(ctx);
      for (const pruned of outcome.pruned) {
        logPruned(ctx, { kind: pruned.kind, id: pruned.id }, pruned.versionIds);
      }
      // `process-exchange-import-committed` is this path's record and the only
      // one: it already names the ids per layer, and adding a
      // `definition-published` per definition would be a second copy of the same
      // write (085's rule, verbatim). The outcome carries layers rather than
      // version ids, so there is nothing to put in the third field either.
      //
      // Every non-empty layer publishes on this arm, so the reason is unreachable
      // here; it is passed rather than special-cased so the one place that decides
      // "landed or not" stays one place.
      await auditPackageLayers(
        ctx,
        exchange,
        outcome.published.map((layer) => layer.kind),
        'package-partial'
      );
      await ack(ctx, 'accepted', undefined, {
        published: outcome.published.map((layer) => ({
          kind: layer.kind,
          ids: layer.ids.slice(0, MAX_REPORTED).map((id) => boundedId(sanitize, id)),
          total: layer.ids.length
        }))
      });
      return;
    }
    case 'partial': {
      // Whichever prefix landed stays written and is reported (FR-037, FR-038).
      // Recovery is a re-run of the same document, which plans the written rows as
      // skips (FR-039) — not a compensating delete, which this path never performs.
      await refreshCatalog(ctx);
      // The layers that landed before the failure still trimmed history, and a
      // re-run prunes nothing (FR-039) — so this is the only report of those
      // removals there will be.
      for (const pruned of outcome.pruned) {
        logPruned(ctx, { kind: pruned.kind, id: pruned.id }, pruned.versionIds);
      }
      ctx.deps.logger.warn(
        `package publish stopped at the ${outcome.failedKind} layer (${outcome.cause}); ` +
          `${outcome.published.length} layer(s) published and ` +
          `${outcome.draftedOnly.length} left as drafts`
      );
      await auditPackageLayers(
        ctx,
        exchange,
        outcome.published.map((layer) => layer.kind),
        'package-partial'
      );
      await ack(ctx, 'rejected', 'package-partial', {
        published: outcome.published.map((layer) => ({ kind: layer.kind, total: layer.ids.length })),
        draftedOnly: outcome.draftedOnly,
        failedKind: outcome.failedKind,
        cause: sanitize(outcome.cause).slice(0, MAX_ID_LEN)
      });
      return;
    }
    case 'refused': {
      const { refusal } = outcome;
      // Nothing was written, so nothing moved and there is nothing to re-read.
      const reason =
        refusal.reason === 'stale-layer'
          ? 'stale-catalog'
          : refusal.reason === 'store-refused'
            ? 'persistence-failed'
            : refusal.reason;
      // Nothing landed, so every confirmed layer records the refusal under its own
      // kind. A refusal about the whole document (`validation-failed`) has no one
      // kind to name, and naming an arbitrary one would be worse than naming all.
      await auditPackageLayers(ctx, exchange, [], reason);
      await ack(ctx, 'rejected', reason, {
        kind: refusal.kind,
        ...(refusal.defects.length === 0 ? {} : boundedDefects(sanitize, refusal.defects)),
        ...(refusal.storeReason === undefined ? {} : { storeReason: refusal.storeReason })
      });
      return;
    }
  }

  const unhandled: never = outcome;
  throw new Error(`unhandled package publish outcome: ${String(unhandled)}`);
}
