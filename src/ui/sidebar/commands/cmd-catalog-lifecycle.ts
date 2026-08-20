// Feature 100 (FR-R3-016) T508, T510 — the six lifecycle commands.
//
// One file for six handlers rather than six files, because each handler is the
// same four steps in the same order and only the middle two differ:
//
//   1. is there a lifecycle service at all      → `config-ops-unavailable`
//   2. is the caller's draft token still current → `stale-catalog`   (T510)
//   3. is the capability this operation needs allowed → `trust-denied`
//   4. dispatch, and hand the outcome to `catalog-lifecycle-commit.ts`
//
// Six files would be six copies of that order, and the order is the requirement.
//
// **Step 2 before step 3 is FR-014 / US6 AS3**, and it is the one piece of
// sequencing here that is not obvious. An operation that is *both* stale and
// untrusted reports the staleness, because the two answers ask different things
// of the operator: `trust-denied` says "this workspace may not do that", which is
// a standing condition the operator resolves once; `stale-catalog` says "someone
// moved this underneath you", which is about *this* attempt and carries the token
// the retry needs. Reporting the trust denial first would hide a concurrent edit
// behind a setting, and the operator would grant the capability, retry, and only
// then discover they were about to overwrite another window's work.
//
// The pre-check is an *ordering device*, not the authority. The service re-checks
// the token against the manifest it is about to write, which is the only check
// that can be right — this one races, and losing that race simply means the
// service refuses instead. What it cannot do is let a trust denial mask a
// staleness the caller could already have been told about.
//
// Workspace Trust itself is not in this order: it gates the whole authoring
// surface upstream (099 FR-051), where an untrusted workspace activates no
// catalog and `catalogLifecycle` is `null`. What is gated here is the
// content-keyed capability — `phases`, `retryConditions` — which is a different
// question from whether the workspace is trusted at all.

import { NO_DRAFT, draftTokenOf, legalActionsFor, definitionStateOf } from '../../../contracts/catalog-lifecycle';
import type {
  DefinitionRecord,
  DiscardDraftRequest,
  LifecycleRefusal,
  PackagePublishRequest,
  PublishRequest,
  RestoreRequest,
  SaveDraftRequest
} from '../../../contracts/catalog-lifecycle';
import { CATALOG_KINDS } from '../../../contracts/catalog-store';
import type { CatalogKind, StoredDefinition } from '../../../contracts/catalog-store';
import type { CatalogLifecycleOps } from '../../../catalog';
import type { TrustCapability } from '../../../contracts/sidebar-ipc';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
import type {
  DeactivateDefinitionCommand,
  DiscardDefinitionDraftCommand,
  PublishDefinitionCommand,
  PublishPackageCommand,
  RestoreDefinitionVersionCommand,
  SaveDefinitionDraftCommand
} from '../../../contracts/sidebar-ipc';
import {
  commitLifecycleOutcome,
  commitPackagePublish,
  type LifecycleOutcome,
  type LifecycleTarget
} from './catalog-lifecycle-commit';
import type { HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';
import type { ImportCommitTarget } from './process-exchange-commit-audit';
import { denyAndAudit } from './trust-gate';

/** What every per-definition request carries, and all this module needs to gate one. */
interface DefinitionTarget {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly expectedDraftVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Presence, not truth (FR-046).
 *
 * A row that declares `retryCondition: null` is still a row that declares a retry
 * condition: the operator is editing the field, and an untrusted workspace must
 * not be able to clear one it is not allowed to set.
 *
 * Exported for the sake of `tests/lint/retry-condition-stays-inert.test.ts`
 * (T511a) and for no other caller. The alternative was a regex over this file's
 * text, and a requirement that says "the gate keys on the field's presence, never
 * its contents" deserves to be asserted against the predicate rather than against
 * its source code — the interesting cases are values the parser rejects, and only
 * the real predicate can be shown to accept them.
 */
export function declaresRetryCondition(body: unknown): boolean {
  return isRecord(body) && 'retryCondition' in body;
}

/** The single capability that gates authoring a Phase, or none for the other kinds. */
function kindCapabilities(kind: CatalogKind): readonly TrustCapability[] {
  return kind === 'phase' ? ['phases'] : [];
}

function recordOf(definition: StoredDefinition): DefinitionRecord {
  return {
    kind: definition.kind,
    id: definition.id,
    state: definitionStateOf(definition.draftVersionId, definition.activeVersionId),
    draftVersionId: definition.draftVersionId,
    activeVersionId: definition.activeVersionId,
    expectedDraftVersion: draftTokenOf(definition.draftVersionId)
  };
}

function absentRecord(kind: CatalogKind, id: string): DefinitionRecord {
  return {
    kind,
    id,
    state: null,
    draftVersionId: null,
    activeVersionId: null,
    expectedDraftVersion: NO_DRAFT
  };
}

function staleRefusal(current: DefinitionRecord): LifecycleRefusal {
  return {
    reason: 'stale-draft',
    current,
    legalActions: legalActionsFor(current.state)
  };
}

/**
 * The definition as the store holds it right now, or `null` when there is nothing
 * to compare against.
 *
 * `null` means "do not pre-check": either the store could not be read at all — in
 * which case the refusal the operator wants is the store's own, not a staleness
 * invented here — or there is no lifecycle wiring to read it from.
 */
async function currentRecord(
  ctx: HandlerContext,
  target: DefinitionTarget
): Promise<DefinitionRecord | null> {
  const store = ctx.deps.catalogStore;
  if (!store) return null;
  const result = await store.read();
  if (result.outcome !== 'read') return null;
  const found = result.snapshot.definitions.find(
    (definition) => definition.kind === target.kind && definition.id === target.id
  );
  return found ? recordOf(found) : absentRecord(target.kind, target.id);
}

/**
 * Steps 1-3, shared. Returns the service to dispatch to, or `null` when it already
 * acked a refusal and the caller must stop.
 */
async function gate(
  ctx: HandlerContext,
  target: DefinitionTarget,
  capabilities: readonly TrustCapability[]
): Promise<CatalogLifecycleOps | null> {
  const lifecycle = ctx.deps.catalogLifecycle;
  if (!lifecycle) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return null;
  }

  const current = await currentRecord(ctx, target);
  if (current !== null && current.expectedDraftVersion !== target.expectedDraftVersion) {
    await commitLifecycleOutcome(ctx, target, {
      outcome: 'refused',
      refusal: staleRefusal(current)
    });
    return null;
  }

  for (const capability of capabilities) {
    if (!isCapabilityAllowed(capability)) {
      await denyAndAudit(ctx, capability);
      return null;
    }
  }

  return lifecycle;
}

async function runDefinitionOperation(
  ctx: HandlerContext,
  target: DefinitionTarget,
  capabilities: readonly TrustCapability[],
  run: (lifecycle: CatalogLifecycleOps) => Promise<LifecycleOutcome>
): Promise<void> {
  const lifecycle = await gate(ctx, target, capabilities);
  if (!lifecycle) return;
  const commitTarget: LifecycleTarget = { kind: target.kind, id: target.id };
  await commitLifecycleOutcome(ctx, commitTarget, await run(lifecycle));
}

/**
 * A draft write. Gated on `phases` for a Phase, and additionally on
 * `retryConditions` where the body being written declares one.
 *
 * Both capabilities are checked before the write rather than after, so a body that
 * carries a retry condition into an untrusted workspace never reaches the store —
 * a version record is immutable, and a refusal after the write would leave the
 * denied content in the history it was denied from entering.
 */
export const saveDefinitionDraft = async (
  ctx: HandlerContext,
  command: SaveDefinitionDraftCommand
): Promise<void> => {
  const request: SaveDraftRequest = command.payload;
  const capabilities = [
    ...kindCapabilities(request.kind),
    ...(declaresRetryCondition(request.body) ? (['retryConditions'] as const) : [])
  ];
  await runDefinitionOperation(ctx, request, capabilities, (lifecycle) =>
    lifecycle.saveDraft(request)
  );
};

/** The one operation that makes a definition triggerable (FR-013). */
export const publishDefinition = async (
  ctx: HandlerContext,
  command: PublishDefinitionCommand
): Promise<void> => {
  const request: PublishRequest = command.payload;
  await runDefinitionOperation(ctx, request, kindCapabilities(request.kind), (lifecycle) =>
    lifecycle.publish(request)
  );
};

/**
 * Taking a definition out of service. Ungated, following the precedent that
 * removal is not an authoring capability: a workspace that may not author Phases
 * is not thereby required to keep the ones it has in service.
 */
export const deactivateDefinition = async (
  ctx: HandlerContext,
  command: DeactivateDefinitionCommand
): Promise<void> => {
  const request = command.payload;
  await runDefinitionOperation(ctx, request, [], (lifecycle) => lifecycle.deactivate(request));
};

/**
 * Copying a past body forward into a new draft.
 *
 * Gated as an authoring operation, not a read: it writes a version record, and the
 * body it writes is one this workspace may no longer be allowed to author. It is
 * *not* gated on `retryConditions` — the body is the store's own, already written
 * under whatever gate applied then, and re-reading it here to re-derive a gate
 * would make a restore fail for content the store already holds.
 */
export const restoreDefinitionVersion = async (
  ctx: HandlerContext,
  command: RestoreDefinitionVersionCommand
): Promise<void> => {
  const request: RestoreRequest = command.payload;
  await runDefinitionOperation(ctx, request, kindCapabilities(request.kind), (lifecycle) =>
    lifecycle.restore(request)
  );
};

/** Throwing away the pending edit. Ungated for the same reason as deactivation. */
export const discardDefinitionDraft = async (
  ctx: HandlerContext,
  command: DiscardDefinitionDraftCommand
): Promise<void> => {
  const request: DiscardDraftRequest = command.payload;
  await runDefinitionOperation(ctx, request, [], (lifecycle) => lifecycle.discardDraft(request));
};

/**
 * The package publish, whose gate is the same questions asked of a document rather
 * than of one definition.
 *
 * Its staleness pre-check is per-layer against the revision each layer declares
 * (FR-036) — the one place feature 099's revision gate survives, because a package
 * addresses a whole kind at once and has no per-definition draft token to carry.
 */
export const publishDefinitionPackage = async (
  ctx: HandlerContext,
  command: PublishPackageCommand
): Promise<void> => {
  const request: PackagePublishRequest = command.payload;
  const lifecycle = ctx.deps.catalogLifecycle;
  if (!lifecycle) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const exchange = exchangeTargets(request);

  const stale = await staleLayer(ctx, request);
  if (stale) {
    await commitPackagePublish(ctx, exchange, {
      outcome: 'refused',
      refusal: { reason: 'stale-layer', kind: stale, defects: [] }
    });
    return;
  }

  for (const capability of packageCapabilities(request)) {
    if (!isCapabilityAllowed(capability.capability)) {
      await denyAndAudit(ctx, capability.capability, capability.rowIndex);
      return;
    }
  }

  await commitPackagePublish(ctx, exchange, await lifecycle.publishPackage(request));
};

/**
 * What the exchange log records about this publication (085 FR-059): one target per
 * layer the operator confirmed, in the rank order the store writes them, so the log
 * reads in dependency order whatever order the request arrived in (FR-035).
 *
 * A publication of this command IS an import commit — the Builder's own writes are
 * per-definition — which is what the `import-package` mutation intent used to say
 * and why nothing has to carry it any more (T513b).
 *
 * An empty layer is not a write and gets no record, matching the store, which drops
 * it before the first pass. Only the ids travel; the bodies stop here (FR-060).
 */
function exchangeTargets(request: PackagePublishRequest): readonly ImportCommitTarget[] {
  return request.layers
    .filter((layer) => layer.definitions.length > 0)
    .sort((left, right) => CATALOG_KINDS.indexOf(left.kind) - CATALOG_KINDS.indexOf(right.kind))
    .map((layer) => ({
      resourceKind: layer.kind,
      resourceIds: layer.definitions.map((definition) => definition.id)
    }));
}

/**
 * The first layer whose declared revision no longer matches, or `null`.
 *
 * Empty layers are skipped, because the operation skips them: `publishPackage`
 * drops a layer with no definitions before either pass, so a stale revision on one
 * gates nothing. Checking it here would refuse a publication over a kind the
 * document said nothing about — a pre-check stricter than the authority it stands
 * in for, which is the one way an ordering device can be wrong on its own.
 */
async function staleLayer(
  ctx: HandlerContext,
  request: PackagePublishRequest
): Promise<CatalogKind | null> {
  const store = ctx.deps.catalogStore;
  if (!store) return null;
  const result = await store.read();
  if (result.outcome !== 'read') return null;
  const layer = request.layers.find(
    (candidate) =>
      candidate.definitions.length > 0 &&
      result.snapshot.revisions[candidate.kind] !== candidate.expectedRevision
  );
  return layer ? layer.kind : null;
}

/** A capability to check, with the row that asked for it where there is one. */
interface PackageCapabilityCheck {
  readonly capability: TrustCapability;
  readonly rowIndex?: number;
}

/**
 * `phases` once for the whole Phase layer, and `retryConditions` for the first row
 * that declares one — carrying that row's index, so the denial names the line of
 * the document the operator has to look at rather than the document (T511a).
 */
function packageCapabilities(
  request: PackagePublishRequest
): readonly PackageCapabilityCheck[] {
  const phaseLayer = request.layers.find((layer) => layer.kind === 'phase');
  if (!phaseLayer) return [];
  const checks: PackageCapabilityCheck[] = [{ capability: 'phases' }];
  const rowIndex = phaseLayer.definitions.findIndex((definition) =>
    declaresRetryCondition(definition.body)
  );
  if (rowIndex >= 0) checks.push({ capability: 'retryConditions', rowIndex });
  return checks;
}
